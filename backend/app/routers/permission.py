"""站点采集许可中心接口。

路由分组：
- 会话与审计：角色切换、操作审计
- 域名许可：列表/详情/新建/路径树保存（乐观锁冲突）/撤回
- 限时例外：申请、独立审批、撤销
- 裁决：地址匹配轨迹（别名、百分号编码、跳转逐跳重判）
- 采集申请与作业：申请、派发、发请求重判、暂停原因、匹配证据
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.services.permission import PermissionError, permission_service

router = APIRouter(prefix="/api/permission", tags=["站点采集许可"])


def _raise(exc: PermissionError) -> None:
    raise HTTPException(status_code=exc.status_code, detail={"message": exc.message, **exc.extra})


class SwitchUserPayload(BaseModel):
    role: str


class DomainPayload(BaseModel):
    code: str | None = None
    name: str | None = None
    owner: str | None = None
    host: str
    aliases: list[str] = Field(default_factory=list)


class TreeSavePayload(BaseModel):
    base_version: int
    tree: dict[str, Any]
    aliases: list[str] | None = None


class WithdrawPayload(BaseModel):
    reason: str = ""


class ExceptionPayload(BaseModel):
    domain_id: int
    path: str
    reason: str
    expires_at: str


class DecisionPayload(BaseModel):
    decision: str  # approve / reject


class EvaluatePayload(BaseModel):
    url: str
    redirect_chain: list[str] = Field(default_factory=list)


class ApplyPayload(BaseModel):
    start_url: str
    redirect_chain: list[str] = Field(default_factory=list)


class JobRequestPayload(BaseModel):
    url: str | None = None
    redirect_chain: list[str] = Field(default_factory=list)


# ---------------------------------------------------------------- 会话与审计
@router.get("/session")
def get_session() -> dict[str, Any]:
    return permission_service.session()


@router.post("/session/switch")
def switch_user(payload: SwitchUserPayload) -> dict[str, Any]:
    try:
        return permission_service.switch_user(payload.role)
    except PermissionError as exc:
        _raise(exc)


@router.get("/audit-logs")
def list_audit_logs() -> list[dict[str, Any]]:
    try:
        return permission_service.list_audit_logs()
    except PermissionError as exc:
        _raise(exc)


# ---------------------------------------------------------------- 域名许可
@router.get("/domains")
def list_domains(keyword: str | None = Query(default=None)) -> list[dict[str, Any]]:
    try:
        return permission_service.list_domains(keyword)
    except PermissionError as exc:
        _raise(exc)


@router.post("/domains")
def create_domain(payload: DomainPayload) -> dict[str, Any]:
    try:
        return permission_service.create_domain(payload.model_dump())
    except PermissionError as exc:
        _raise(exc)


@router.get("/domains/{domain_id}")
def get_domain(domain_id: int) -> dict[str, Any]:
    try:
        return permission_service.get_domain(domain_id)
    except PermissionError as exc:
        _raise(exc)


@router.put("/domains/{domain_id}/tree")
def save_tree(domain_id: int, payload: TreeSavePayload) -> dict[str, Any]:
    try:
        return permission_service.save_tree(domain_id, payload.model_dump())
    except PermissionError as exc:
        _raise(exc)


@router.post("/domains/{domain_id}/withdraw")
def withdraw_domain(domain_id: int, payload: WithdrawPayload) -> dict[str, Any]:
    try:
        return permission_service.withdraw_domain(domain_id, payload.reason)
    except PermissionError as exc:
        _raise(exc)


# ---------------------------------------------------------------- 限时例外
@router.get("/exceptions")
def list_exceptions(domain_id: int | None = Query(default=None)) -> list[dict[str, Any]]:
    try:
        return permission_service.list_exceptions(domain_id)
    except PermissionError as exc:
        _raise(exc)


@router.post("/exceptions")
def request_exception(payload: ExceptionPayload) -> dict[str, Any]:
    try:
        return permission_service.request_exception(payload.model_dump())
    except PermissionError as exc:
        _raise(exc)


@router.post("/exceptions/{exception_id}/decision")
def decide_exception(exception_id: int, payload: DecisionPayload) -> dict[str, Any]:
    try:
        return permission_service.approve_exception(exception_id, payload.decision)
    except PermissionError as exc:
        _raise(exc)


@router.delete("/exceptions/{exception_id}")
def revoke_exception(exception_id: int) -> dict[str, Any]:
    try:
        return permission_service.revoke_exception(exception_id)
    except PermissionError as exc:
        _raise(exc)


# ---------------------------------------------------------------- 裁决轨迹
@router.post("/evaluate")
def evaluate_url(payload: EvaluatePayload) -> dict[str, Any]:
    try:
        return permission_service.evaluate_url(payload.url, payload.redirect_chain)
    except PermissionError as exc:
        _raise(exc)


# ---------------------------------------------------------------- 申请与作业
@router.get("/applications")
def list_applications() -> list[dict[str, Any]]:
    try:
        return permission_service.list_applications()
    except PermissionError as exc:
        _raise(exc)


@router.post("/applications")
def apply_collection(payload: ApplyPayload) -> dict[str, Any]:
    try:
        return permission_service.apply_collection(payload.model_dump())
    except PermissionError as exc:
        _raise(exc)


@router.post("/applications/{application_id}/dispatch")
def dispatch_application(application_id: int) -> dict[str, Any]:
    try:
        return permission_service.dispatch_job(application_id)
    except PermissionError as exc:
        _raise(exc)


@router.get("/jobs")
def list_jobs() -> list[dict[str, Any]]:
    try:
        return permission_service.list_jobs()
    except PermissionError as exc:
        _raise(exc)


@router.post("/jobs/{job_id}/start")
def start_job(job_id: int) -> dict[str, Any]:
    try:
        return permission_service.start_job(job_id)
    except PermissionError as exc:
        _raise(exc)


@router.post("/jobs/{job_id}/requests")
def job_request(job_id: int, payload: JobRequestPayload) -> dict[str, Any]:
    try:
        return permission_service.job_request(job_id, payload.model_dump())
    except PermissionError as exc:
        _raise(exc)


@router.get("/jobs/{job_id}/evidence")
def job_evidence(job_id: int) -> dict[str, Any]:
    try:
        return permission_service.get_job_evidence(job_id)
    except PermissionError as exc:
        _raise(exc)


@router.post("/jobs/{job_id}/terminate")
def terminate_job(job_id: int) -> dict[str, Any]:
    try:
        return permission_service.terminate_job(job_id)
    except PermissionError as exc:
        _raise(exc)
