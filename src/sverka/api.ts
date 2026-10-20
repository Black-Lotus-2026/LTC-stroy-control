/*
 * API client for the new interface. Unlike the legacy client it never substitutes demo data:
 * a failed request throws, and the screen shows what went wrong.
 */
import { API_BASE_URL, API_PREFIX, getAuthHeaders, getStoredToken, setStoredToken } from '../api/stroyControlApi'
import type { AdminRecipient, AlertNotificationItem, CameraItem, IncidentEventItem, ProjectAlertSettings, ProjectItem, StageItem, UserProfile, ZoneItem } from '../api/stroyControlApi'
import type { CostBasis, InactionCurve, InactionPoint } from '../api/managementApi'
import type { PprCitation } from './pprApi'

export type { AdminRecipient, CameraItem, CostBasis, InactionCurve, InactionPoint, ProjectItem, StageItem, UserProfile, ZoneItem }
export type ApiAlert = AlertNotificationItem
export type ApiIncidentEvent = IncidentEventItem
export type AlertSettings = ProjectAlertSettings

export class ApiError extends Error {
  status: number
  code?: string
  constructor(message: string, status: number, code?: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function authHeaders(): Record<string, string> {
  return getAuthHeaders()
}

export async function req<T>(path: string, init: RequestInit = {}, fallbackMessage = 'Сервер не ответил'): Promise<T> {
  let res: Response
  let timer: ReturnType<typeof setTimeout> | null = null
  let controller: AbortController | null = null
  let signal = init.signal
  if (!signal) {
    controller = new AbortController()
    signal = controller.signal
    timer = setTimeout(() => controller?.abort(), 15000)
  }
  try {
    res = await fetch(`${API_PREFIX}${path}`, { ...init, signal, headers: { ...authHeaders(), ...(init.headers || {}) } })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      if (controller?.signal.aborted) throw new ApiError('Сервер не ответил вовремя. Попробуйте обновить страницу.', 0)
      throw error
    }
    throw new ApiError('Нет связи с сервером. Проверьте, что API запущен.', 0)
  } finally {
    if (timer) clearTimeout(timer)
  }
  if (!res.ok) {
    let msg = fallbackMessage
    let code: string | undefined
    try {
      const body = await res.json()
      const d = body?.detail ?? body?.error?.message
      if (typeof body?.error?.code === 'string') code = body.error.code
      else if (typeof d?.code === 'string') code = d.code
      if (typeof d === 'string') msg = d
      else if (typeof d?.message === 'string') msg = d.message
      else if (Array.isArray(d) && d[0]?.msg) msg = d[0].msg
    } catch {
      // body is not JSON
    }
    throw new ApiError(msg, res.status, code)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

export const mediaUrl = (u?: string | null) => {
  if (!u) return undefined
  if (u.startsWith('data:') || u.startsWith('blob:')) return u
  if (u.startsWith('/media')) return `${API_BASE_URL}${u}`
  try {
    const p = new URL(u)
    if (p.pathname.startsWith('/media')) return `${API_BASE_URL}${p.pathname}${p.search}`
    return p.toString()
  } catch {
    return u
  }
}

/* auth */
interface TokenResponse { access_token: string; user: UserProfile }
export async function login(username: string, password: string) {
  const r = await req<TokenResponse>('/auth/login', json('POST', { username, password }), 'Неверный логин или пароль')
  setStoredToken(r.access_token)
  return r.user
}
export async function register(username: string, password: string, confirm: string, role: string = 'manager') {
  const r = await req<TokenResponse>('/auth/register', json('POST', { username, password, confirm_password: confirm, role }), 'Не удалось зарегистрироваться')
  setStoredToken(r.access_token)
  return r.user
}
export async function me(): Promise<UserProfile | null> {
  if (!getStoredToken()) return null
  try {
    return await req<UserProfile>('/auth/me')
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      setStoredToken(null)
      return null
    }
    throw e
  }
}
export const logout = () => setStoredToken(null)
export const setMyEmail = (email: string | null) => req<UserProfile>('/auth/me/email', json('PATCH', { email }), 'Не удалось сохранить email')
export const admins = () => req<AdminRecipient[]>('/auth/admins')

/* projects, zones, cameras */
export const projects = () => req<ProjectItem[]>('/projects')
export const createProject = (data: { name: string; address?: string; object_kind?: string; owner_username?: string }) =>
  req<ProjectItem>('/projects', json('POST', data), 'Не удалось создать объект')
export const updateProject = (projectId: string, data: { name?: string; code?: string; address?: string; object_kind?: string }) =>
  req<ProjectItem>(`/projects/${projectId}`, json('PATCH', data), 'Не удалось сохранить объект')
export const deleteProject = (projectId: string) => req<void>(`/projects/${projectId}`, { method: 'DELETE' }, 'Не удалось удалить объект')
/** Who answers for the object's events, how long they have, and whom an overdue one goes to. */
export const alertSettings = (projectId: string) => req<AlertSettings>(`/projects/${projectId}/alert-settings`)
export const saveAlertSettings = (projectId: string, data: Omit<AlertSettings, 'project_id'>) =>
  req<AlertSettings>(`/projects/${projectId}/alert-settings`, json('PUT', data), 'Не удалось сохранить сроки')
export const zones = (projectId: string) => req<ZoneItem[]>(`/projects/${projectId}/zones`)
export const createZone = (projectId: string, data: { name: string; code?: string; description?: string }) =>
  req<ZoneItem>(`/projects/${projectId}/zones`, json('POST', data), 'Не удалось создать зону')
export const updateZone = (projectId: string, zoneId: string, data: { name?: string; code?: string; description?: string }) =>
  req<ZoneItem>(`/projects/${projectId}/zones/${zoneId}`, json('PATCH', data), 'Не удалось сохранить зону')
export const deleteZone = (projectId: string, zoneId: string) => req<void>(`/projects/${projectId}/zones/${zoneId}`, { method: 'DELETE' }, 'Не удалось удалить зону')
export const cameras = (projectId: string) => req<CameraItem[]>(`/projects/${projectId}/cameras`)
export const createCamera = (projectId: string, data: { name: string; code?: string; stream_url: string; zone_id?: string | null }) =>
  req<CameraItem>(`/projects/${projectId}/cameras`, json('POST', data), 'Не удалось сохранить камеру')
export const updateCamera = (projectId: string, cameraId: string, data: { name: string; code?: string; stream_url?: string; zone_id: string | null }) =>
  req<CameraItem>(`/projects/${projectId}/cameras/${cameraId}`, json('PATCH', data), 'Не удалось сохранить камеру')
export const deleteCamera = (projectId: string, cameraId: string) =>
  req<void>(`/projects/${projectId}/cameras/${cameraId}`, { method: 'DELETE' }, 'Не удалось удалить камеру')

export interface StreamCheck { status: 'online' | 'offline' | 'warning' | 'unknown'; protocol?: string; message?: string; error?: string; suggestion?: string }
export const checkStream = (cameraId: string) => req<StreamCheck>(`/videos/check-stream?camera_id=${encodeURIComponent(cameraId)}`)
export const proxyUrl = (cameraId: string) => `${API_PREFIX}/videos/proxy-stream?camera_id=${encodeURIComponent(cameraId)}`
/** Read one bounded frame from an authorized persisted camera and close MJPEG immediately. */
export async function grabFrame(cameraId: string, timeoutMs = 12000): Promise<HTMLImageElement> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let imageUrl = ''
  try {
    const response = await fetch(proxyUrl(cameraId), { signal: controller.signal, headers: authHeaders() })
    if (!response.ok) throw new ApiError('Кадр камеры недоступен в текущем назначении.', response.status)
    const reader = response.body?.getReader()
    if (!reader) throw new ApiError('Камера не прислала изображение.', 0)
    let bytes = new Uint8Array(0)
    let payload: Uint8Array | null = null
    let jpegStart = -1
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) { if (response.headers.get('Content-Type')?.startsWith('image/')) payload = bytes; break }
        const previous = bytes.length
        const joined = new Uint8Array(previous + chunk.value.length); joined.set(bytes); joined.set(chunk.value, previous); bytes = joined
        if (bytes.length > 8 * 1024 * 1024) throw new ApiError('Кадр камеры превышает 8 МБ.', 0)
        for (let offset = Math.max(0, previous - 1); offset + 1 < bytes.length; offset++) {
          if (jpegStart < 0 && bytes[offset] === 0xff && bytes[offset + 1] === 0xd8) jpegStart = offset
          if (jpegStart >= 0 && bytes[offset] === 0xff && bytes[offset + 1] === 0xd9) { payload = bytes.slice(jpegStart, offset + 2); break }
        }
        if (payload) break
      }
    } finally { await reader.cancel().catch(() => undefined) }
    if (!payload?.length) throw new ApiError('Камера не прислала полный кадр.', 0)
    imageUrl = URL.createObjectURL(new Blob([payload.slice().buffer], { type: jpegStart >= 0 ? 'image/jpeg' : response.headers.get('Content-Type') || 'image/jpeg' }))
    const image = new Image()
    image.decoding = 'async'
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new ApiError('Изображение камеры не удалось прочитать.', 0))
      image.src = imageUrl
    })
    try {
      await image.decode()
    } catch {
      // image ready
    }
    const toRevoke = imageUrl
    imageUrl = ''
    setTimeout(() => {
      try { URL.revokeObjectURL(toRevoke) } catch { /* ignore */ }
    }, 10000)
    return image
  } catch (error) {
    if (controller.signal.aborted) throw new ApiError('Камера не прислала кадр вовремя.', 0)
    throw error
  } finally {
    clearTimeout(timer)
    if (imageUrl) {
      try { URL.revokeObjectURL(imageUrl) } catch { /* ignore */ }
    }
  }
}
/** Connection probes use the saved camera identity and server network policy. */
export async function probeCamera(cameraId: string): Promise<{ ok: boolean; message: string }> {
  const result = await checkStream(cameraId)
  return { ok: result.status === 'online', message: result.message || result.error || 'Кадр не получен.' }
}

