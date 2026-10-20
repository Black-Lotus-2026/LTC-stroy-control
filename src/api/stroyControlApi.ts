/**
 * Stroy-Control Platform Typed API Client.
 *
 * Provides typed methods for:
 * 1. Schedule & Gantt management (upload, demo load, inline edit, cascade delay shift)
 * 2. Video streams & Demo video upload with absolute recording start timestamp
 * 3. Stage machinery probability analytics (StageMachineryService)
 * 4. Incidents & Multi-camera error albums
 */

export interface StageItem {
  id: string
  project_id: string
  name: string
  order_index: number
  planned_start: string
  planned_end: string
  duration_days: number
  matched_catalog_name?: string | null
  catalog_similarity?: number | null
  status: string
}

export type DocumentKind = 'POS' | 'PPR' | 'TER'

export interface ProjectDocumentItem {
  id: string
  kind: DocumentKind
  filename: string
  size_bytes: number
  created_at: string
  chunk_count: number
}

export interface DocumentMachineryItem {
  name: string
  purpose: string
  document_id: string
  document_name: string
  document_kind: DocumentKind
  chunk_id: string
  locator: string
  quote: string
}

export interface DocumentAnalysis {
  stage_id: string
  summary: string
  reviewed_chunks: number
  document_count: number
  items: DocumentMachineryItem[]
}

export interface CascadeShiftResponse {
  delayed_stage_id: string
  delay_days: number
  shifted_stage_count: number
  updated_stages: StageItem[]
  message: string
}

export interface VideoAsset {
  video_id: string
  filename: string
  start_timestamp: string
  duration_seconds: number
  fps: number
  status: 'UPLOADED' | 'PROCESSING' | 'READY' | 'FAILED'
  message?: string
}

export interface VideoSyncStatus {
  video_id: string
  playback_seconds: number
  current_timestamp: string
  active_stage_id?: string | null
  active_stage_name?: string | null
  is_out_of_schedule: boolean
}

export interface MachineryProbabilityItem {
  machinery_code: string
  machinery_name_ru: string
  probability: number
  classification: 'MANDATORY' | 'RECOMMENDED' | 'NEUTRAL' | 'UNCHARACTERISTIC'
  requirement_level: string
}

export interface StageProbabilityResponse {
  stage_id: string
  stage_name: string
  matched_catalog_stage?: string | null
  similarity_confidence: number
  probabilities: MachineryProbabilityItem[]
  top_machinery: string[]
  has_custom_override?: boolean
}

export interface IncidentAlertItem {
  id: string
  code: string
  zone_id?: string | null
  first_seen_at?: string
  confidence?: number
  project_id?: string
  stage_id?: string | null
  stage_name?: string | null
  zone_name?: string | null
  camera_name?: string | null
  title?: string | null
  description?: string | null
  severity: 'ERROR' | 'WARNING' | 'NEUTRAL'
  discrepancy_type: 'MISSING_MANDATORY' | 'MISSING_RECOMMENDED' | 'UNCHARACTERISTIC_PRESENT' | 'NEUTRAL_INFO' | string
  status?: string | null
  assigned_user_id?: string | null
  assignee_name?: string | null
  sla_deadline?: string | null
  verification_status?: string
  last_checked_at?: string | null
  escalated_at?: string | null
  verification_details?: Record<string, unknown>
  machinery_type?: string
  stage_probability?: number
  observed_count?: number
  frame_snapshot_url?: string | null
  snapshot_url?: string | null
  album_photos?: { url: string; camera_name?: string; is_primary?: boolean; captured_at?: string }[]
  manual_override?: boolean
  created_at?: string
}

export interface IncidentCreatePayload {
  project_id: string
  zone_id?: string | null
  camera_id?: string | null
  captured_at?: string
  model_status?: 'valid' | 'unavailable' | 'failed'
  rule_version?: string
  observation_key?: string
  stage_id?: string | null
  stage_name?: string | null
  zone_name?: string | null
  camera_name?: string | null
  severity: 'ERROR' | 'WARNING'
  discrepancy_type: 'MISSING_MANDATORY' | 'MISSING_RECOMMENDED' | 'UNCHARACTERISTIC_PRESENT' | string
  machinery_type?: string
  stage_probability?: number
  observed_count?: number
  title: string
  description: string
  frame_snapshot_base64?: string | null
  album_snapshots?: { camera_name: string; snapshot_base64: string; is_primary?: boolean }[]
}

export interface IncidentAlbumData {
  incident_id: string
  code: string
  title: string
  stage_name?: string | null
  severity: string
  primary_photo_url?: string | null
  photos: { url: string; camera_name?: string; is_primary?: boolean; captured_at?: string }[]
}

