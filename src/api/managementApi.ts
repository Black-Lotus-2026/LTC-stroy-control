import { API_PREFIX, getAuthHeaders } from './stroyControlApi'

export type DecimalValue = string | number
export type AnalysisMode = 'deterministic' | 'llm'
export type DemoEpisode = 'baseline' | 'camera_unavailable' | 'slack' | 'expensive_action'
export interface ManagementRate {
  id: string; amount: DecimalValue | null; currency: string
  unit: 'work_hour' | 'work_day' | 'calendar_day'
  valid_from: string | null; valid_to: string | null; source: string
  confirmation: 'demo' | 'user_assumption' | 'confirmed'
}
export interface ManagementResource {
  resource_id: string; name: string; quantity: DecimalValue; idle_fraction: DecimalValue
  paid_and_affected: boolean; rates: ManagementRate[]; cost_group: string; source: string
}
export interface ManagementScenario {
  id: string; title: string; recovery_work_hours: DecimalValue
  intervention_costs: ExplicitCost[]; other_costs: ExplicitCost[]
  action_allowed: boolean; assumptions: string[]
}
interface ExplicitCost { id: string; title: string; amount: DecimalValue | null; currency: string; cost_group: string; source: string }
export interface ManagementEvidence {
  source_ref: string; project_id: string; zone_id: string; camera_id: string; captured_at: string
  model_status: 'valid' | 'unavailable' | 'failed'; camera_status: 'online' | 'offline' | 'unknown'
  detected_classes: string[]; image_url: string | null
  origin: 'persisted_frame' | 'demo_replay' | 'user_observation'
}
export interface ManagementSnapshot {
  schema_version: '1.0'; project_id: string; incident_id: string | null; as_of: string
  data_mode: 'demo' | 'user'; zone_id: string; schedule_version: string; profile_version: string
  calendar: { timezone: string; shift_start: string; shift_end: string; working_weekdays: number[]; holidays: string[]; extra_working_dates: string[] }
  tasks: { id: string; project_id: string; schedule_task_id: string | null; name: string; remaining_work_hours: DecimalValue; earliest_start_work_hours: DecimalValue; planned_start: string | null; planned_end: string | null; completed: boolean; actual_finish_at: string | null }[]
  dependencies: { predecessor_id: string; successor_id: string; kind: 'FS'; lag_work_hours: DecimalValue }[]
  blocked_task_id: string; milestone_task_id: string; agreed_deadline_at: string | null
  blockage_confirmation: 'hypothesis' | 'human_confirmed'; confirmation_source: string | null
  rule: { version: string; source_ref: string; required_class: string; applicable_task_ids: string[]; max_frame_age_minutes: number; max_camera_skew_seconds: number }
  evidence: ManagementEvidence[]; resources: ManagementResource[]; extension_rates: ManagementRate[]
  extension_cost_group: string; extension_excludes_resource_costs: boolean
  scenarios: ManagementScenario[]; no_action_scenario_id: string; assumptions: string[]; source_refs: string[]
}
export interface ScenarioResult {
  scenario_id: string; input_hash: string; calculator_version: string
  status: 'complete' | 'partial' | 'insufficient_data' | 'invalid_input'
  reference_milestone_at: string | null; scenario_milestone_at: string | null
  incremental_delay_work_hours: DecimalValue | null; deadline_variance_work_hours: DecimalValue | null
  idle_cost: DecimalValue | null; extension_cost: DecimalValue | null; intervention_cost: DecimalValue | null
  other_cost: DecimalValue | null; total_cost: DecimalValue | null; currency: string
  cost_components: { id: string; category: string; title: string; amount: DecimalValue | null; currency: string; cost_group: string; source: string; formula: string; inputs: Record<string, unknown> }[]
  affected_tasks: { task_id: string; reference_start_work_hours: DecimalValue; reference_finish_work_hours: DecimalValue; start_work_hours: DecimalValue; finish_work_hours: DecimalValue; start_at: string; finish_at: string }[]
  missing_inputs: string[]; assumptions: string[]; calculation_trace: string[]
}
export interface EvidenceAssessment {
  verdict: 'supported_risk' | 'needs_review' | 'insufficient_evidence'
  observations: { claim: string; source_refs: string[] }[]
  hypotheses: { claim: string; supporting_refs: string[]; missing_checks: string[] }[]
  unsupported_claims: string[]; missing_inputs: string[]
}
export interface DecisionProposal {
  recommended_scenario_id: string | null
  alternatives: { scenario_id: string; rationale: string; metric_refs: string[]; assumptions: string[] }[]
  proposed_action: { type: 'intervene' | 'observe' | 'request_data'; title: string; suggested_due_at: string | null; verification_condition: string }
  required_human_inputs: string[]; source_refs: string[]
}
export interface ReviewResult {
  status: 'passed' | 'needs_revision' | 'insufficient_data'
  issues: { code: string; affected_claim: string; source_refs: string[]; suggested_fix: string }[]
  validated_scenario_ids: string[]; unresolved_assumptions: string[]
}
export interface ManagementComparison {
  recommended_scenario_id: string | null; net_avoidable_cost: DecimalValue | null; currency: string; criterion: string
}
export interface ManagementStep {
  generation?: 'llm' | 'deterministic'
  role: string; status: string; result: unknown; error: string | null; started_at: string | null; finished_at: string | null
  provider: string | null; model: string | null; prompt_version: string | null; attempts: number; llm_calls: number
}
export interface ManagementRunSummary {
  id: string; project_id: string; incident_id: string | null; as_of: string; mode: AnalysisMode
  status: 'queued' | 'running' | 'completed' | 'partial' | 'needs_input' | 'failed'
  created_at: string; comparison?: ManagementComparison | null; assessment?: EvidenceAssessment | null
}
export interface ManagementRun extends ManagementRunSummary {
  effective_mode?: 'deterministic' | 'llm' | 'partial'
  incident?: { id: string; code: string; status: string; title: string } | null
  snapshot: ManagementSnapshot; results: ScenarioResult[]; assessment: EvidenceAssessment | null
  proposal: DecisionProposal | null; review: ReviewResult | null; comparison: ManagementComparison | null
  steps: ManagementStep[]; error: string | null; parent_run_id: string | null
}
export interface ManagementProfile { snapshot: ManagementSnapshot | null; updated_at: string | null; updated_by: string | null }
export interface CostBasis {
  title: string; category: string; amount: string | null; currency: string; source: string
  rate: string | null; unit: string | null; multiplier: string | null; units: string | null
  confirmation: string | null; period_start: string | null; period_end: string | null
}
export interface InactionPoint {
  basis?: CostBasis[]
  work_hours: string; cost: string | null; delay_work_hours: string | null
  idle_cost: string | null; extension_cost: string | null; intervention_cost: string | null; other_cost: string | null
}
export interface InactionCurve {
  incident_id: string; title: string; status: 'complete' | 'partial' | 'unavailable'
  as_of?: string; data_mode?: 'demo' | 'user'; currency?: string
  horizon_work_hours?: string; points: InactionPoint[]; evidence_supported?: boolean
  message?: string; is_actual_damage: false
  needs?: string[]; incident_code?: string; responsible?: string | null; project_owner?: string | null
  observed_since?: string; horizon_source?: string; schedule_version?: string; timezone?: string
}