/* schedule */
export interface ImportResult { total_stages_imported: number; matched_catalog_count: number; stages: StageItem[] }
export const stages = (projectId: string) => req<StageItem[]>(`/schedule/stages?project_id=${projectId}`)
export const loadDemoPlan = (projectId: string) => req<ImportResult>(`/schedule/load-demo?project_id=${projectId}`, { method: 'POST' }, 'Не удалось загрузить пример плана')
export function uploadPlan(projectId: string, file: File) {
  const fd = new FormData()
  fd.append('file', file)
  return req<ImportResult>(`/schedule/upload?project_id=${projectId}`, { method: 'POST', body: fd }, 'Не удалось разобрать файл плана')
}

export interface ApiMachinery {
  machinery_code: string
  machinery_name_ru: string
  probability: number
  classification: 'MANDATORY' | 'RECOMMENDED' | 'NEUTRAL' | 'UNCHARACTERISTIC'
  requirement_level: string
  source?: 'catalog' | 'document' | 'manual'
  basis?: 'ppr' | 'ppr_conflict' | null
  ppr_requirements?: PprCitation[]
}
export interface ApiProfile {
  stage_id: string
  stage_name: string
  matched_catalog_stage?: string | null
  similarity_confidence: number
  probabilities: ApiMachinery[]
  has_custom_override?: boolean
  ppr_revision?: string | null
}
export const updateStage = (stageId: string, data: { planned_start: string; planned_end: string; duration_days: number }) =>
  req<StageItem>(`/schedule/stages/${stageId}`, json('PUT', data), 'Не удалось сохранить сроки этапа')