export interface ZoneItem {
  id: string
  project_id: string
  code: string
  name: string
  description?: string | null
  status: string
}

export interface CameraItem {
  id: string
  project_id: string
  zone_id?: string | null
  code: string
  name: string
  stream_url?: string | null
  status: string
}

export interface ProjectItem {
  id: string
  code: string
  name: string
  address?: string | null
  object_kind?: string | null
  status: string
  zones: ZoneItem[]
  cameras: CameraItem[]
  stages_count: number
  owner_username?: string | null
  alert_error_deadline_minutes?: number
  alert_warning_deadline_minutes?: number
  escalation_user_id?: string | null
}

export interface WeatherDay {
  forecast_date: string
  fetched_at: string
  provider: string
  weather_code: number | null
  temperature_min_c: number | null
  temperature_max_c: number | null
  precipitation_mm: number | null
  snowfall_cm: number | null
  wind_gust_kmh: number | null
  conditions: string[]
  warnings: string[]
}

export interface WeatherForecast {
  project_id: string
  timezone: string
  location_configured: boolean
  resolved_address: string | null
  days: WeatherDay[]
}

export function fetchWeather(projectId: string): Promise<WeatherForecast> {
  return checkedJson(`${API_PREFIX}/projects/${projectId}/weather`, {}, 'Не удалось загрузить прогноз')
}

export function refreshWeather(projectId: string): Promise<WeatherForecast> {
  return checkedJson(`${API_PREFIX}/projects/${projectId}/weather/refresh`, { method: 'POST' }, 'Не удалось обновить прогноз')
}

export interface ProjectAlertSettings {
  project_id: string
  owner_username: string | null
  alert_error_deadline_minutes: number
  alert_warning_deadline_minutes: number
  escalation_user_id: string | null
}

export interface AlertNotificationItem {
  id: string
  incident_id: string
  project_id: string
  incident_code: string
  incident_status: string
  assignee_name: string | null
  sla_deadline: string | null
  verification_status: string
  escalated_at: string | null
  kind: 'assigned' | 'verified' | 'escalated'
  title: string
  body: string
  created_at: string
  read_at: string | null
  email_status: string
}

export interface IncidentEventItem {
  id: string
  event_type: string
  comment: string | null
  created_at: string
  user_id: string | null
}

export interface AdminRecipient {
  id: string
  username: string
  name: string
}

function getApiBaseUrl(): string {
  const envUrl = import.meta.env.VITE_API_URL
  if (envUrl && typeof envUrl === 'string') {
    // Windows Docker IPv6 bug: 'localhost' resolves to [::1] which hangs in Docker Windows bridge.
    // Replace localhost with 127.0.0.1 to force direct IPv4 connection.
    return envUrl.replace('://localhost', '://127.0.0.1')
  }
  if (typeof window !== 'undefined') {
    const host = window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname
    return `http://${host}:8000`
  }
  return 'http://127.0.0.1:8000'
}

export const API_BASE_URL = getApiBaseUrl()
export const API_PREFIX = `${API_BASE_URL}/api/v1`

export function normalizeSnapshotUrl(url?: string | null): string | undefined {
  if (!url) return undefined
  let trimmed = url.trim()
  if (!trimmed) return undefined
  // Clean up any double-protocol prefixes like httphttp:// or httpshttps://
  trimmed = trimmed.replace(/^https?https?:\/\//i, 'http://')
  if (trimmed.startsWith('data:')) return trimmed
  if (trimmed.startsWith('/media')) return `${API_BASE_URL}${trimmed}`
  try {
    const parsed = new URL(trimmed)
    if (parsed.pathname.startsWith('/media')) {
      return `${API_BASE_URL}${parsed.pathname}${parsed.search}`
    }
    return parsed.toString()
  } catch {
    if (trimmed.startsWith('http://localhost:8000')) {
      return trimmed.replace('http://localhost:8000', API_BASE_URL)
    }
    if (trimmed.startsWith('http://127.0.0.1:8000')) {
      return trimmed.replace('http://127.0.0.1:8000', API_BASE_URL)
    }
    if (trimmed.includes('://localhost:8000')) {
      return trimmed.replace(/^https?:\/\/localhost:8000/, API_BASE_URL)
    }
  }
  return trimmed
}

export interface UserProfile {
  id: string
  username: string
  name: string
  role: string
  email?: string | null
  created_at: string
}

export interface AuthTokenResponse {
  access_token: string
  token_type: string
  user: UserProfile
}

const TOKEN_KEY = 'stroy_control_token'

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setStoredToken(token: string | null): void {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token)
    } else {
      localStorage.removeItem(TOKEN_KEY)
    }
  } catch {
    // ignore
  }
}

