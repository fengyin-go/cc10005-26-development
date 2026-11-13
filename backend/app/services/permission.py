"""站点采集许可中心：受控权限、路径树裁决、限时例外与作业级证据。

设计要点（对应业务约束）：
- 角色受控：观察者只读、只能看共享许可；例外审批是独立权限（approve_exception）。
- 路径树分允许区 / 排除区 / 例外授权；排除压过允许，例外由独立权限批准且限时。
- 裁决前对地址做归一化：域名别名映射回归属域名、百分号编码解码、跳转后的地址重新匹配，
  绝不依赖起始地址的一次检查；每一步都落到 trace 里作为匹配轨迹。
- 许可保存走版本号乐观锁：过期版本保存先报冲突，不能覆盖另一人的授权。
- 许可撤回后，运行作业在下一次发请求前暂停，并记录撤回版本与被拒路径；
  已完成请求保留原裁决依据不变。
- 到期例外自动退出授权集合，作业未结束也不继续有效。

当前实现为进程内存储（与项目骨架一致），真实项目里换成数据库事务即可，
对外的服务方法签名与返回结构不需要变。
"""
from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import unquote, urlsplit

# ---------------------------------------------------------------------------
# 角色与权限点
# ---------------------------------------------------------------------------
ROLES: dict[str, dict[str, Any]] = {
    "admin": {
        "label": "许可管理员",
        "permissions": [
            "permission:view", "permission:edit", "permission:withdraw",
            "permission:apply", "permission:approve_exception",
            "permission:run_job", "permission:view_evidence",
        ],
    },
    "engineer": {
        "label": "采集工程师",
        "permissions": ["permission:view", "permission:apply", "permission:run_job", "permission:view_evidence"],
    },
    "approver": {
        "label": "例外审批人",
        "permissions": ["permission:view", "permission:approve_exception", "permission:view_evidence"],
    },
    "observer": {
        "label": "观察者",
        "permissions": ["permission:view"],
    },
}

# 路径树节点的三类分区
ZONE_ALLOW = "allow"
ZONE_DENY = "deny"
ZONE_EXCEPTION = "exception"
ZONE_LABELS = {ZONE_ALLOW: "允许区", ZONE_DENY: "排除区", ZONE_EXCEPTION: "例外授权"}

# 例外 / 作业 / 申请的状态
EXC_PENDING = "待审批"
EXC_ACTIVE = "生效中"
EXC_REJECTED = "已驳回"
EXC_EXPIRED = "已到期"
EXC_REVOKED = "已撤销"

APP_PENDING = "待执行"
APP_RUNNING = "运行中"
APP_PAUSED = "已暂停"
APP_DONE = "已完成"
APP_TERMINATED = "已终止"


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(moment: datetime | None) -> str | None:
    return moment.isoformat() if moment else None


def parse_dt(value: str | None) -> datetime | None:
    """兼容前端传入的 ISO 字符串与无后缀时间。"""
    if not value:
        return None
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


# ---------------------------------------------------------------------------
# 地址归一化：别名、百分号编码都在这里收敛
# ---------------------------------------------------------------------------
def normalize_host(host: str | None) -> str:
    host = (host or "").strip().lower()
    # 去掉用户信息片段与端口，许可归属只看注册域名
    if "@" in host:
        host = host.split("@", 1)[1]
    if host.startswith("www."):
        host = host[4:]
    return host


def split_url(raw: str) -> dict[str, str]:
    """把地址拆成 host / 原始路径 / 解码路径；非法地址给出明确错误标记。"""
    candidate = (raw or "").strip()
    if "://" not in candidate:
        candidate = "http://" + candidate
    parts = urlsplit(candidate)
    host = normalize_host(parts.hostname)
    raw_path = parts.path or "/"
    if not raw_path.startswith("/"):
        raw_path = "/" + raw_path
    decoded = unquote(raw_path)
    # 反复解码以暴露多层编码，最终用最内层结果参与匹配
    guard = 0
    while "%" in decoded and guard < 4:
        deeper = unquote(decoded)
        if deeper == decoded:
            break
        decoded = deeper
        guard += 1
    query = ("?" + parts.query) if parts.query else ""
    return {
        "host": host,
        "raw_path": raw_path,
        "decoded_path": decoded,
        "path_and_query": decoded + query,
        "is_valid": bool(host and "." in host),
    }