/** Always scoped to the object: without project_id the server clears the plans of every object. */
export const clearPlan = (projectId: string) => req<{ deleted_count: number }>(`/schedule/clear?project_id=${projectId}`, { method: 'POST' }, 'Не удалось очистить план')

/* POS/PPR document agent */
export type DocumentKind = 'POS' | 'PPR' | 'TER'
export interface ProjectDocument {
  id: string
  kind: DocumentKind
  filename: string
  size_bytes: number
  created_at: string
  chunk_count: number
}
export interface DocumentFinding {
  name: string
  purpose: string
  document_id: string
  document_name: string
  document_kind: DocumentKind
  chunk_id: string
  locator: string
  quote: string
  class_code: string | null
  requirement: 'required' | 'recommended' | 'mentioned'
  review_status: string
  mapping_method?: 'catalog' | 'agent' | 'unmapped'
}
export interface DocumentProposal {
  class_code: string
  class_name: string
  current_probability: number | null
  baseline_probability: number | null
  proposed_probability: number | null
  status: 'ready' | 'conflict' | 'manual_override' | 'unchanged'
  source: string
  change_kind?: 'document_requirement' | 'replaced_baseline'
  evidence: DocumentFinding[]
}
export interface DocumentStageResult {
  stage_id: string
  stage_name: string
  summary: string
  reviewed_chunks: number
  status: 'completed' | 'failed'
  error?: string
  findings: DocumentFinding[]
  proposals: DocumentProposal[]
  trace?: { step: string; selected_chunks?: number; claims?: number; accepted?: number; proposals?: number; terms?: string[]; status?: string }[]
}
export interface DocumentRun {
  id: string
  project_id: string
  status: 'queued' | 'running' | 'completed' | 'partial' | 'failed'
  stage_count: number
  completed_count: number
  created_at: string
  error: string | null
  result: {
    stages: DocumentStageResult[]
    applied: { stage_id: string; class_code: string; applied_at: string; mode?: 'automatic' | 'manual'; change_kind?: 'document_requirement' | 'replaced_baseline'; previous_probability?: number | null; new_probability?: number; reverted_at?: string }[]
    auto_apply?: { applied_count: number; skipped: { stage_id?: string; class_code?: string; reason: string }[]; finished_at: string }
  }
}
export interface DocumentAgentStatus { provider: 'openai_compatible' | 'gigachat'; configured: boolean; key_configured: boolean; model: string }
export type DocumentSelection = { stage_id: string; class_code: string }
export const documents = (projectId: string) => req<ProjectDocument[]>(`/projects/${projectId}/documents`)
export const documentAgentStatus = (projectId: string) => req<DocumentAgentStatus>(`/projects/${projectId}/documents/agent-status`)
export const latestDocumentRun = (projectId: string) => req<DocumentRun | null>(`/projects/${projectId}/documents/analysis-runs/latest`)
export const documentRuns = (projectId: string) => req<DocumentRun[]>(`/projects/${projectId}/documents/analysis-runs`)
export const documentRun = (projectId: string, runId: string) => req<DocumentRun>(`/projects/${projectId}/documents/analysis-runs/${runId}`)
export const analyzeDocuments = (projectId: string) => req<DocumentRun>(`/projects/${projectId}/documents/analyze-plan`, { method: 'POST' }, 'Не удалось запустить анализ')
export const applyDocumentProposals = (projectId: string, runId: string, selections: DocumentSelection[]) =>
  req<DocumentRun>(`/projects/${projectId}/documents/analysis-runs/${runId}/apply`, json('POST', { selections }), 'Не удалось применить предложения')