export function getAuthHeaders(): Record<string, string> {
  const token = getStoredToken()
  if (token) {
    return { Authorization: `Bearer ${token}` }
  }
  return {}
}

export async function registerUser(data: {
  username: string
  password: string
  confirm_password: string
}): Promise<AuthTokenResponse> {
  const res = await fetch(`${API_PREFIX}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Ошибка регистрации' }))
    throw new Error(err.detail || 'Ошибка регистрации')
  }
  const result: AuthTokenResponse = await res.json()
  setStoredToken(result.access_token)
  return result
}

export async function loginUser(data: {
  username: string
  password: string
}): Promise<AuthTokenResponse> {
  const res = await fetch(`${API_PREFIX}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Неверный логин или пароль' }))
    throw new Error(err.detail || 'Неверный логин или пароль')
  }
  const result: AuthTokenResponse = await res.json()
  setStoredToken(result.access_token)
  return result
}

export async function fetchCurrentUser(): Promise<UserProfile | null> {
  const token = getStoredToken()
  if (!token) return null
  try {
    const res = await fetch(`${API_PREFIX}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (res.ok) {
      return await res.json()
    }
    if (res.status === 401) {
      setStoredToken(null)
    }
  } catch {
    // offline
  }
  return null
}

export function logoutUser(): void {
  setStoredToken(null)
}

export async function updateMyEmail(email: string | null): Promise<UserProfile> {
  const res = await fetch(`${API_PREFIX}/auth/me/email`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ email }),
  })
  if (!res.ok) throw new Error('Не удалось сохранить email')
  return await res.json()
}

export async function fetchAdminRecipients(): Promise<AdminRecipient[]> {
  const res = await fetch(`${API_PREFIX}/auth/admins`, { headers: getAuthHeaders() })
  if (!res.ok) throw new Error('Не удалось загрузить администраторов')
  return await res.json()
}

export async function updateProjectAlertSettings(
  projectId: string,
  settings: Omit<ProjectAlertSettings, 'project_id'>
): Promise<ProjectAlertSettings> {
  const res = await fetch(`${API_PREFIX}/projects/${projectId}/alert-settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(settings),
  })
  if (!res.ok) {
    const error = await res.json().catch(() => ({}))
    throw new Error(error.detail || 'Не удалось сохранить настройки алертов')
  }
  return await res.json()
}

// ----------------------------------------------------------------------------
// Projects, Construction Sites (Zones), and Cameras API
// ----------------------------------------------------------------------------

async function checkedJson<T>(url: string, init: RequestInit, message: string): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...getAuthHeaders(), ...init.headers } })
  if (!response.ok) {
    const detail = await response.json().catch(() => null)
    throw new Error(typeof detail?.detail === 'string' ? detail.detail : message)
  }
  return response.json() as Promise<T>
}

export async function fetchProjects(): Promise<ProjectItem[]> {
  return checkedJson(`${API_PREFIX}/projects`, {}, 'Не удалось загрузить объекты')
}

export async function createProject(data: {
  name: string
  code?: string
  address?: string
  object_kind?: string
  owner_username?: string
}): Promise<ProjectItem> {
  const res = await fetch(`${API_PREFIX}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Ошибка создания объекта' }))
    throw new Error(err.detail || 'Ошибка создания объекта')
  }
  return await res.json()
}

export async function updateProject(
  projectId: string,
  data: {
    name?: string
    code?: string
    address?: string
    object_kind?: string
    status?: string
  }
): Promise<ProjectItem> {
  const res = await fetch(`${API_PREFIX}/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Ошибка обновления объекта' }))
    throw new Error(err.detail || 'Ошибка обновления объекта')
  }
  return await res.json()
}

export async function deleteProject(projectId: string): Promise<void> {
  const res = await fetch(`${API_PREFIX}/projects/${projectId}`, { method: 'DELETE' })
  if (!res.ok) {
    throw new Error('Ошибка удаления объекта')
  }
}

export async function fetchProjectZones(projectId: string): Promise<ZoneItem[]> {
  return checkedJson(`${API_PREFIX}/projects/${projectId}/zones`, {}, 'Не удалось загрузить площадки')
}

export async function createProjectZone(
  projectId: string,
  data: { name: string; code?: string; description?: string }
): Promise<ZoneItem> {
  const res = await fetch(`${API_PREFIX}/projects/${projectId}/zones`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Ошибка создания стройплощадки' }))
    throw new Error(err.detail || 'Ошибка создания стройплощадки')
  }
  return await res.json()
}

