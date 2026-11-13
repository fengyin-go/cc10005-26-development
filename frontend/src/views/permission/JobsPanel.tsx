/** 采集申请与作业面板：派发、发请求前重判、撤回暂停原因与每次匹配证据。 */
import { useState } from 'react'

import { api, ApiError } from './api'
import type { Application, Job, RequestRecord, Session } from './types'

interface Props {
  session: Session
  applications: Application[]
  jobs: Job[]
  domainMap: Map<number, string>
  onChange: () => void
  onError: (message: string) => void
}

export default function JobsPanel({ session, applications, jobs, domainMap, onChange, onError }: Props) {
  const [evidenceJob, setEvidenceJob] = useState<Job | null>(null)
  const canRun = session.permissions.includes('permission:run_job')
  const canSeeEvidence = session.permissions.includes('permission:view_evidence')

  async function guard(action: () => Promise<unknown>, fallback: string) {
    try {
      await action()
      onChange()
    } catch (error) {
      if (error instanceof ApiError) {
        const extra = error.detail
        const parts = [error.message]
        if (extra.rejected_path) parts.push(`被拒路径：${String(extra.rejected_path)}`)
        if (extra.withdraw_version) parts.push(`撤回版本：v${String(extra.withdraw_version)}`)
        onError(parts.join('；'))
      } else {
        onError(fallback)
      }
    }
  }

  return (
    <div className="card-block">
      <div className="block-head">
        <div>
          <h3>采集申请与运行作业</h3>
          <p className="hint">许可撤回时作业在下一次发请求前暂停并记录撤回版本与被拒路径；历史请求的裁决依据原样留存。</p>
        </div>
      </div>

      <h4 className="sub-title">采集申请（先裁决、后申请）</h4>
      <table className="data-table compact">
        <thead>
          <tr><th>申请#</th><th>归属许可</th><th>起始地址</th><th>快照裁决</th><th>状态</th><th>操作</th></tr>
        </thead>
        <tbody>
          {applications.map((app) => (
            <tr key={app.id}>
              <td>#{app.id}</td>
              <td>{domainMap.get(app.domain_id) ?? `#${app.domain_id}`}</td>
              <td className="url-cell">{app.start_url}</td>
              <td>
                <span className={`verdict-chip ${app.evaluation_snapshot.verdict === '允许' ? 'ok' : 'bad'}`}>
                  {app.evaluation_snapshot.verdict}
                </span>
                <span className="muted-text"> v{app.evaluation_snapshot.decided_version ?? '—'}</span>
              </td>
              <td>{app.status}</td>
              <td>
                {app.status === '待派发' && canRun && (
                  <button className="link" type="button"
                    onClick={() => void guard(() => api.dispatch(app.id), '派发失败')}>
                    派发为作业
                  </button>
                )}
                {app.status === '已派发' && <span className="muted-text">已生成作业 #{app.job_id}</span>}
              </td>
            </tr>
          ))}
          {applications.length === 0 && (
            <tr><td className="empty-state" colSpan={6}>暂无采集申请，可在「许可匹配轨迹」里裁决后提交</td></tr>
          )}
        </tbody>
      </table>

      <h4 className="sub-title">运行作业</h4>
      <table className="data-table compact">
        <thead>
          <tr><th>作业编号</th><th>归属许可</th><th>起始地址</th><th>状态</th><th>暂停/撤回信息</th><th>请求数</th><th>操作</th></tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className={job.status === '已暂停' ? 'row-paused' : ''}>
              <td>{job.code}</td>
              <td>{domainMap.get(job.domain_id) ?? `#${job.domain_id}`}</td>
              <td className="url-cell">{job.start_url}</td>
              <td><span className={`status-chip status-${job.status}`}>{job.status}</span></td>
              <td className="pause-cell">
                {job.pause_reason && (
                  <div className="pause-info">
                    <div>{job.pause_reason}</div>
                    {job.withdraw_version && <div className="muted-text">撤回版本 v{job.withdraw_version}</div>}
                    {job.rejected_path && <div className="muted-text">被拒路径 {job.rejected_path}</div>}
                  </div>
                )}
              </td>
              <td>{job.requests.length}</td>
              <td className="row-actions">
                {job.status === '待执行' && canRun && (
                  <button className="link" type="button"
                    onClick={() => void guard(() => api.startJob(job.id), '启动失败')}>
                    启动采集
                  </button>
                )}
                {job.status === '运行中' && canRun && (
                  <JobRequestButton job={job} onDone={onChange} onError={onError} />
                )}
                {(job.status === '运行中' || job.status === '待执行') && canRun && (
                  <button className="link danger-link" type="button"
                    onClick={() => void guard(() => api.terminate(job.id), '终止失败')}>
                    终止
                  </button>
                )}
                {canSeeEvidence && (
                  <button className="link" type="button" onClick={() => setEvidenceJob(job)}>
                    匹配证据
                  </button>
                )}
              </td>
            </tr>
          ))}
          {jobs.length === 0 && (
            <tr><td className="empty-state" colSpan={7}>暂无作业</td></tr>
          )}
        </tbody>
      </table>

      {evidenceJob && (
        <EvidenceModal job={evidenceJob} onClose={() => setEvidenceJob(null)} />
      )}
    </div>
  )
}