export const revertDocumentProposals = (projectId: string, runId: string, selections: DocumentSelection[]) =>
  req<DocumentRun>(`/projects/${projectId}/documents/analysis-runs/${runId}/revert`, json('POST', { selections }), 'Не удалось отменить изменения')
export const uploadDocument = (projectId: string, file: File, kind: DocumentKind) => {
  const body = new FormData()
  body.append('file', file)
  body.append('kind', kind)
  return req<ProjectDocument>(`/projects/${projectId}/documents`, { method: 'POST', body }, 'Не удалось загрузить документ')
}
export const deleteDocument = (projectId: string, documentId: string) =>
  req<void>(`/projects/${projectId}/documents/${documentId}`, { method: 'DELETE' }, 'Не удалось удалить документ')
export async function downloadDocument(projectId: string, doc: ProjectDocument) {
  const response = await fetch(`${API_PREFIX}/projects/${projectId}/documents/${doc.id}/file`, { headers: authHeaders() })
  if (!response.ok) throw new ApiError('Не удалось скачать документ', response.status)
  const url = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = doc.filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 60000)
}
export const profile = (stageId: string) => req<ApiProfile>(`/schedule/stages/${stageId}/probabilities`)
export const pprControlRevision = (projectId: string, signal?: AbortSignal) => req<{ revision: string }>(`/projects/${encodeURIComponent(projectId)}/ppr-control-revision`, { signal })
export const putOverrides = (stageId: string, overrides: Record<string, unknown>) =>
  req<ApiProfile>(`/schedule/stages/${stageId}/probabilities`, json('PUT', { overrides }), 'Не удалось сохранить правило')