export async function updateZone(
  projectId: string,
  zoneId: string,
  data: {
    name?: string
    code?: string
    description?: string
    status?: string
  }
): Promise<ZoneItem> {
  const res = await fetch(`${API_PREFIX}/projects/${projectId}/zones/${zoneId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Ошибка обновления стройплощадки' }))
    throw new Error(err.detail || 'Ошибка обновления стройплощадки')
  }
  return await res.json()
}

export async function deleteZone(projectId: string, zoneId: string): Promise<void> {
  const res = await fetch(`${API_PREFIX}/projects/${projectId}/zones/${zoneId}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    throw new Error('Ошибка удаления стройплощадки')
  }
}

export async function fetchCameras(projectId?: string): Promise<CameraItem[]> {
  if (!isValidUuid(projectId)) throw new Error('Выберите объект')
  return checkedJson(`${API_PREFIX}/videos/cameras?project_id=${projectId}`, {}, 'Не удалось загрузить камеры')
}

export async function createCamera(
  projectId: string,
  data: { name: string; code?: string; stream_url?: string; zone_id?: string }
): Promise<CameraItem> {
  return checkedJson(`${API_PREFIX}/projects/${projectId}/cameras`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ ...data, zone_id: isValidUuid(data.zone_id) ? data.zone_id : undefined }),
  }, 'Не удалось сохранить камеру')
}