function errorDetail(data: unknown): string {
  if (typeof data === 'string') return data
  if (Array.isArray(data)) return data.map(errorDetail).join('; ')
  if (data && typeof data === 'object') {
    const item = data as Record<string, unknown>
    if (typeof item.msg === 'string') return `${Array.isArray(item.loc) ? item.loc.join('.') + ': ' : ''}${item.msg}`
    if (typeof item.message === 'string') return item.message
    if ('detail' in item) return errorDetail(item.detail)
  }
  return 'Сервер не смог обработать запрос'
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_PREFIX}${path}`, {
    ...options, headers: { 'Content-Type': 'application/json', ...getAuthHeaders(), ...options.headers },
  })
  if (!response.ok) {
    const detail: unknown = await response.json().catch(() => null)
    throw new Error(`${errorDetail(detail)} (HTTP ${response.status})`)
  }
  return response.json() as Promise<T>
}
const projectPath = (id: string) => `/projects/${encodeURIComponent(id)}/management`
export const managementApi = {
  inactionCost: (incidentId: string, signal?: AbortSignal) => request<InactionCurve>(`/incidents/${encodeURIComponent(incidentId)}/inaction-cost`, { signal }),
  demo: (projectId: string, episode: DemoEpisode) => request<ManagementSnapshot>(`${projectPath(projectId)}/demo?episode=${episode}`),
  profile: (projectId: string, signal?: AbortSignal) => request<ManagementProfile>(`${projectPath(projectId)}/profile`, { signal }),
  saveProfile: (projectId: string, snapshot: ManagementSnapshot) => request<ManagementProfile>(`${projectPath(projectId)}/profile`, { method: 'PUT', body: JSON.stringify({ snapshot }) }),
  runs: (projectId: string, signal?: AbortSignal) => request<ManagementRunSummary[]>(`${projectPath(projectId)}/risks`, { signal }),
  run: (id: string, signal?: AbortSignal) => request<ManagementRun>(`/management/runs/${encodeURIComponent(id)}`, { signal }),
  create: (snapshot: ManagementSnapshot, mode: AnalysisMode, idempotencyKey: string, parentRunId: string | null) => request<ManagementRun>('/management/runs', {
    method: 'POST', body: JSON.stringify({ snapshot, mode, idempotency_key: idempotencyKey, parent_run_id: parentRunId }),
  }),
}