/* detection */
export interface ApiDetection { raw_label: string; canonical_code: string; label_ru: string; confidence: number; x1: number; y1: number; x2: number; y2: number }
export interface DetectResponse { compliance_enabled?: boolean; evaluable_classes?: string[]; model_ready: boolean; detector_status: string; message?: string | null; detections: ApiDetection[]; source?: 'yolo' | 'vlm'; fallback_status?: 'not_requested' | 'not_needed' | 'used' | 'empty' | 'unavailable' | 'timeout' | 'error'; fallback_message?: string | null; model_sha256?: string | null; confidence_calibrated?: false }
export async function detectFrame(
  blob: Blob,
  stageName?: string,
  safety?: { projectId: string; cameraId: string; sourceId: string; positionMs: number; recordingMode?: boolean },
  projectId?: string,
): Promise<DetectResponse> {
  const fd = new FormData()
  fd.append('file', blob, 'frame.jpg')
  if (stageName) fd.append('stage_name', stageName)
  const pid = safety?.projectId || projectId
  const regularPath = pid ? `/videos/detect-frame?project_id=${encodeURIComponent(pid)}` : '/videos/detect-frame'

  if (safety) {
    const sfd = new FormData()
    sfd.append('file', blob, 'frame.jpg')
    if (stageName) sfd.append('stage_name', stageName)
    sfd.append('camera_id', safety.cameraId)
    sfd.append('source_id', safety.sourceId)
    sfd.append('position_ms', String(Math.round(safety.positionMs)))
    sfd.append('recording_mode', String(safety.recordingMode === true))
    try {
      return await req<DetectResponse>(
        `/safety/projects/${encodeURIComponent(safety.projectId)}/analyze-frame`,
        { method: 'POST', body: sfd },
      )
    } catch {
      // Fallback to direct detection so machinery recognition never fails
    }
  }

  return req<DetectResponse>(regularPath, { method: 'POST', body: fd }, 'Сервис распознавания не ответил')
}
/** Only still photos may request the server's photo-specific VLM fallback. */
export function detectPhoto(file: File, projectId?: string) {
  const fd = new FormData()
  fd.append('file', file, file.name)
  const path = projectId ? `/videos/detect-photo?project_id=${encodeURIComponent(projectId)}` : '/videos/detect-photo'
  return req<DetectResponse>(path, { method: 'POST', body: fd }, 'Не удалось распознать фото')
}
export interface DetectorStatus { compliance_enabled?: boolean; evaluable_classes?: string[]; ready: boolean; status: string; message?: string | null; supported_classes: string[] }
export const detectorStatus = () => req<DetectorStatus>('/videos/detector-status')