export async function updateCamera(
  projectId: string,
  cameraId: string,
  data: { name?: string; code?: string; stream_url?: string; zone_id?: string | null }
): Promise<CameraItem> {
  return checkedJson(`${API_PREFIX}/projects/${projectId}/cameras/${cameraId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ ...data, zone_id: isValidUuid(data.zone_id) ? data.zone_id : null }),
  }, 'Не удалось сохранить изменения камеры')
}

export async function deleteCamera(projectId: string, cameraId: string): Promise<void> {
  const res = await fetch(`${API_PREFIX}/projects/${projectId}/cameras/${cameraId}`, {
    method: 'DELETE',
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Ошибка удаления камеры' }))
    throw new Error(err.detail || 'Ошибка удаления камеры')
  }
}

/**
 * HTTP(S)/MJPEG cameras are loaded through the backend. This avoids browser
 * CORS restrictions, mixed camera certificates, and untrusted self-signed TLS.
 */
export function getCameraStreamProxyUrl(streamUrl: string): string {
  return `${API_PREFIX}/videos/proxy-stream?url=${encodeURIComponent(streamUrl)}`
}

// ----------------------------------------------------------------------------
// Schedule & Gantt API
// ----------------------------------------------------------------------------

export function isValidUuid(val?: string | null): boolean {
  if (!val) return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(val)
}

export const DEMO_REFERENCE_STAGES: StageItem[] = [
  {
    id: 'stage-1',
    project_id: 'default',
    name: 'Подготовка территории и площадки строительства',
    order_index: 1,
    planned_start: '2026-04-18T00:00:00Z',
    planned_end: '2026-05-01T00:00:00Z',
    duration_days: 14,
    status: 'completed',
  },
  {
    id: 'stage-2',
    project_id: 'default',
    name: 'Выемка грунта котлована под фундамент',
    order_index: 2,
    planned_start: '2026-05-02T00:00:00Z',
    planned_end: '2026-05-22T00:00:00Z',
    duration_days: 21,
    status: 'completed',
  },
  {
    id: 'stage-3',
    project_id: 'default',
    name: 'Устройство бетонной подготовки и фундаментной плиты',
    order_index: 3,
    planned_start: '2026-05-23T00:00:00Z',
    planned_end: '2026-06-16T00:00:00Z',
    duration_days: 25,
    status: 'completed',
  },
  {
    id: 'stage-4',
    project_id: 'default',
    name: 'Устройство монолитных конструкций подземной части',
    order_index: 4,
    planned_start: '2026-06-17T00:00:00Z',
    planned_end: '2026-07-16T00:00:00Z',
    duration_days: 30,
    status: 'completed',
  },
  {
    id: 'stage-5',
    project_id: 'default',
    name: 'Возведение монолитного каркаса 1-9 этажей',
    order_index: 5,
    planned_start: '2026-07-17T00:00:00Z',
    planned_end: '2026-09-14T00:00:00Z',
    duration_days: 60,
    status: 'completed',
  },
  {
    id: 'stage-6',
    project_id: 'default',
    name: 'Кладка наружных стен и внутренних перегородок',
    order_index: 6,
    planned_start: '2026-09-15T00:00:00Z',
    planned_end: '2026-10-24T00:00:00Z',
    duration_days: 40,
    status: 'active',
  },
  {
    id: 'stage-7',
    project_id: 'default',
    name: 'Монтаж кровли и гидроизоляция',
    order_index: 7,
    planned_start: '2026-10-25T00:00:00Z',
    planned_end: '2026-11-18T00:00:00Z',
    duration_days: 25,
    status: 'planned',
  },
  {
    id: 'stage-8',
    project_id: 'default',
    name: 'Фасадные работы и монтаж оконных блоков',
    order_index: 8,
    planned_start: '2026-11-19T00:00:00Z',
    planned_end: '2026-12-23T00:00:00Z',
    duration_days: 35,
    status: 'planned',
  },
  {
    id: 'stage-9',
    project_id: 'default',
    name: 'Благоустройство прилегающей территории и проездов',
    order_index: 9,
    planned_start: '2026-12-24T00:00:00Z',
    planned_end: '2027-01-12T00:00:00Z',
    duration_days: 20,
    status: 'planned',
  },
]

export async function fetchStages(projectId?: string): Promise<StageItem[]> {
  if (!isValidUuid(projectId)) throw new Error('Выберите объект')
  return checkedJson(`${API_PREFIX}/schedule/stages?project_id=${projectId}`, {}, 'Не удалось загрузить график')
}

export async function fetchProjectDocuments(projectId: string): Promise<ProjectDocumentItem[]> {
  return checkedJson(`${API_PREFIX}/projects/${projectId}/documents`, {}, 'Не удалось загрузить документы')
}

export async function uploadProjectDocument(projectId: string, file: File, kind: DocumentKind): Promise<ProjectDocumentItem> {
  const body = new FormData()
  body.append('file', file)
  body.append('kind', kind)
  return checkedJson(`${API_PREFIX}/projects/${projectId}/documents`, { method: 'POST', body }, 'Не удалось загрузить документ')
}

export async function deleteProjectDocument(projectId: string, documentId: string): Promise<void> {
  const response = await fetch(`${API_PREFIX}/projects/${projectId}/documents/${documentId}`, {
    method: 'DELETE', headers: getAuthHeaders(),
  })
  if (!response.ok) throw new Error('Не удалось удалить документ')
}

export async function downloadProjectDocument(projectId: string, item: ProjectDocumentItem): Promise<void> {
  const response = await fetch(`${API_PREFIX}/projects/${projectId}/documents/${item.id}/file`, { headers: getAuthHeaders() })
  if (!response.ok) throw new Error('Не удалось скачать документ')
  const blobUrl = URL.createObjectURL(await response.blob())
  const anchor = document.createElement('a')
  anchor.href = blobUrl
  anchor.download = item.filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 60000)
}

export async function analyzeProjectDocuments(projectId: string, stageId: string): Promise<DocumentAnalysis> {
  return checkedJson(`${API_PREFIX}/projects/${projectId}/documents/analyze`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage_id: stageId }),
  }, 'Не удалось проанализировать документы')
}

export async function loadDemoSchedule(projectId?: string): Promise<StageItem[]> {
  if (!isValidUuid(projectId)) throw new Error('Выберите объект')
  const data = await checkedJson<{ stages: StageItem[] } | StageItem[]>(
    `${API_PREFIX}/schedule/load-demo?project_id=${projectId}`, { method: 'POST' }, 'Не удалось загрузить демо-план'
  )
  return Array.isArray(data) ? data : data.stages
}

export async function uploadScheduleFile(file: File, projectId?: string): Promise<StageItem[]> {
  const formData = new FormData()
  formData.append('file', file)
  if (!isValidUuid(projectId)) throw new Error('Выберите объект')
  const validId = projectId
  const url = validId
    ? `${API_PREFIX}/schedule/upload?project_id=${validId}`
    : `${API_PREFIX}/schedule/upload`
  const res = await fetch(url, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: formData,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Ошибка загрузки графика' }))
    const msg = typeof err.detail === 'string' ? err.detail : 'Ошибка загрузки графика'
    throw new Error(msg)
  }
  const data = await res.json()
  return data.stages || data
}

export async function clearSchedule(projectId?: string): Promise<void> {
  if (!isValidUuid(projectId)) throw new Error('Выберите объект')
  const response = await fetch(`${API_PREFIX}/schedule/clear?project_id=${projectId}`, { method: 'POST', headers: getAuthHeaders() })
  if (!response.ok) throw new Error('Не удалось очистить график')
}

export async function updateStageDates(
  stageId: string,
  data: { name?: string; planned_start?: string; planned_end?: string; duration_days?: number }
): Promise<StageItem> {
  if (!isValidUuid(stageId)) throw new Error('Этап не найден')
  const res = await fetch(`${API_PREFIX}/schedule/stages/${stageId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Ошибка обновления этапа')
  return await res.json()
}

export async function cascadeShiftStages(delayedStageId: string, delayDays: number): Promise<CascadeShiftResponse> {
  if (!isValidUuid(delayedStageId)) throw new Error('Этап не найден')
  return checkedJson(`${API_PREFIX}/schedule/cascade-shift`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ delayed_stage_id: delayedStageId, delay_days: delayDays }),
  }, 'Не удалось сохранить перенос сроков')
}

