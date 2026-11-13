/** 站点采集许可中心的接口类型，与后端 app/services/permission.py 对齐。 */

export type RoleKey = 'admin' | 'engineer' | 'approver' | 'observer'

export type Zone = 'allow' | 'deny' | 'exception'

export interface Session {
  user: RoleKey
  role: RoleKey
  role_label: string
  permissions: string[]
  roles: { key: RoleKey; label: string }[]
}

export interface TreeNode {
  id: string
  name: string
  path: string
  zone: Zone
  children: TreeNode[]
}

export interface DomainSummary {
  id: number
  code: string
  name: string
  owner: string
  host: string
  aliases: string[]
  version: number
  status: '生效中' | '已撤回'
  updated_by: string
  updated_at: string
  active_exception_count: number
}

export type ExceptionStatus = '待审批' | '生效中' | '已驳回' | '已到期' | '已撤销'

export interface ExceptionRecord {
  id: number
  domain_id: number
  path: string
  reason: string
  status: ExceptionStatus
  created_by: string
  created_at: string
  approved_by: string | null
  approved_at: string | null
  expires_at: string
}

export interface DomainDetail extends DomainSummary {
  tree: TreeNode
  withdrawn_at: string | null
  withdrawn_by: string | null
  withdraw_reason: string | null
  withdraw_version: number | null
  exceptions: ExceptionRecord[]
}

export interface TraceStep {
  order: number
  url: string
  host: string
  raw_path: string
  decoded_path: string
  via_redirect: boolean
  verdict?: '允许' | '拒绝'
  reason?: string
  alias_mapped_to?: string
  decided_version?: number
  domain?: { id: number; host: string; version: number }
  tree_path?: { node: string; path: string; zone: Zone; zone_label: string }[]
  exception?: { id: number; path: string; expires_at: string; approved_by: string | null }
}

export interface Evaluation {
  url: string
  redirect_count: number
  verdict: '允许' | '拒绝'
  reason: string
  domain_id?: number
  decided_version?: number
  trace: TraceStep[]
}

export interface ConflictDetail {
  conflict: true
  base_version: number
  latest_version: number
  latest_updated_by: string
  latest_updated_at: string
  server_tree: TreeNode
}

export interface RequestRecord {
  id: number
  job_id: number
  url: string
  redirected_from: string | null
  verdict: '允许' | '拒绝'
  basis: string
  decided_version: number | null
  decided_at: string
  trace: TraceStep[]
}

export type JobStatus = '待执行' | '运行中' | '已暂停' | '已完成' | '已终止'

export interface Job {
  id: number
  code: string
  domain_id: number
  start_url: string
  redirect_chain?: string[]
  applicant: string
  status: JobStatus
  created_at: string
  pause_reason: string | null
  withdraw_version: number | null
  rejected_path: string | null
  application_id?: number
  requests: RequestRecord[]
}

export interface Application {
  id: number
  domain_id: number
  start_url: string
  redirect_chain: string[]
  applicant: string
  status: '待派发' | '已派发'
  created_at: string
  job_id?: number
  evaluation_snapshot: Evaluation
}

export interface AuditLog {
  id: number
  time: string
  actor: string
  actor_label: string
  action: string
  detail: string
}
