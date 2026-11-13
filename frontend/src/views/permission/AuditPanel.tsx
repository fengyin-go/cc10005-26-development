/** 审计日志：许可的每次授权、撤回、审批与作业拦截都留痕。 */
import type { AuditLog } from './types'

export default function AuditPanel({ logs }: { logs: AuditLog[] }) {
  return (
    <div className="card-block">
      <div className="block-head">
        <div>
          <h3>操作审计</h3>
          <p className="hint">谁在什么时候改了授权、批了例外或触发了撤回暂停，全部可追溯。</p>
        </div>
      </div>
      <ul className="audit-list">
        {logs.map((log) => (
          <li key={log.id} className="audit-item">
            <span className="audit-time">{log.time.slice(0, 19).replace('T', ' ')}</span>
            <span className="audit-actor">{log.actor_label}（{log.actor}）</span>
            <span className="audit-action">{log.action}</span>
            <span className="audit-detail">{log.detail}</span>
          </li>
        ))}
        {logs.length === 0 && <li className="empty-state">暂无审计记录</li>}
      </ul>
    </div>
  )
}