// ----------------------------------------------------------------------------
// Video API
// ----------------------------------------------------------------------------

export async function uploadVideoAsset(file: File, startTimestamp: string): Promise<VideoAsset> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('start_timestamp', startTimestamp)
  return checkedJson(`${API_PREFIX}/videos/upload`, { method: 'POST', body: formData }, 'Не удалось сохранить видеозапись')
}

export async function syncVideoPlayback(
  videoId: string,
  playbackSeconds: number
): Promise<VideoSyncStatus> {
  try {
    const res = await fetch(
      `${API_PREFIX}/videos/${videoId}/sync?playback_seconds=${playbackSeconds}`
    )
    if (res.ok) return await res.json()
  } catch {
    // Compute locally from demo schedule
  }

  const fallbackStages = getFallbackStages()
  // Default demo anchor datetime: 2026-06-15 10:00:00
  const baseTime = new Date('2026-06-15T10:00:00Z')
  const currentTime = new Date(baseTime.getTime() + playbackSeconds * 1000)

  const active = fallbackStages.find((s) => {
    const start = new Date(s.planned_start)
    const end = new Date(s.planned_end)
    return currentTime >= start && currentTime <= end
  })

  return {
    video_id: videoId,
    playback_seconds: playbackSeconds,
    current_timestamp: currentTime.toISOString(),
    active_stage_id: active?.id || null,
    active_stage_name: active?.name || 'Вне графика (межэтапный интервал)',
    is_out_of_schedule: !active,
  }
}

// ----------------------------------------------------------------------------
// Stage Probability Analytics API
// ----------------------------------------------------------------------------

const LOCAL_PROBABILITY_OVERRIDES: Record<string, Record<string, string>> = (() => {
  try {
    return JSON.parse(localStorage.getItem('stroy_prob_overrides') || '{}')
  } catch {
    return {}
  }
})()

function saveLocalOverrides(): void {
  try {
    localStorage.setItem('stroy_prob_overrides', JSON.stringify(LOCAL_PROBABILITY_OVERRIDES))
  } catch {
    // ignore
  }
}


export function getStageCustomOverrides(stageId?: string, _stageName?: string): Record<string, string> {
  return stageId ? { ...LOCAL_PROBABILITY_OVERRIDES[stageId] } : {}
}

export async function fetchStageProbabilities(stageId: string): Promise<StageProbabilityResponse> {
  if (!isValidUuid(stageId)) throw new Error('Этап не найден')
  const data = await checkedJson<StageProbabilityResponse>(`${API_PREFIX}/schedule/stages/${stageId}/probabilities`, {}, 'Не удалось загрузить правила контроля')
  if (data.stage_id !== stageId) throw new Error('Сервер вернул правила другого этапа')
  const cache = Object.fromEntries(data.probabilities.map(item => [item.machinery_code, item.classification]))
  LOCAL_PROBABILITY_OVERRIDES[stageId] = cache
  saveLocalOverrides()
  return data
}

export async function updateStageProbabilities(
  stageId: string, overrides: Record<string, string | number>, _stageName?: string
): Promise<StageProbabilityResponse> {
  if (!isValidUuid(stageId)) throw new Error('Этап не найден')
  const data = await checkedJson<StageProbabilityResponse>(`${API_PREFIX}/schedule/stages/${stageId}/probabilities`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...getAuthHeaders() }, body: JSON.stringify({ overrides }),
  }, 'Не удалось сохранить правила контроля')
  if (data.stage_id !== stageId) throw new Error('Сервер вернул правила другого этапа')
  LOCAL_PROBABILITY_OVERRIDES[stageId] = Object.fromEntries(data.probabilities.map(item => [item.machinery_code, item.classification]))
  saveLocalOverrides()
  return data
}

export async function resetStageProbabilities(stageId: string, _stageName?: string): Promise<StageProbabilityResponse> {
  if (!isValidUuid(stageId)) throw new Error('Этап не найден')
  const data = await checkedJson<StageProbabilityResponse>(`${API_PREFIX}/schedule/stages/${stageId}/probabilities`, { method: 'DELETE' }, 'Не удалось восстановить правила контроля')
  if (data.stage_id !== stageId) throw new Error('Сервер вернул правила другого этапа')
  LOCAL_PROBABILITY_OVERRIDES[stageId] = Object.fromEntries(data.probabilities.map(item => [item.machinery_code, item.classification]))
  saveLocalOverrides()
  return data
}

// ----------------------------------------------------------------------------
// Incidents & Multi-camera Albums API
// ----------------------------------------------------------------------------

