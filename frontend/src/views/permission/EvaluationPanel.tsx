/** 许可匹配轨迹：地址归一化、别名回归、逐跳重判的全过程可视化。 */
import { useState } from 'react'

import { api, ApiError } from './api'
import type { Evaluation, Session } from './types'

interface Props {
  session: Session
  defaultUrl?: string
  onApplied: () => void
  onError: (message: string) => void
}

export default function EvaluationPanel({ session, defaultUrl, onApplied, onError }: Props) {
  const [url, setUrl] = useState(defaultUrl ?? 'https://news.example.com/article/1001')
  const [redirectText, setRedirectText] = useState('')
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null)
  const [busy, setBusy] = useState(false)
  const canApply = session.permissions.includes('permission:apply')

  const redirectChain = redirectText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  async function handleEvaluate() {
    if (!url.trim()) {
      onError('请先填写要裁决的起始地址')
      return
    }
    setBusy(true)
    try {
      setEvaluation(await api.evaluate(url.trim(), redirectChain))
    } catch (error) {
      onError(error instanceof Error ? error.message : '裁决请求失败')
    } finally {
      setBusy(false)
    }
  }

  async function handleApply() {
    if (!evaluation) return
    setBusy(true)
    try {
      await api.apply(evaluation.url, redirectChain)
      onApplied()
      onError('')
    } catch (error) {
      const message = error instanceof ApiError
        ? `采集申请被拒：${error.message}`
        : '采集申请失败'
      onError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card-block">
      <div className="block-head">
        <div>
          <h3>许可匹配轨迹</h3>
          <p className="hint">选中起始地址后先看裁决轨迹；别名、百分号编码与跳转后的地址都会重新匹配，不做一次检查放行。</p>
        </div>
      </div>

      <div className="eval-form">
        <label className="eval-field grow">
          <span>起始地址</span>
          <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://..." />
        </label>
        <label className="eval-field">
          <span>跳转链（每行一个最终地址，可选）</span>
          <textarea
            value={redirectText}
            rows={2}
            placeholder={'https://news.example.com/search/rebound'}
            onChange={(event) => setRedirectText(event.target.value)}
          />
        </label>
        <div className="eval-actions">
          <button className="btn primary" type="button" disabled={busy} onClick={handleEvaluate}>
            执行许可裁决
          </button>
          {canApply && (
            <button
              className="btn"
              type="button"
              disabled={busy || !evaluation || evaluation.verdict !== '允许'}
              title={evaluation?.verdict === '拒绝' ? '裁决为拒绝的地址不能发起采集申请' : '先裁决为允许后才能申请采集'}
              onClick={handleApply}
            >
              申请交给采集任务
            </button>
          )}
        </div>
      </div>

      {evaluation && (
        <div className="eval-result">
          <div className={`verdict-banner ${evaluation.verdict === '允许' ? 'ok' : 'bad'}`}>
            <strong>{evaluation.verdict}</strong>
            <span>{evaluation.reason}</span>
            <span className="verdict-meta">
              跳转 {evaluation.redirect_count} 跳
              {evaluation.decided_version ? ` · 裁决依据版本 v${evaluation.decided_version}` : ''}
            </span>
          </div>
          <ol className="trace-list">
            {evaluation.trace.map((step) => (
              <li key={step.order} className={`trace-step ${step.via_redirect ? 'redirect-hop' : ''}`}>
                <div className="trace-title">
                  <span className="hop-badge">{step.via_redirect ? `第 ${step.order} 跳` : '起始地址'}</span>
                  <code className="trace-url">{step.url}</code>
                  {step.verdict && (
                    <span className={`verdict-chip ${step.verdict === '允许' ? 'ok' : 'bad'}`}>{step.verdict}</span>
                  )}
                </div>
                <dl className="trace-grid">
                  <div><dt>归属域名</dt><dd>{step.host}{step.alias_mapped_to && <em>（别名 → {step.alias_mapped_to}）</em>}</dd></div>
                  <div><dt>原始路径</dt><dd>{step.raw_path}</dd></div>
                  <div><dt>解码后路径</dt><dd>{step.decoded_path}</dd></div>
                  {step.decided_version && <div><dt>许可版本</dt><dd>v{step.decided_version}</dd></div>}
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
                {step.exception && (
                  <div className="trace-exception">
                    限时例外 #{step.exception.id} {step.exception.path}，
                    批准人 {step.exception.approved_by ?? '—'}，有效期至 {step.exception.expires_at.slice(0, 19).replace('T', ' ')}
                  </div>
                )}
                {step.reason && <p className="trace-reason">裁决说明：{step.reason}</p>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  )
}
