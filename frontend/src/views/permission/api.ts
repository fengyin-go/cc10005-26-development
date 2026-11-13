/** 许可中心接口封装：统一拼路径、提取后端业务错误信息（含 409 冲突体）。 */
import { request } from '@/api/client'

import type {
  Application, AuditLog, DomainDetail, DomainSummary, Evaluation, ExceptionRecord,
  Job, Session,
} from './types'

const BASE = '/api/permission'

export class ApiError extends Error {
  status: number
  detail: Record<string, unknown>

  constructor(status: number, message: string, detail: Record<string, unknown>) {
    super(message)
    this.status = status
    this.detail = detail
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await request(`${BASE}${path}`, init)
  if (!response.ok) {
    let message = `接口返回 ${response.status}`
    let detail: Record<string, unknown> = {}
    try {
      const body = await response.json()
      if (typeof body.detail === 'object' && body.detail !== null) {
        detail = body.detail
        message = String(detail.message ?? message)
      } else if (typeof body.detail === 'string') {
        message = body.detail
      }
    } catch {
      /* 非 JSON 错误体，保留默认提示 */
    }
    throw new ApiError(response.status, message, detail)
  }
  return (await response.json()) as T
}

export const api = {
  session: () => call<Session>('/session'),
  switchRole: (role: string) =>
    call<Session>('/session/switch', { method: 'POST', body: JSON.stringify({ role }) }),

  domains: (keyword?: string) =>
    call<DomainSummary[]>(`/domains${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}`),
  domain: (id: number) => call<DomainDetail>(`/domains/${id}`),
  createDomain: (payload: { host: string; name?: string; owner?: string; aliases: string[] }) =>
    call<DomainDetail>('/domains', { method: 'POST', body: JSON.stringify(payload) }),
  saveTree: (id: number, payload: { base_version: number; tree: unknown; aliases?: string[] }) =>
    call<DomainDetail>(`/domains/${id}/tree`, { method: 'PUT', body: JSON.stringify(payload) }),
  withdraw: (id: number, reason: string) =>
    call<DomainSummary>(`/domains/${id}/withdraw`, {
      method: 'POST', body: JSON.stringify({ reason }),
    }),

  exceptions: (domainId?: number) =>
    call<ExceptionRecord[]>(`/exceptions${domainId ? `?domain_id=${domainId}` : ''}`),
  requestException: (payload: { domain_id: number; path: string; reason: string; expires_at: string }) =>
    call<ExceptionRecord>('/exceptions', { method: 'POST', body: JSON.stringify(payload) }),
  decideException: (id: number, decision: 'approve' | 'reject') =>
    call<ExceptionRecord>(`/exceptions/${id}/decision`, {
      method: 'POST', body: JSON.stringify({ decision }),
    }),
  revokeException: (id: number) =>
    call<ExceptionRecord>(`/exceptions/${id}`, { method: 'DELETE' }),

  evaluate: (url: string, redirectChain: string[] = []) =>
    call<Evaluation>('/evaluate', {
      method: 'POST', body: JSON.stringify({ url, redirect_chain: redirectChain }),
    }),

  applications: () => call<Application[]>('/applications'),
  apply: (startUrl: string, redirectChain: string[]) =>
    call<Application>('/applications', {
      method: 'POST', body: JSON.stringify({ start_url: startUrl, redirect_chain: redirectChain }),
    }),
  dispatch: (id: number) => call<Job>(`/applications/${id}/dispatch`, { method: 'POST' }),

  jobs: () => call<Job[]>('/jobs'),
  startJob: (id: number) => call<Job>(`/jobs/${id}/start`, { method: 'POST' }),
  jobRequest: (id: number, payload: { url?: string; redirect_chain?: string[] }) =>
    call<{ job: Job; request: Job['requests'][number]; evaluation: Evaluation }>(
      `/jobs/${id}/requests`, { method: 'POST', body: JSON.stringify(payload) }),
  evidence: (id: number) => call<Job>(`/jobs/${id}/evidence`),
  terminate: (id: number) => call<Job>(`/jobs/${id}/terminate`, { method: 'POST' }),

  auditLogs: () => call<AuditLog[]>('/audit-logs'),
}