export async function fetchIncidentConfig(): Promise<{ violation_evaluation_window_seconds: number }> {
  try {
    const res = await fetch(`${API_PREFIX}/incidents/config`)
    if (res.ok) return await res.json()
  } catch {
    // fallback default
  }
  return { violation_evaluation_window_seconds: 30 }
}

export async function updateIncidentConfig(
  seconds: number
): Promise<{ violation_evaluation_window_seconds: number }> {
  const res = await fetch(`${API_PREFIX}/incidents/config`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ violation_evaluation_window_seconds: seconds }),
  })
  if (!res.ok) throw new Error('Ошибка обновления периода фиксации нарушений')
  return await res.json()
}

export async function createIncident(data: IncidentCreatePayload): Promise<IncidentAlertItem> {
  const res = await fetch(`${API_PREFIX}/incidents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Ошибка регистрации инцидента')
  return await res.json()
}

export const MACHINERY_CODE_TO_RU: Record<string, string> = {
  // Lowercase & snake_case
  dump_truck: 'Самосвал',
  dumptruck: 'Самосвал',
  truck: 'Грузовик',
  excavator: 'Экскаватор',
  digger: 'Экскаватор',
  tower_crane: 'Башенный кран',
  towercrane: 'Башенный кран',
  truck_crane: 'Автокран',
  crane: 'Кран (подтип не определён)',
  concrete_mixer: 'Автобетоносмеситель',
  mixer: 'Автобетоносмеситель',
  concrete_pump: 'Бетононасос',
  pump: 'Бетононасос',
  bulldozer: 'Бульдозер',
  dozer: 'Бульдозер',
  wheel_loader: 'Погрузчик',
  loader: 'Погрузчик',
  roller: 'Каток',
  aerial_lift: 'Автогидроподъемник',
  grader: 'Автогрейдер',
  backhoe_loader: 'Экскаватор-погрузчик',
  asphalt_paver: 'Асфальтоукладчик',

  cleaning_equipment: 'Уборочная техника',
  crane_manipulator: 'Кран-манипулятор',
  crawler_crane: 'Гусеничный кран',
  forklift_giraffe: 'Телескопический погрузчик',
  forklift_standart: 'Вилочный погрузчик',
  gazelle: 'Газель',
  hanging_head: 'Подвесной крюк',
  mobile_crane: 'Мобильный кран',
  other_vehicle: 'Другой транспорт',
  pile_driving: 'Сваебойная установка',
  tanker: 'Автоцистерна',
  trailer: 'Прицеп',
  worker: 'Рабочий',

  // Uppercase enum constants (MACHINERY_*)
  MACHINERY_DUMP_TRUCK: 'Самосвал',
  MACHINERY_EXCAVATOR: 'Экскаватор',
  MACHINERY_TOWER_CRANE: 'Башенный кран',
  MACHINERY_TRUCK_CRANE: 'Автокран',
  MACHINERY_CONCRETE_MIXER: 'Автобетоносмеситель',
  MACHINERY_CONCRETE_PUMP: 'Бетононасос',
  MACHINERY_BULLDOZER: 'Бульдозер',
  MACHINERY_LOADER: 'Погрузчик',
  MACHINERY_WHEEL_LOADER: 'Погрузчик',
  MACHINERY_ROLLER: 'Каток',
  MACHINERY_AERIAL_LIFT: 'Автогидроподъемник',
  MACHINERY_GRADER: 'Автогрейдер',
  MACHINERY_BACKHOE_LOADER: 'Экскаватор-погрузчик',
  MACHINERY_ASPHALT_PAVER: 'Асфальтоукладчик',
}

export function toRussianMachineryName(raw?: string | null): string {
  if (!raw) return ''
  const trimmed = raw.trim()
  if (MACHINERY_CODE_TO_RU[trimmed]) {
    return MACHINERY_CODE_TO_RU[trimmed]
  }
  const lower = trimmed.toLowerCase()
  if (MACHINERY_CODE_TO_RU[lower]) {
    return MACHINERY_CODE_TO_RU[lower]
  }
  const stripped = lower.replace(/^machinery_/, '')
  if (MACHINERY_CODE_TO_RU[stripped]) {
    return MACHINERY_CODE_TO_RU[stripped]
  }
  return trimmed
}

export function cleanViolationText(text?: string | null): string {
  if (!text) return ''
  let cleaned = text
  for (const [code, ru] of Object.entries(MACHINERY_CODE_TO_RU)) {
    if (cleaned.includes(code)) {
      cleaned = cleaned.split(code).join(ru)
    }
  }
  return cleaned
}

function normalizeIncidentItem(item: IncidentAlertItem): IncidentAlertItem {
  return {
    ...item,
    title: cleanViolationText(item.title),
    description: cleanViolationText(item.description),
    machinery_type: item.machinery_type ? toRussianMachineryName(item.machinery_type) : item.machinery_type,
  }
}

export async function fetchIncidents(projectId?: string): Promise<IncidentAlertItem[]> {
  const url = projectId ? `${API_PREFIX}/incidents?project_id=${projectId}` : `${API_PREFIX}/incidents`
  const res = await fetch(url, { headers: getAuthHeaders() })
  if (!res.ok) throw new Error('Не удалось загрузить инциденты')
  const data: IncidentAlertItem[] = await res.json()
  return data.map(normalizeIncidentItem)
}

export async function fetchIncidentAlbum(incidentId: string): Promise<IncidentAlbumData> {
  const res = await fetch(`${API_PREFIX}/incidents/${incidentId}/album`, { headers: getAuthHeaders() })
  if (!res.ok) throw new Error('Ошибка получения альбома инцидента')
  return await res.json()
}

export async function updateIncidentStatus(
  incidentId: string,
  status: string
): Promise<IncidentAlertItem> {
  const res = await fetch(`${API_PREFIX}/incidents/${incidentId}/status`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify({ status }),
  })
  if (!res.ok) throw new Error('Ошибка обновления статуса инцидента')
  return await res.json()
}

export async function fetchAlerts(): Promise<AlertNotificationItem[]> {
  const res = await fetch(`${API_PREFIX}/alerts`, { headers: getAuthHeaders() })
  if (!res.ok) throw new Error('Не удалось загрузить алерты')
  return await res.json()
}

export async function markAlertRead(alertId: string): Promise<void> {
  const res = await fetch(`${API_PREFIX}/alerts/${alertId}/read`, {
    method: 'PATCH',
    headers: getAuthHeaders(),
  })
  if (!res.ok) throw new Error('Не удалось отметить алерт прочитанным')
}

export async function fetchIncidentEvents(incidentId: string): Promise<IncidentEventItem[]> {
  const res = await fetch(`${API_PREFIX}/incidents/${incidentId}/events`, { headers: getAuthHeaders() })
  if (!res.ok) throw new Error('Не удалось загрузить историю инцидента')
  return await res.json()
}

// ----------------------------------------------------------------------------
// Fallback Mock Data Providers
// ----------------------------------------------------------------------------

function getFallbackStages(): StageItem[] {
  return []
}

export interface DetectionBoxItem {
  class_id: number
  raw_label: string
  label_ru: string
  canonical_code: string
  confidence: number
  x1: number
  y1: number
  x2: number
  y2: number
  top: number
  left: number
  width: number
  height: number
}

export interface FrameDetectionResponse {
  compliance_enabled?: boolean
  evaluable_classes?: string[]
  timestamp: string
  active_stage?: string | null
  model_ready: boolean
  detector_status: string
  message?: string | null
  count: number
  detections: DetectionBoxItem[]
}

export async function detectFrameImage(
  imageBlob: Blob,
  stageName?: string
): Promise<FrameDetectionResponse> {
  const formData = new FormData()
  formData.append('file', imageBlob, 'frame.jpg')
  if (stageName) {
    formData.append('stage_name', stageName)
  }

  const response = await fetch(`${API_PREFIX}/videos/detect-frame`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: formData,
  })

  if (!response.ok) {
    throw new Error(`Сервис YOLO недоступен: HTTP ${response.status}`)
  }

  return await response.json()
}

/**
 * Выбирает этап по реальной календарной дате или явно переданному времени записи.
 * Логика:
 * 1. Этап, в интервал которого попадает текущая дата (planned_start <= date <= planned_end).
 * 2. Этап со статусом 'active' или 'in_progress'.
 * 3. Ближайший предстоящий этап (planned_end >= date).
 * 4. Первый этап графика.
 */
export function getCurrentStageByDate(
  stages: StageItem[],
  referenceDate: Date = new Date()
): StageItem | undefined {
  if (!stages || stages.length === 0) return undefined

  const refTime = referenceDate.getTime()
  if (!Number.isFinite(refTime)) return undefined

  // 1. Ищем этап, где дата попадает в плановые сроки
  const matched = stages.find((s) => {
    const st = new Date(s.planned_start).getTime()
    const en = new Date(s.planned_end).getTime()
    return st <= refTime && refTime <= en
  })
  if (matched) return matched

  // 2. Ищем этап со статусом active
  const activeStatus = stages.find(
    (s) => s.status.toLowerCase() === 'active' || s.status.toLowerCase() === 'in_progress'
  )
  if (activeStatus) return activeStatus

  // 3. Ближайший предстоящий этап
  const upcoming = stages.find((s) => new Date(s.planned_end).getTime() >= refTime)
  if (upcoming) return upcoming

  // 4. Первый этап
  return stages[0]
}
