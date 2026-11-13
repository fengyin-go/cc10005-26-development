/** 限时例外管理：申请、独立审批人批准/驳回、到期自动失效、提前撤销。 */
import { useState } from 'react'

import { api, ApiError } from './api'
import type { DomainDetail, ExceptionRecord, Session } from './types'

interface Props {
  session: Session
  domain: DomainDetail | null
  exceptions: ExceptionRecord[]
  onChange: () => void
  onError: (message: string) => void
}

function defaultExpiry(): string {
  // 默认给 24 小时后的本地时间输入值（datetime-local 格式）
  const d = new Date(Date.now() + 24 * 3600 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function ExceptionsPanel({ session, domain, exceptions, onChange, onError }: Props) {
  const [path, setPath] = useState('/')
  const [reason, setReason] = useState('')
  const [expiresAt, setExpiresAt] = useState(defaultExpiry())
  const canApply = session.permissions.includes('permission:apply')
  const canApprove = session.permissions.includes('permission:approve_exception')

  async function guard(action: () => Promise<unknown>, fallback: string) {
    try {
      await action()
      onChange()
    } catch (error) {
      onError(error instanceof ApiError ? error.message : fallback)
    }
  }

  async function handleRequest() {
    if (!domain) {
      onError('请先在左侧选择一个域名许可')
      return
    }
    if (!path.trim().startsWith('/')) {
      onError('例外路径必须以 / 开头')
      return
    }
    await guard(() => api.requestException({
      domain_id: domain.id,
      path: path.trim(),
      reason: reason.trim() || '未说明申请理由',
      expires_at: new Date(expiresAt).toISOString(),
    }), '例外申请失败')
    setReason('')
  }

  const statusClass: Record<string, string> = {
    待审批: 'exc-pending',
    生效中: 'exc-active',
    已驳回: 'exc-rejected',
    已到期: 'exc-expired',
    已撤销: 'exc-revoked',
  }

  return (
    <div className="card-block">
      <div className="block-head">
        <div>
          <h3>限时例外授权</h3>
          <p className="hint">
            例外是排除区里的临时开口，必须由具备独立审批权限的人批准且限时；
            到期后自动退出授权集合，即使采集作业尚未结束也不再放行。
          </p>
        </div>
      </div>

      {canApply && domain && (
        <div className="exception-form">
          <label className="eval-field">
            <span>例外路径</span>
            <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/search/partner" />
          </label>
          <label className="eval-field grow">
            <span>申请理由</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="说明业务背景与必要性" />
          </label>
          <label className="eval-field">
            <span>到期时间（硬约束）</span>
            <input type="datetime-local" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
          </label>
          <button className="btn primary" type="button" onClick={() => void handleRequest()}>申请限时例外</button>
        </div>
      )}
      {!canApply && <div className="notice">当前角色没有例外申请权限，仅可查看共享的例外记录。</div>}

      <table className="data-table compact">
        <thead>
          <tr><th>#</th><th>路径</th><th>理由</th><th>状态</th><th>申请人</th><th>批准人</th><th>到期时间</th><th>审批操作</th></tr>
        </thead>
        <tbody>
          {exceptions.map((record) => (
            <tr key={record.id}>
              <td>#{record.id}</td>
              <td><code>{record.path}</code></td>
              <td>{record.reason}</td>
              <td><span className={`exc-chip ${statusClass[record.status] ?? ''}`}>{record.status}</span></td>
              <td>{record.created_by}</td>
              <td>{record.approved_by ?? '—'}</td>
              <td>{record.expires_at.slice(0, 19).replace('T', ' ')}</td>
              <td className="row-actions">
                {record.status === '待审批' && canApprove && (
                  <>
                    <button className="link" type="button"
                      onClick={() => void guard(() => api.decideException(record.id, 'approve'), '批准失败')}>
                      批准
                    </button>
                    <button className="link danger-link" type="button"
                      onClick={() => void guard(() => api.decideException(record.id, 'reject'), '驳回失败')}>
                      驳回
                    </button>
                  </>
                )}
                {record.status === '生效中' && canApprove && (
                  <button className="link danger-link" type="button"
                    onClick={() => void guard(() => api.revokeException(record.id), '撤销失败')}>
                    提前撤销
                  </button>
                )}
                {record.status === '待审批' && !canApprove && <span className="muted-text">等待独立审批人处理</span>}
              </td>
            </tr>
          ))}
          {exceptions.length === 0 && (
            <tr><td className="empty-state" colSpan={8}>当前许可还没有例外记录</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