export interface VideoAsset { video_id: string; filename: string; start_timestamp: string; duration_seconds: number }
export interface SavedVideo extends VideoAsset { media_url: string; camera_id: string | null; analysis_status?: 'PENDING' | 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED'; analysis_error?: string | null; analyzed_at?: string | null }
export const savedVideos = (projectId: string) => req<SavedVideo[]>(`/videos?project_id=${encodeURIComponent(projectId)}`, {}, 'Не удалось загрузить сохранённые записи')
export function uploadVideo(projectId: string, file: File, startIso: string, areaId?: string) {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('start_timestamp', startIso)
  if (areaId) fd.append('area_id', areaId)
  return req<VideoAsset>(`/videos/upload?project_id=${projectId}`, { method: 'POST', body: fd }, 'Не удалось сохранить запись на сервере')
}

/* incidents */
export interface ApiIncident {
  id: string
  code: string
  project_id: string
  ppr_requirements?: PprCitation[]
  stage_id?: string | null
  stage_name?: string | null
  zone_name?: string | null
  camera_name?: string | null
  camera_id?: string | null
  title?: string | null
  description?: string | null
  severity: 'ERROR' | 'WARNING' | 'NEUTRAL'
  discrepancy_type: string
  machinery_type?: string | null
  stage_probability?: number | null
  status?: string | null
  snapshot_url?: string | null
  album_photos?: { url: string; camera_name?: string; is_primary?: boolean; captured_at?: string }[]
  created_at: string
  zone_id?: string | null
  /** when it was first observed (the filmed time for a recording) */
  first_seen_at?: string | null
  observed_count?: number
  /** the task: who answers for it and by when */
  assigned_user_id?: string | null
  assignee_name?: string | null
  sla_deadline?: string | null
  /** pending → requested → passed | failed | unavailable: the server rechecks the cameras */
  verification_status?: string
  last_checked_at?: string | null
  escalated_at?: string | null
  verification_details?: {
    working_cameras?: number
    configured_cameras?: number
    observed_machinery?: string[]
    checked_at?: string
    reason?: string
    /** a camera view recheck: the match of each fresh frame with the approved view */
    view_match?: number[]
    /** how the event closed: a camera view accepted (new view approved) or restored (camera put back); a loop when an administrator saw the live picture */
    resolution?: 'accepted' | 'restored' | 'admin_confirmed_live'
    resolved_by?: string
  }
}
export interface IncidentCreate {
  project_id: string
  ppr_revision?: string | null
  stage_id?: string | null
  stage_name?: string | null
  zone_id?: string | null
  zone_name?: string | null
  camera_id?: string | null
  camera_name?: string | null
  /** the observed time; without it the server dates the event by when it got it */
  captured_at?: string
  /** the same key twice is one observation, so a retry does not count it again */
  observation_key?: string
  model_status?: 'valid' | 'unavailable' | 'failed'
  severity: 'ERROR' | 'WARNING'
  discrepancy_type: 'MISSING_MANDATORY' | 'MISSING_RECOMMENDED' | 'UNCHARACTERISTIC_PRESENT' | 'STREAM_OFFLINE' | 'STREAM_LOST' | 'STREAM_ONLINE' | 'STREAM_LOOP' | 'VIEW_CHANGED'
  machinery_type?: string | null
  stage_probability?: number
  observed_count?: number
  title: string
  description: string
  album_snapshots?: { camera_name: string; snapshot_base64: string; is_primary?: boolean }[]
}
/** The server gives at most 500 latest events of an object. */
export const JOURNAL_LIMIT = 500
export const incidents = (projectId: string) => req<ApiIncident[]>(`/incidents?project_id=${projectId}&limit=${JOURNAL_LIMIT}`)
export const createIncident = (data: IncidentCreate) => req<ApiIncident>('/incidents', json('POST', data), 'Не удалось сохранить событие')
/** `resolved` does not close the event: it asks the server to recheck the cameras. `keepalive` lets a decision leave with the page. */
export const setIncidentStatus = (id: string, status: string, keepalive = false) =>
  req<ApiIncident>(`/incidents/${id}/status`, { ...json('PATCH', { status }), keepalive }, 'Не удалось сохранить решение')
export const incidentEvents = (id: string) => req<ApiIncidentEvent[]>(`/incidents/${id}/events`, {}, 'История события не загрузилась')
/** A scenario estimate for this event only; reading it calls no model and changes nothing. */
export const inactionCost = (id: string, signal?: AbortSignal) => req<InactionCurve>(`/incidents/${id}/inaction-cost`, { signal }, 'Расчёт не загрузился')

/* weather: a seven-day forecast for the object's address. Servers without it answer 404. */
export interface WeatherDay {
  forecast_date: string
  fetched_at: string
  weather_code: number | null
  temperature_min_c: number | null
  temperature_max_c: number | null
  precipitation_mm: number | null
  snowfall_cm: number | null
  wind_gust_kmh: number | null
  conditions: string[]
  warnings: string[]
}
export interface Weather { project_id: string; timezone: string; location_configured: boolean; resolved_address: string | null; days: WeatherDay[] }
export const weather = (projectId: string) => req<Weather>(`/projects/${projectId}/weather`, {}, 'Прогноз не загрузился')
/** Asks the weather service again (and finds the address if it changed). */
export const refreshWeather = (projectId: string) => req<Weather>(`/projects/${projectId}/weather/refresh`, { method: 'POST' }, 'Прогноз не обновился')

/* tasks: the user's inbox of assignments, escalations and confirmed fixes */
export const alerts = () => req<ApiAlert[]>('/alerts?limit=100')
export const markAlertRead = (id: string) => req<ApiAlert>(`/alerts/${id}/read`, { method: 'PATCH' }, 'Не удалось отметить уведомление')
export const resetProfile = (stageId: string) =>
  req<ApiProfile>(`/schedule/stages/${stageId}/probabilities`, { method: 'DELETE' }, 'Не удалось сбросить профиль')
export const incidentConfig = () => req<{ violation_evaluation_window_seconds: number }>('/incidents/config')
export const setIncidentConfig = (seconds: number) =>
  req<{ violation_evaluation_window_seconds: number }>('/incidents/config', json('PATCH', { violation_evaluation_window_seconds: seconds }), 'Не удалось сохранить окно сверки')

/* camera view: the approved reference, proposals of a new view, agreed moves. The administrator decides. */
export interface ViewPhoto { url: string; sha256?: string | null; at?: string | null; by?: string | null; by_id?: string | null; note?: string | null }
export interface ViewMove { status: 'requested' | 'approved'; until: string; reason: string; by?: string | null; by_id?: string | null; at?: string | null; approved_by?: string | null; approved_at?: string | null }
export interface ViewHistoryItem { kind: string; at: string; by?: string | null; note?: string | null; url?: string | null; until?: string | null }
export interface CameraViewState {
  camera_id: string
  camera_name: string
  reference: ViewPhoto | null
  proposal: ViewPhoto | null
  move: ViewMove | null
  history: ViewHistoryItem[]
  match_ok: number
  match_bad: number
}
const viewPath = (projectId: string, cameraId: string) => `/projects/${projectId}/cameras/${cameraId}/view`
export const cameraViews = (projectId: string) => req<CameraViewState[]>(`/projects/${projectId}/camera-views`, {}, 'Ракурсы камер не загрузились')
/** An administrator approves at once; anyone else sends the view for approval. */
export const submitView = (projectId: string, cameraId: string, snapshot: string, note?: string) =>
  req<CameraViewState>(`${viewPath(projectId, cameraId)}/reference`, json('PUT', { snapshot_base64: snapshot, note: note || null }), 'Ракурс не сохранён')
export const approveView = (projectId: string, cameraId: string, sha256: string) => req<CameraViewState>(`${viewPath(projectId, cameraId)}/reference/approve`, { method: 'POST', headers: { 'If-Match': sha256 } }, 'Ракурс не утверждён')
export const rejectView = (projectId: string, cameraId: string, note?: string) => req<CameraViewState>(`${viewPath(projectId, cameraId)}/reference/reject`, json('POST', { note: note || null }), 'Не удалось отклонить')
export const requestMove = (projectId: string, cameraId: string, until: string, reason: string) =>
  req<CameraViewState>(`${viewPath(projectId, cameraId)}/move`, json('POST', { until, reason }), 'Перенос не сохранён')
export const approveMove = (projectId: string, cameraId: string) => req<CameraViewState>(`${viewPath(projectId, cameraId)}/move/approve`, { method: 'POST' }, 'Перенос не согласован')
export const rejectMove = (projectId: string, cameraId: string, note?: string) => req<CameraViewState>(`${viewPath(projectId, cameraId)}/move/reject`, json('POST', { note: note || null }), 'Не удалось отклонить')
export const cancelMove = (projectId: string, cameraId: string) => req<CameraViewState>(`${viewPath(projectId, cameraId)}/move`, { method: 'DELETE' }, 'Перенос не отменён')
/** The approved frame itself, to compare against in this browser. */
export async function viewImage(url: string) {
  return createImageBitmap(await viewAsset(url))
}
/** Authenticated same-server assets; credentials never follow external image links. */
export async function viewAsset(url: string, signal?: AbortSignal): Promise<Blob> {
  const apiPath = new URL(API_PREFIX, 'https://view.invalid').pathname.replace(/\/$/, '')
  const suffix = url.startsWith(`${apiPath}/`) ? url.slice(apiPath.length) : ''
  const protectedAsset = /^\/projects\/[a-zA-Z0-9_-]+\/cameras\/[a-zA-Z0-9_-]+\/view\/assets\/[a-fA-F0-9]{64}$/.test(suffix)
  const mediaPath = url.startsWith('/media/') ? url : API_BASE_URL && url.startsWith(`${API_BASE_URL}/media/`) ? url.slice(API_BASE_URL.length) : ''
  const protectedMedia = /^\/media\/[a-zA-Z0-9_./-]+$/.test(mediaPath) && !mediaPath.split('/').some(part => part === '..' || part === '.')
  if (mediaPath && !protectedMedia) throw new ApiError('Ссылка на материал недопустима', 0)
  if (url.includes('/view/assets/') && !protectedAsset) throw new ApiError('Ссылка на утверждённый кадр недопустима', 0)
  const res = await fetch(protectedAsset ? `${API_PREFIX}${suffix}` : mediaUrl(url)!, { signal, headers: protectedAsset || protectedMedia ? authHeaders() : {} })
  if (!res.ok) throw new ApiError('Утверждённый кадр не загрузился', res.status)
  return res.blob()
}