function JobRequestButton({ job, onDone, onError }: {
  job: Job
  onDone: () => void
  onError: (message: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [nextUrl, setNextUrl] = useState(job.start_url)
  const [redirectText, setRedirectText] = useState('')

  async function send() {
    const redirectChain = redirectText.split('\n').map((s) => s.trim()).filter(Boolean)
    try {
      const result = await api.jobRequest(job.id, {
        url: editing ? nextUrl.trim() || undefined : undefined,
        redirect_chain: redirectChain,
      })
      onDone()
      onError(`请求已裁决：${result.evaluation.verdict}（${result.evaluation.reason}）`)
      setEditing(false)
    } catch (error) {
      if (error instanceof ApiError) {
        const parts = [error.message]
        if (error.detail.rejected_path) parts.push(`被拒路径：${String(error.detail.rejected_path)}`)
        onError(parts.join('；'))
      } else {
        onError('请求裁决失败')
      }
    }
  }

  if (!editing) {
    return (
      <>
        <button className="link" type="button" onClick={() => setEditing(true)}>发下一次请求</button>
      </>
    )
  }

  return (
    <div className="next-request">
      <input value={nextUrl} onChange={(event) => setNextUrl(event.target.value)} placeholder="修改后的地址，留空沿用起始地址" />
      <textarea
        rows={1}
        value={redirectText}
        placeholder="跳转链（每行一个，可选）"
        onChange={(event) => setRedirectText(event.target.value)}
      />
      <button className="btn primary tiny" type="button" onClick={() => void send()}>按新地址重判</button>
      <button className="btn ghost tiny" type="button" onClick={() => setEditing(false)}>取消</button>
    </div>
  )
}

function EvidenceModal({ job, onClose }: { job: Job; onClose: () => void }) {
  const [selected, setSelected] = useState<RequestRecord | null>(job.requests[0] ?? null)
  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal-box wide" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <h3>匹配证据 · {job.code}</h3>
          <button className="btn ghost" type="button" onClick={onClose}>关闭</button>
        </div>
        <p className="hint">每次请求都冻结当时的裁决依据；许可之后被撤回或修改，历史记录保持原版本结论不变。</p>
        <div className="evidence-layout">
          <ul className="evidence-list">
            {job.requests.map((record) => (
              <li key={record.id}>
                <button
                  type="button"
                  className={`evidence-item ${selected?.id === record.id ? 'active' : ''}`}
                  onClick={() => setSelected(record)}
                >
                  <span className={`verdict-chip ${record.verdict === '允许' ? 'ok' : 'bad'}`}>{record.verdict}</span>
                  <code>{record.url}</code>
                  <span className="muted-text">
                    {record.redirected_from ? '改地址重判' : '常规请求'} · 依据 v{record.decided_version ?? '—'}
                  </span>
                </button>
              </li>
            ))}
            {job.requests.length === 0 && <li className="empty-state">该作业还没有产生请求记录</li>}
          </ul>
          {selected && (
            <div className="evidence-detail">
              <dl className="trace-grid">
                <div><dt>请求地址</dt><dd>{selected.url}</dd></div>
                {selected.redirected_from && <div><dt>原起始地址</dt><dd>{selected.redirected_from}</dd></div>}
                <div><dt>裁决结论</dt><dd>{selected.verdict}（{selected.basis}）</dd></div>
                <div><dt>裁决版本</dt><dd>v{selected.decided_version ?? '—'}</dd></div>
                <div><dt>裁决时间</dt><dd>{selected.decided_at.slice(0, 19).replace('T', ' ')}</dd></div>
              </dl>
              <ol className="trace-list">
                {selected.trace.map((step) => (
                  <li key={step.order} className="trace-step">
                    <div className="trace-title">
                      <span className="hop-badge">{step.via_redirect ? `第 ${step.order} 跳` : '起始地址'}</span>
                      <code className="trace-url">{step.url}</code>
                      {step.verdict && (
                        <span className={`verdict-chip ${step.verdict === '允许' ? 'ok' : 'bad'}`}>{step.verdict}</span>
                      )}
                    </div>
                    <dl className="trace-grid">
                      <div><dt>原始路径</dt><dd>{step.raw_path}</dd></div>
                      <div><dt>解码路径</dt><dd>{step.decoded_path}</dd></div>
                      {step.alias_mapped_to && <div><dt>别名映射</dt><dd>→ {step.alias_mapped_to}</dd></div>}
                    </dl>
                    {step.tree_path && (
                      <div className="trace-chain">
                        <span className="chain-label">树匹配链路：</span>
                        {step.tree_path.map((hit, index) => (
                          <span key={index} className={`chain-node zone-${hit.zone}`}>
                            {hit.node} <code>{hit.path}</code>
                            <em>{hit.zone_label}</em>
                          </span>
                        ))}
                      </div>
                    )}
                    {step.reason && <p className="trace-reason">裁决说明：{step.reason}</p>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