def path_prefix_match(prefix: str, path: str) -> bool:
    """前缀匹配必须落在路径边界上，避免 /news 误放 /newsletter。"""
    if not prefix:
        return True
    if path == prefix:
        return True
    if path.startswith(prefix):
        return prefix.endswith("/") or path[len(prefix)] == "/"
    return False


class PermissionError(Exception):
    """服务层业务错误，路由层统一转成 HTTP 状态码。"""

    def __init__(self, status_code: int, message: str, extra: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.message = message
        self.extra = extra or {}


class PermissionService:
    """许可中心全部状态与规则的单例服务。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.current_user = "admin"
        self.domains: dict[int, dict[str, Any]] = {}
        self.exceptions: dict[int, dict[str, Any]] = {}
        self.applications: dict[int, dict[str, Any]] = {}
        self.jobs: dict[int, dict[str, Any]] = {}
        self.audit_logs: list[dict[str, Any]] = []
        self._seq = 0
        self._seed_demo_data()

    # ------------------------------------------------------------------ utils
    def _next_id(self) -> int:
        self._seq += 1
        return self._seq

    def _log(self, action: str, detail: str) -> None:
        self.audit_logs.insert(0, {
            "id": self._next_id(),
            "time": _iso(_now()),
            "actor": self.current_user,
            "actor_label": ROLES[self.current_user]["label"],
            "action": action,
            "detail": detail,
        })
        self.audit_logs[:] = self.audit_logs[:100]

    def _permissions(self) -> list[str]:
        return ROLES[self.current_user]["permissions"]

    def _require(self, permission: str) -> None:
        if permission not in self._permissions():
            raise PermissionError(403, f"当前角色「{ROLES[self.current_user]['label']}」没有 {permission} 权限，操作已拦截")

    def _domain_or_404(self, domain_id: int) -> dict[str, Any]:
        domain = self.domains.get(domain_id)
        if domain is None:
            raise PermissionError(404, f"域名许可 {domain_id} 不存在或已归档")
        return domain

    def _host_owner(self, host: str) -> dict[str, Any] | None:
        for domain in self.domains.values():
            if domain["status"] == "已撤回":
                continue
            if host == domain["host"] or host in domain.get("aliases", []):
                return domain
        return None

    # ------------------------------------------------------------------ 演示数据
    def _seed_demo_data(self) -> None:
        news = self._build_domain(
            code="PERM-NEWS", name="示例新闻门户", owner="内容合作组",
            host="news.example.com",
            aliases=["m.news.example.com", "news-example.cn"],
            tree={
                "id": "root", "name": "news.example.com", "path": "/", "zone": ZONE_ALLOW, "children": [
                    {"id": "n1", "name": "article", "path": "/article", "zone": ZONE_ALLOW, "children": [
                        {"id": "n11", "name": "internal", "path": "/article/internal", "zone": ZONE_DENY, "children": []},
                    ]},
                    {"id": "n2", "name": "search", "path": "/search", "zone": ZONE_DENY, "children": []},
                ],
            },
        )
        shop = self._build_domain(
            code="PERM-SHOP", name="示例电商站点", owner="零售业务线",
            host="shop.example.org",
            aliases=["www.shop.example.org"],
            tree={
                "id": "root", "name": "shop.example.org", "path": "/", "zone": ZONE_ALLOW, "children": [
                    {"id": "s1", "name": "items", "path": "/items", "zone": ZONE_ALLOW, "children": []},
                    {"id": "s2", "name": "checkout", "path": "/checkout", "zone": ZONE_DENY, "children": []},
                ],
            },
        )
        # 一条生效中的限时例外：排除区里的单次合作专题
        self._create_exception_record(
            domain_id=shop["id"], path="/checkout/promo", reason="双十一大促专题临时授权",
            expires_at=_now() + timedelta(days=2), created_by="engineer",
            approved_by="approver", status=EXC_ACTIVE,
        )
        # 一条待审批例外，用来演示独立审批权限
        self._create_exception_record(
            domain_id=news["id"], path="/search/partner", reason="合作方榜单检索临时授权",
            expires_at=_now() + timedelta(days=1), created_by="engineer",
            approved_by=None, status=EXC_PENDING,
        )
        # 一条已到期例外：证明到期后自动退出授权集合
        self._create_exception_record(
            domain_id=news["id"], path="/article/internal/old", reason="历史专题（已过期）",
            expires_at=_now() - timedelta(hours=3), created_by="engineer",
            approved_by="approver", status=EXC_ACTIVE,
        )
        # 一条已撤回的许可，便于演示撤回版本留存
        withdrawn = self._build_domain(
            code="PERM-OLD", name="已下线旧站", owner="归档组",
            host="old.example.net", aliases=[],
            tree={"id": "root", "name": "old.example.net", "path": "/", "zone": ZONE_ALLOW, "children": []},
        )
        withdrawn["status"] = "已撤回"
        withdrawn["withdrawn_at"] = _iso(_now() - timedelta(days=5))
        withdrawn["withdrawn_by"] = "admin"
        withdrawn["withdraw_reason"] = "合作终止，许可整体撤回"
        withdrawn["withdraw_version"] = withdrawn["version"]
        # 示例作业：一个在跑、一个已暂停（撤回导致）
        running = self._build_job(
            domain_id=news["id"], start_url="https://news.example.com/article/1001",
            applicant="engineer", status=APP_RUNNING,
        )
        self._append_request(running["id"], "https://news.example.com/article/1001",
                             verdict="允许", basis="允许区命中 /article", decided_version=news["version"],
                             trace=self.evaluate_url("https://news.example.com/article/1001")["trace"])
        paused = self._build_job(
            domain_id=withdrawn["id"], start_url="https://old.example.net/list",
            applicant="engineer", status=APP_PAUSED,
        )
        paused["pause_reason"] = "许可已撤回"
        paused["withdraw_version"] = withdrawn["withdraw_version"]
        paused["rejected_path"] = "/list"

    def _build_domain(self, *, code: str, name: str, owner: str, host: str,
                      aliases: list[str], tree: dict[str, Any]) -> dict[str, Any]:
        domain = {
            "id": self._next_id(),
            "code": code,
            "name": name,
            "owner": owner,
            "host": host,
            "aliases": aliases,
            "tree": tree,
            "version": 1,
            "updated_by": "admin",
            "updated_at": _iso(_now()),
            "status": "生效中",
            "withdrawn_at": None,
            "withdrawn_by": None,
            "withdraw_reason": None,
            "withdraw_version": None,
        }
        self.domains[domain["id"]] = domain
        return domain

    def _create_exception_record(self, *, domain_id: int, path: str, reason: str,
                                 expires_at: datetime, created_by: str,
                                 approved_by: str | None, status: str) -> dict[str, Any]:
        record = {
            "id": self._next_id(),
            "domain_id": domain_id,
            "path": path,
            "reason": reason,
            "status": status,
            "created_by": created_by,
            "created_at": _iso(_now()),
            "approved_by": approved_by,
            "approved_at": _iso(_now()) if approved_by else None,
            "expires_at": _iso(expires_at),
        }
        self.exceptions[record["id"]] = record
        return record

    def _build_job(self, *, domain_id: int, start_url: str, applicant: str, status: str) -> dict[str, Any]:
        job = {
            "id": self._next_id(),
            "code": f"JOB-{self._seq:04d}",
            "domain_id": domain_id,
            "start_url": start_url,
            "applicant": applicant,
            "status": status,
            "created_at": _iso(_now()),
            "pause_reason": None,
            "withdraw_version": None,
            "rejected_path": None,
            "requests": [],
        }
        self.jobs[job["id"]] = job
        return job

    # ------------------------------------------------------------------ 会话 / 审计
    def session(self) -> dict[str, Any]:
        role = ROLES[self.current_user]
        return {
            "user": self.current_user,
            "role": self.current_user,
            "role_label": role["label"],
            "permissions": role["permissions"],
            "roles": [{"key": key, "label": value["label"]} for key, value in ROLES.items()],
        }

    def switch_user(self, role: str) -> dict[str, Any]:
        if role not in ROLES:
            raise PermissionError(400, f"角色 {role} 不存在")
        self.current_user = role
        self._log("切换身份", f"当前操作身份切换为{ROLES[role]['label']}")
        return self.session()

    def list_audit_logs(self) -> list[dict[str, Any]]:
        self._require("permission:view")
        return list(self.audit_logs)

    # ------------------------------------------------------------------ 域名许可
    def list_domains(self, keyword: str | None = None) -> list[dict[str, Any]]:
        self._require("permission:view")
        items = list(self.domains.values())
        if keyword:
            items = [d for d in items
                     if keyword in d["name"] or keyword in d["host"] or keyword in d["code"]]
        return [self._domain_summary(d) for d in items]

    def _domain_summary(self, domain: dict[str, Any]) -> dict[str, Any]:
        active_exc = [e for e in self.exceptions.values()
                      if e["domain_id"] == domain["id"] and self._exc_live(e)]
        return {
            "id": domain["id"],
            "code": domain["code"],
            "name": domain["name"],
            "owner": domain["owner"],
            "host": domain["host"],
            "aliases": domain.get("aliases", []),
            "version": domain["version"],
            "status": domain["status"],
            "updated_by": domain["updated_by"],
            "updated_at": domain["updated_at"],
            "active_exception_count": len(active_exc),
        }

    def get_domain(self, domain_id: int) -> dict[str, Any]:
        self._require("permission:view")
        domain = self._domain_or_404(domain_id)
        result = dict(domain)
        result["exceptions"] = self.list_exceptions(domain_id)
        return result

    def create_domain(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._require("permission:edit")
        host = normalize_host(payload.get("host"))
        if not host or "." not in host:
            raise PermissionError(400, "归属域名不能为空且必须是合法域名")
        if any(d["host"] == host or host in d.get("aliases", []) for d in self.domains.values()):
            raise PermissionError(400, f"域名 {host} 已归属于其他许可，不能重复登记")
        code = (payload.get("code") or f"PERM-{self._seq + 1:04d}").strip()
        domain = self._build_domain(
            code=code,
            name=(payload.get("name") or host).strip(),
            owner=(payload.get("owner") or self.current_user).strip(),
            host=host,
            aliases=[normalize_host(a) for a in payload.get("aliases", []) if normalize_host(a)],
            tree={"id": "root", "name": host, "path": "/", "zone": ZONE_ALLOW, "children": []},
        )
        self._log("新建许可", f"登记域名 {host} 的采集许可（{domain['name']}）")
        return self.get_domain(domain["id"])

    def save_tree(self, domain_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        """路径树保存：版本号乐观锁，过期版本必须先解决冲突。"""
        self._require("permission:edit")
        with self._lock:
            domain = self._domain_or_404(domain_id)
            if domain["status"] == "已撤回":
                raise PermissionError(400, "许可已撤回，路径树只读；如需恢复请重新登记许可")
            base_version = int(payload.get("base_version") or 0)
            if base_version != domain["version"]:
                raise PermissionError(409, "路径树已被他人修改，当前保存基于过期版本，请先解决冲突", {
                    "conflict": True,
                    "base_version": base_version,
                    "latest_version": domain["version"],
                    "latest_updated_by": domain["updated_by"],
                    "latest_updated_at": domain["updated_at"],
                    "server_tree": domain["tree"],
                })
            tree = payload.get("tree")
            message = self._validate_tree(tree)
            if message:
                raise PermissionError(400, message)
            aliases = payload.get("aliases")
            if aliases is not None:
                cleaned = [normalize_host(a) for a in aliases if normalize_host(a)]
                for other in self.domains.values():
                    if other["id"] == domain_id:
                        continue
                    overlap = set(cleaned) & ({other["host"]} | set(other.get("aliases", [])))
                    if overlap:
                        raise PermissionError(400, f"别名 {sorted(overlap)} 已被其他许可占用")
                domain["aliases"] = cleaned
            domain["tree"] = tree
            domain["version"] += 1
            domain["updated_by"] = self.current_user
            domain["updated_at"] = _iso(_now())
            self._log("保存路径树", f"{domain['host']} 路径树升级到 v{domain['version']}")
            return self.get_domain(domain_id)

    def _validate_tree(self, node: Any) -> str | None:
        if not isinstance(node, dict):
            return "路径树节点结构不合法"
        if node.get("zone") not in ZONE_LABELS:
            return f"节点 {node.get('name')} 的分区必须是允许区/排除区/例外授权之一"
        path = str(node.get("path") or "")
        if not path.startswith("/"):
            return f"节点 {node.get('name')} 的路径必须以 / 开头"
        for child in node.get("children", []):
            message = self._validate_tree(child)
            if message:
                return message
        return None

    def withdraw_domain(self, domain_id: int, reason: str) -> dict[str, Any]:
        self._require("permission:withdraw")
        with self._lock:
            domain = self._domain_or_404(domain_id)
            if domain["status"] == "已撤回":
                raise PermissionError(400, "该许可已经处于撤回状态")
            domain["status"] = "已撤回"
            domain["withdrawn_at"] = _iso(_now())
            domain["withdrawn_by"] = self.current_user
            domain["withdraw_reason"] = reason or "未填写撤回原因"
            domain["withdraw_version"] = domain["version"]
            # 运行中的作业不立刻杀进程，标记为“下次发请求前暂停”
            for job in self.jobs.values():
                if job["domain_id"] == domain_id and job["status"] in (APP_RUNNING, APP_PENDING):
                    job["status"] = APP_PAUSED
                    job["pause_reason"] = "许可已撤回，下一次发请求前暂停"
                    job["withdraw_version"] = domain["withdraw_version"]
            self._log("撤回许可", f"{domain['host']} 许可 v{domain['version']} 撤回：{domain['withdraw_reason']}")
            return self._domain_summary(domain)

    # ------------------------------------------------------------------ 例外授权
    def _exc_live(self, record: dict[str, Any]) -> bool:
        """生效中且未到期；到期在读取瞬间自动退出授权集合。"""
        if record["status"] != EXC_ACTIVE:
            return False
        expires = parse_dt(record.get("expires_at"))
        if expires and expires <= _now():
            record["status"] = EXC_EXPIRED
            return False
        return True

    def list_exceptions(self, domain_id: int | None = None) -> list[dict[str, Any]]:
        self._require("permission:view")
        items = list(self.exceptions.values())
        if domain_id is not None:
            items = [e for e in items if e["domain_id"] == domain_id]
        for record in items:
            self._exc_live(record)
        return sorted(items, key=lambda e: e["id"], reverse=True)

    def request_exception(self, payload: dict[str, Any]) -> dict[str, Any]:
        """采集工程师发起限时例外申请；观察者等无申请权限角色会被拦截。"""
        self._require("permission:apply")
        domain = self._domain_or_404(int(payload.get("domain_id")))
        path = split_url(str(payload.get("path") or ""))["decoded_path"]
        if not path.startswith("/"):
            raise PermissionError(400, "例外路径必须以 / 开头")
        expires = parse_dt(payload.get("expires_at"))
        if expires is None or expires <= _now():
            raise PermissionError(400, "例外必须设置未来的到期时间，限时是硬约束")
        record = self._create_exception_record(
            domain_id=domain["id"], path=path, reason=str(payload.get("reason") or "未说明"),
            expires_at=expires, created_by=self.current_user,
            approved_by=None, status=EXC_PENDING,
        )
        self._log("申请例外", f"{domain['host']}{path} 申请限时例外至 {record['expires_at']}")
        return record

    def approve_exception(self, exception_id: int, decision: str) -> dict[str, Any]:
        # 独立权限：工程师自己不能批自己的例外
        self._require("permission:approve_exception")
        record = self.exceptions.get(exception_id)
        if record is None:
            raise PermissionError(404, f"例外申请 {exception_id} 不存在")
        if record["status"] != EXC_PENDING:
            raise PermissionError(400, f"例外当前状态为{record['status']}，不能再审批")
        if decision == "approve":
            record["status"] = EXC_ACTIVE
            record["approved_by"] = self.current_user
            record["approved_at"] = _iso(_now())
            self._log("批准例外", f"例外 {record['path']} 生效至 {record['expires_at']}")
        elif decision == "reject":
            record["status"] = EXC_REJECTED
            record["approved_by"] = self.current_user
            record["approved_at"] = _iso(_now())
            self._log("驳回例外", f"例外 {record['path']} 被驳回")
        else:
            raise PermissionError(400, "审批决定只能是 approve / reject")
        return record

    def revoke_exception(self, exception_id: int) -> dict[str, Any]:
        self._require("permission:approve_exception")
        record = self.exceptions.get(exception_id)
        if record is None:
            raise PermissionError(404, f"例外 {exception_id} 不存在")
        record["status"] = EXC_REVOKED
        self._log("撤销例外", f"例外 {record['path']} 被提前撤销")
        return record

    # ------------------------------------------------------------------ 裁决引擎
    def _walk_tree(self, node: dict[str, Any], path: str) -> list[dict[str, Any]]:
        """返回从根到最深命中节点的链路。"""
        chain = [{
            "node": node.get("name"),
            "path": node.get("path"),
            "zone": node.get("zone"),
            "zone_label": ZONE_LABELS[node["zone"]],
        }]
        deepest: list[dict[str, Any]] = []
        for child in node.get("children", []):
            if path_prefix_match(child["path"], path):
                deepest = self._walk_tree(child, path)
                break
        return chain + deepest

    def evaluate_url(self, raw_url: str, redirect_chain: list[str] | None = None) -> dict[str, Any]:
        """对一个地址做完整许可裁决，并返回可展示的匹配轨迹。

        跳转链里的每个地址都独立归一化、独立匹配，最终以最后一跳的裁决为准，
        起始地址一次检查通过不能代表跳转后的地址也被允许。
        """
        self._require("permission:view")
        chain_urls = [raw_url] + list(redirect_chain or [])
        steps: list[dict[str, Any]] = []
        verdict: dict[str, Any] | None = None
        for index, url in enumerate(chain_urls):
            parsed = split_url(url)
            step: dict[str, Any] = {
                "order": index,
                "url": url,
                "host": parsed["host"],
                "raw_path": parsed["raw_path"],
                "decoded_path": parsed["decoded_path"],
                "via_redirect": index > 0,
            }
            if not parsed["is_valid"]:
                step["verdict"] = "拒绝"
                step["reason"] = "地址格式不合法"
                steps.append(step)
                verdict = step
                break
            domain = self._host_owner(parsed["host"])
            if domain is None:
                step["verdict"] = "拒绝"
                step["reason"] = "域名不在任何已登记许可的归属或别名范围内"
                steps.append(step)
                verdict = step
                break
            step["domain"] = {"id": domain["id"], "host": domain["host"], "version": domain["version"]}
            if parsed["host"] != domain["host"]:
                step["alias_mapped_to"] = domain["host"]
            if domain["status"] == "已撤回":
                step["verdict"] = "拒绝"
                step["reason"] = f"许可已撤回（撤回版本 v{domain['withdraw_version']}）"
                steps.append(step)
                verdict = step
                break
            node_chain = self._walk_tree(domain["tree"], parsed["decoded_path"])
            step["tree_path"] = node_chain
            deepest = node_chain[-1]
            # 1. 排除区压过允许区；2. 例外可以在排除区内开口子，但必须已批准且未到期
            live_exceptions = [e for e in self.exceptions.values()
                               if e["domain_id"] == domain["id"] and self._exc_live(e)]
            hit_exception = next(
                (e for e in live_exceptions if path_prefix_match(e["path"], parsed["decoded_path"])),
                None,
            )
            if hit_exception:
                step["verdict"] = "允许"
                step["reason"] = "限时例外授权命中"
                step["exception"] = {
                    "id": hit_exception["id"], "path": hit_exception["path"],
                    "expires_at": hit_exception["expires_at"],
                    "approved_by": hit_exception["approved_by"],
                }
            elif deepest["zone"] == ZONE_DENY:
                step["verdict"] = "拒绝"
                step["reason"] = f"排除区命中 {deepest['path']}，排除优先于允许"
            elif deepest["zone"] == ZONE_ALLOW:
                step["verdict"] = "允许"
                step["reason"] = f"允许区命中 {deepest['path']}"
            else:
                # 落到仅标记为例外、但例外未生效的节点：按排除处理
                step["verdict"] = "拒绝"
                step["reason"] = f"例外节点 {deepest['path']} 无生效授权"
            step["decided_version"] = domain["version"]
            steps.append(step)
            verdict = step
        assert verdict is not None
        return {
            "url": raw_url,
            "redirect_count": max(len(chain_urls) - 1, 0),
            "verdict": verdict["verdict"],
            "reason": verdict["reason"],
            "domain_id": verdict.get("domain", {}).get("id"),
            "decided_version": verdict.get("decided_version"),
            "trace": steps,
        }

    # ------------------------------------------------------------------ 采集申请与作业
    def list_applications(self) -> list[dict[str, Any]]:
        self._require("permission:view")
        return sorted(self.applications.values(), key=lambda a: a["id"], reverse=True)

    def apply_collection(self, payload: dict[str, Any]) -> dict[str, Any]:
        """先看匹配轨迹，再申请：申请时强制留存当时的裁决快照。"""
        self._require("permission:apply")
        url = str(payload.get("start_url") or "").strip()
        evaluation = self.evaluate_url(url, payload.get("redirect_chain") or [])
        if evaluation["verdict"] != "允许":
            raise PermissionError(
                400,
                f"起始地址裁决为拒绝（{evaluation['reason']}），不能提交采集申请；"
                "如确有需要请先走限时例外审批",
                {"evaluation": evaluation},
            )
        application = {
            "id": self._next_id(),
            "domain_id": evaluation["domain_id"],
            "start_url": url,
            "redirect_chain": payload.get("redirect_chain") or [],
            "applicant": self.current_user,
            "status": "待派发",
            "created_at": _iso(_now()),
            "evaluation_snapshot": evaluation,
        }
        self.applications[application["id"]] = application
        self._log("提交采集申请", f"{url} 裁决允许，申请已进入待派发队列")
        return application

    def list_jobs(self) -> list[dict[str, Any]]:
        self._require("permission:view")
        jobs = sorted(self.jobs.values(), key=lambda j: j["id"], reverse=True)
        # 列表读取时顺手把到期例外状态刷新，但不动历史请求证据
        for record in self.exceptions.values():
            self._exc_live(record)
        return jobs

    def dispatch_job(self, application_id: int) -> dict[str, Any]:
        self._require("permission:run_job")
        application = self.applications.get(application_id)
        if application is None:
            raise PermissionError(404, f"采集申请 {application_id} 不存在")
        if application["status"] != "待派发":
            raise PermissionError(400, f"申请当前状态为{application['status']}，不能重复派发")
        job = self._build_job(
            domain_id=application["domain_id"],
            start_url=application["start_url"],
            applicant=application["applicant"],
            status=APP_PENDING,
        )
        job["application_id"] = application_id
        job["redirect_chain"] = application.get("redirect_chain", [])
        application["status"] = "已派发"
        application["job_id"] = job["id"]
        self._log("派发作业", f"申请 {application_id} 派发为作业 {job['code']}")
        return job

    def start_job(self, job_id: int) -> dict[str, Any]:
        self._require("permission:run_job")
        job = self._job_or_404(job_id)
        if job["status"] not in (APP_PENDING,):
            raise PermissionError(400, f"作业当前状态为{job['status']}，无法启动")
        job["status"] = APP_RUNNING
        self._log("启动作业", f"作业 {job['code']} 开始采集")
        return job

    def _job_or_404(self, job_id: int) -> dict[str, Any]:
        job = self.jobs.get(job_id)
        if job is None:
            raise PermissionError(404, f"采集作业 {job_id} 不存在")
        return job

    def _append_request(self, job_id: int, url: str, *, verdict: str, basis: str,
                        decided_version: int | None, trace: list[dict[str, Any]],
                        redirected_from: str | None = None) -> dict[str, Any]:
        job = self.jobs[job_id]
        record = {
            "id": self._next_id(),
            "job_id": job_id,
            "url": url,
            "redirected_from": redirected_from,
            "verdict": verdict,
            "basis": basis,
            "decided_version": decided_version,
            "decided_at": _iso(_now()),
            "trace": trace,
        }
        job["requests"].append(record)
        return record

    def job_request(self, job_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        """模拟作业发出下一次请求：撤回暂停、地址修改重判、证据留存都在这里收口。"""
        self._require("permission:run_job")
        with self._lock:
            job = self._job_or_404(job_id)
            if job["status"] == APP_PAUSED:
                # 暂停后仍尝试发请求：把这次被拦下的路径补记下来，界面要展示撤回版本与被拒路径
                attempted = split_url(str(payload.get("url") or job["start_url"]))["decoded_path"]
                job["rejected_path"] = attempted
                raise PermissionError(409, "作业已暂停，不能继续发请求", {
                    "pause_reason": job.get("pause_reason"),
                    "withdraw_version": job.get("withdraw_version"),
                    "rejected_path": attempted,
                })
            if job["status"] in (APP_DONE, APP_TERMINATED):
                raise PermissionError(400, f"作业已{job['status']}，不再接受新请求")
            domain = self._domain_or_404(job["domain_id"])
            # 撤回在“下一次发请求前”拦截：即便状态没来得及刷新也在这里兜底
            if domain["status"] == "已撤回":
                job["status"] = APP_PAUSED
                job["pause_reason"] = "许可已撤回，下一次发请求前暂停"
                job["withdraw_version"] = domain["withdraw_version"]
                rejected = split_url(str(payload.get("url") or job["start_url"]))["decoded_path"]
                job["rejected_path"] = rejected
                self._log("作业暂停", f"{job['code']} 因许可撤回 v{domain['withdraw_version']} 暂停，被拒路径 {rejected}")
                raise PermissionError(409, "许可已撤回，作业在发请求前暂停", {
                    "pause_reason": job["pause_reason"],
                    "withdraw_version": domain["withdraw_version"],
                    "rejected_path": rejected,
                })
            url = str(payload.get("url") or job["start_url"]).strip()
            redirect_chain = payload.get("redirect_chain") or []
            redirected_from = None
            if url != job["start_url"] and not payload.get("redirect_chain"):
                redirected_from = job["start_url"]
            evaluation = self.evaluate_url(url, redirect_chain)
            record = self._append_request(
                job_id, url,
                verdict=evaluation["verdict"],
                basis=evaluation["reason"],
                decided_version=evaluation.get("decided_version"),
                trace=evaluation["trace"],
                redirected_from=redirected_from,
            )
            if evaluation["verdict"] == "拒绝":
                # 单次请求被拒不杀作业，记录在案、等待工程师调整地址
                self._log("请求被拒", f"{job['code']} 请求 {url} 被拒：{evaluation['reason']}")
            else:
                self._log("请求放行", f"{job['code']} 请求 {url} 放行（v{evaluation.get('decided_version')}）")
            return {"job": job, "request": record, "evaluation": evaluation}

    def get_job_evidence(self, job_id: int) -> dict[str, Any]:
        """打开某次匹配证据：观察者无权查看，历史请求保持原裁决依据。"""
        self._require("permission:view_evidence")
        job = self._job_or_404(job_id)
        return job

    def terminate_job(self, job_id: int) -> dict[str, Any]:
        self._require("permission:run_job")
        job = self._job_or_404(job_id)
        if job["status"] in (APP_DONE, APP_TERMINATED):
            raise PermissionError(400, "作业已经结束，无需终止")
        job["status"] = APP_TERMINATED
        self._log("终止作业", f"作业 {job['code']} 被手动终止")
        return job


permission_service = PermissionService()
