/** 站点采集许可中心主页面。

布局：左侧域名许可列表 + 顶部角色切换；右侧标签页覆盖
路径树编辑、限时例外、匹配轨迹、采集申请/作业证据、操作审计。
所有写操作都按当前角色的权限点放行或拦截，后端是最终裁决方。
*/
import { useCallback, useEffect, useMemo, useState } from 'react'

import { api, ApiError } from './api'
import AuditPanel from './AuditPanel'
import EvaluationPanel from './EvaluationPanel'
import ExceptionsPanel from './ExceptionsPanel'
import JobsPanel from './JobsPanel'
import TreeEditor from './TreeEditor'
import type {
  Application, AuditLog, ConflictDetail, DomainDetail, DomainSummary,
  ExceptionRecord, Job, Session, TreeNode,
} from './types'

type TabKey = 'tree' | 'exception' | 'evaluate' | 'jobs' | 'audit'

const TABS: { key: TabKey; label: string }[] = [
  { key: 'tree', label: '路径树许可' },
  { key: 'exception', label: '限时例外' },
  { key: 'evaluate', label: '匹配轨迹与申请' },
  { key: 'jobs', label: '采集作业与证据' },
  { key: 'audit', label: '操作审计' },
]

export default function PermissionCenter() {
  const [session, setSession] = useState<Session | null>(null)
  const [domains, setDomains] = useState<DomainSummary[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [domain, setDomain] = useState<DomainDetail | null>(null)
  const [exceptions, setExceptions] = useState<ExceptionRecord[]>([])
  const [applications, setApplications] = useState<Application[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [logs, setLogs] = useState<AuditLog[]>([])
  const [tab, setTab] = useState<TabKey>('tree')
  const [keyword, setKeyword] = useState('')
  const [message, setMessage] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [conflict, setConflict] = useState<ConflictDetail | null>(null)
  const [showCreate, setShowCreate] = useState(false)

  const canEdit = session?.permissions.includes('permission:edit') ?? false
  const canWithdraw = session?.permissions.includes('permission:withdraw') ?? false

  const showError = useCallback((text: string) => {
    setErrorMessage(text)
    setMessage('')
  }, [])

  const refreshAll = useCallback(async () => {
    const [domainList, appList, jobList, logList] = await Promise.all([
      api.domains(keyword || undefined),
      api.applications(),
      api.jobs(),
      api.auditLogs(),
    ])
    setDomains(domainList)
    setApplications(appList)
    setJobs(jobList)
    setLogs(logList)
  }, [keyword])

  const refreshDomain = useCallback(async (id: number) => {
    const detail = await api.domain(id)
    setDomain(detail)
    setExceptions(detail.exceptions)
  }, [])

  useEffect(() => {
    void (async () => {
      const current = await api.session()
      setSession(current)
      const list = await api.domains()
      setDomains(list)
      if (list.length > 0) setSelectedId(list[0].id)
    })()
  }, [])

  useEffect(() => {
    if (selectedId === null) {
      setDomain(null)
      setExceptions([])
      return
    }
    void refreshDomain(selectedId)
  }, [selectedId, refreshDomain])

  useEffect(() => {
    void refreshAll().catch((error) => showError(error instanceof Error ? error.message : '数据刷新失败'))
  }, [refreshAll, showError])

  const domainMap = useMemo(
    () => new Map(domains.map((item) => [item.id, `${item.name}（${item.host}）`])),
    [domains],
  )

  async function handleSwitch(role: string) {
    try {
      const next = await api.switchRole(role)
      setSession(next)
      setErrorMessage('')
      setMessage(`已切换为${next.role_label}`)
    } catch (error) {
      showError(error instanceof Error ? error.message : '角色切换失败')
    }
  }

  async function handleSaveTree(tree: TreeNode, aliases: string[]) {
    if (!domain) return
    try {
      const updated = await api.saveTree(domain.id, { base_version: domain.version, tree, aliases })
      setDomain(updated)
      setExceptions(updated.exceptions)
      setConflict(null)
      setMessage(`路径树已保存，许可升级到 v${updated.version}`)
      setErrorMessage('')
      void refreshAll()
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.detail.conflict) {
        setConflict(error.detail as unknown as ConflictDetail)
        showError('保存版本已过期：他人已经更新了路径树，请先解决冲突')
      } else {
        showError(error instanceof Error ? error.message : '路径树保存失败')
      }
    }
  }

  async function handleWithdraw() {
    if (!domain) return
    const reason = window.prompt('请填写许可撤回原因（运行作业将在下一次发请求前暂停）')
    if (reason === null) return
    try {
      await api.withdraw(domain.id, reason.trim() || '未填写撤回原因')
      setMessage('许可已撤回，运行作业将在下一次发请求前暂停')
      await Promise.all([refreshDomain(domain.id), refreshAll()])
    } catch (error) {
      showError(error instanceof Error ? error.message : '撤回失败')
    }
  }

  async function handleCreateDomain(payload: { host: string; name: string; aliases: string[] }) {
    try {
      const created = await api.createDomain(payload)
      setShowCreate(false)
      setSelectedId(created.id)
      setMessage(`新许可已登记：${created.host}`)
      void refreshAll()
    } catch (error) {
      showError(error instanceof Error ? error.message : '登记失败')
    }
  }

  if (!session) {
    return <section className="page"><p className="empty-state">正在加载许可中心…</p></section>
  }

  return (
    <section className="page permission-page" data-module="permission">
      <header className="page-head">
        <div>
          <h2>站点采集许可中心</h2>
          <p className="page-desc">
            以受控权限约束域名归属：观察者只读共享许可；排除压过允许；例外经独立审批且限时；
            别名、百分号编码与跳转地址逐跳重判；撤回在下一次请求前暂停作业并留存证据。
          </p>
        </div>
        <div className="role-switcher">
          <span className="role-current">当前身份：{session.role_label}</span>
          <select value={session.role} onChange={(event) => void handleSwitch(event.target.value)}>
            {session.roles.map((role) => (
              <option key={role.key} value={role.key}>{role.label}</option>
            ))}
          </select>
        </div>
      </header>

      {(message || errorMessage) && (
        <div className={`notice ${errorMessage ? 'danger' : 'ok'}`}>
          {errorMessage || message}
          <button className="notice-close" type="button" onClick={() => { setMessage(''); setErrorMessage('') }}>×</button>
        </div>
      )}

      <div className="perm-layout">
        <aside className="domain-side card-block">
          <div className="block-head">
            <h3>域名许可</h3>
            {canEdit && <button className="btn tiny primary" type="button" onClick={() => setShowCreate(true)}>登记域名</button>}
          </div>
          <div className="domain-search">
            <input
              value={keyword}
              placeholder="按名称/域名/编号检索"
              onChange={(event) => setKeyword(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void refreshAll() }}
            />
            <button className="btn tiny" type="button" onClick={() => void refreshAll()}>查询</button>
          </div>
          <ul className="domain-list">
            {domains.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`domain-card ${selectedId === item.id ? 'active' : ''} ${item.status === '已撤回' ? 'withdrawn' : ''}`}
                  onClick={() => setSelectedId(item.id)}
                >
                  <div className="domain-card-head">
                    <strong>{item.name}</strong>
                    <span className={`status-pill ${item.status === '已撤回' ? 'bad' : 'ok'}`}>{item.status}</span>
                  </div>
                  <code className="domain-host">{item.host}</code>
                  <div className="domain-meta">
                    <span>{item.code} · v{item.version}</span>
                    <span>生效例外 {item.active_exception_count}</span>
                  </div>
                  {item.aliases.length > 0 && <div className="domain-aliases">别名：{item.aliases.join('、')}</div>}
                </button>
              </li>
            ))}
            {domains.length === 0 && <li className="empty-state">没有匹配的域名许可</li>}
          </ul>
        </aside>

        <div className="perm-content">
          <nav className="tab-bar">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`tab-item ${tab === item.key ? 'active' : ''}`}
                onClick={() => setTab(item.key)}
              >
                {item.label}
              </button>
            ))}
            {domain && canWithdraw && domain.status !== '已撤回' && (
              <button className="btn danger tab-withdraw" type="button" onClick={() => void handleWithdraw()}>
                撤回该许可
              </button>
            )}
          </nav>

          {!domain ? (
            <div className="card-block empty-state">请先选择或登记一个域名许可</div>
          ) : (
            <>
              {tab === 'tree' && (
                <TreeEditor
                  domain={domain}
                  readOnly={!canEdit}
                  conflict={conflict}
                  onSave={(tree, aliases) => void handleSaveTree(tree, aliases)}
                  onResolveConflict={(serverTree) => {
                    setDomain({ ...domain, tree: serverTree, version: conflict?.latest_version ?? domain.version })
                    setConflict(null)
                    setMessage('已拉取服务端最新版本，请在其基础上重新合并你的改动后再保存')
                  }}
                  onDiscardConflict={() => setConflict(null)}
                />
              )}
              {tab === 'exception' && (
                <ExceptionsPanel
                  session={session}
                  domain={domain}
                  exceptions={exceptions}
                  onChange={() => void refreshDomain(domain.id)}
                  onError={showError}
                />
              )}
              {tab === 'evaluate' && (
                <EvaluationPanel
                  key={domain.id}
                  session={session}
                  defaultUrl={`https://${domain.host}/`}
                  onApplied={() => void refreshAll()}
                  onError={showError}
                />
              )}
              {tab === 'jobs' && (
                <JobsPanel
                  session={session}
                  applications={applications}
                  jobs={jobs}
                  domainMap={domainMap}
                  onChange={() => { void refreshAll(); void refreshDomain(domain.id) }}
                  onError={showError}
                />
              )}
              {tab === 'audit' && <AuditPanel logs={logs} />}
            </>
          )}
        </div>
      </div>

      {showCreate && <CreateDomainModal onClose={() => setShowCreate(false)} onCreate={handleCreateDomain} />}
    </section>
  )
}

function CreateDomainModal({ onClose, onCreate }: {
  onClose: () => void
  onCreate: (payload: { host: string; name: string; aliases: string[] }) => void
}) {
  const [host, setHost] = useState('')
  const [name, setName] = useState('')
  const [aliases, setAliases] = useState('')

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-box" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h3>登记域名采集许可</h3>
          <button className="btn ghost" type="button" onClick={onClose}>关闭</button>
        </div>
        <div className="modal-form">
          <label className="eval-field">
            <span>归属域名 *</span>
            <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="example.com" />
          </label>
          <label className="eval-field">
            <span>许可名称</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 示例新闻门户" />
          </label>
          <label className="eval-field">
            <span>域名别名（逗号分隔）</span>
            <input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="m.example.com, example.cn" />
          </label>
          <button
            className="btn primary"
            type="button"
            disabled={!host.trim()}
            onClick={() => onCreate({
              host: host.trim(),
              name: name.trim() || host.trim(),
              aliases: aliases.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean),
            })}
          >
            确认登记
          </button>
        </div>
      </div>
    </div>
  )
}
