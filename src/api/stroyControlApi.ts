/**
 * Stroy-Control Platform Typed API Client.
 *
 * Provides typed methods for:
 * 1. Schedule & Gantt management (upload, demo load, inline edit, cascade delay shift)
 * 2. Video streams & Demo video upload with absolute recording start timestamp
 * 3. Stage machinery probability analytics (StageMachineryService)
 * 4. Incidents & Google Gemini Vision VLM verification alerts
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
  machinery_type?: string
  stage_probability?: number
  observed_count?: number
  frame_snapshot_url?: string | null
  snapshot_url?: string | null
  is_vlm_verified?: boolean
  vlm_summary?: string | null
  created_at?: string
}

export interface IncidentCreatePayload {
  project_id?: string
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
}

export interface VlmVerificationResult {
  incident_id: string
  is_violation_confirmed: boolean
  is_occluded: boolean
  confidence: number
  reasoning: string
  compact_alert_text: string
  fallback_used: boolean
  latency_ms: number
  status: string
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
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
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

// ----------------------------------------------------------------------------
// Projects, Construction Sites (Zones), and Cameras API
// ----------------------------------------------------------------------------

export async function fetchProjects(): Promise<ProjectItem[]> {
  try {
    const res = await fetch(`${API_PREFIX}/projects`)
    if (res.ok) return await res.json()
  } catch {
    // offline fallback
  }
  return []
}

export async function createProject(data: {
  name: string
  code?: string
  address?: string
  object_kind?: string
}): Promise<ProjectItem> {
  const res = await fetch(`${API_PREFIX}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
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
  try {
    const res = await fetch(`${API_PREFIX}/projects/${projectId}/zones`)
    if (res.ok) return await res.json()
  } catch {
    // offline
  }
  return []
}

export async function createProjectZone(
  projectId: string,
  data: { name: string; code?: string; description?: string }
): Promise<ZoneItem> {
  const res = await fetch(`${API_PREFIX}/projects/${projectId}/zones`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    headers: { 'Content-Type': 'application/json' },
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
  try {
    const url = projectId
      ? `${API_PREFIX}/videos/cameras?project_id=${projectId}`
      : `${API_PREFIX}/videos/cameras`
    const res = await fetch(url)
    if (res.ok) return await res.json()
  } catch {
    // offline
  }
  return []
}

export async function createCamera(
  projectId: string,
  data: { name: string; code?: string; stream_url?: string; zone_id?: string }
): Promise<CameraItem> {
  const cleanZoneId = isValidUuid(data.zone_id) ? data.zone_id : undefined
  const payload = {
    ...data,
    zone_id: cleanZoneId,
  }
  try {
    const res = await fetch(`${API_PREFIX}/projects/${projectId}/cameras`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      return await res.json()
    }
  } catch (e) {
    console.warn('Backend createCamera request failed:', e)
  }

  // Graceful local fallback so user camera addition always succeeds
  return {
    id: `cam-${Date.now()}`,
    project_id: projectId,
    zone_id: cleanZoneId || null,
    code: data.code || `CAM-${Math.floor(10 + Math.random() * 90)}`,
    name: data.name,
    stream_url: data.stream_url || 'rtsp://127.0.0.1:8554/live/stroy_cam',
    status: 'online',
  }
}

export async function updateCamera(
  projectId: string,
  cameraId: string,
  data: { name?: string; code?: string; stream_url?: string; zone_id?: string | null }
): Promise<CameraItem> {
  const cleanZoneId = isValidUuid(data.zone_id) ? data.zone_id : null
  const payload = {
    ...data,
    zone_id: cleanZoneId,
  }
  try {
    const res = await fetch(`${API_PREFIX}/projects/${projectId}/cameras/${cameraId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (res.ok) {
      return await res.json()
    }
  } catch (e) {
    console.warn('Backend updateCamera request failed:', e)
  }

  return {
    id: cameraId,
    project_id: projectId,
    zone_id: cleanZoneId,
    code: data.code || 'CAM-01',
    name: data.name || 'Камера',
    stream_url: data.stream_url || 'rtsp://127.0.0.1:8554/live/stroy_cam',
    status: 'online',
  }
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
  try {
    const validId = isValidUuid(projectId) ? projectId : undefined
    const url = validId
      ? `${API_PREFIX}/schedule/stages?project_id=${validId}`
      : `${API_PREFIX}/schedule/stages`
    const res = await fetch(url)
    if (res.ok) {
      const data = await res.json()
      if (Array.isArray(data) && data.length > 0) return data
    }
  } catch {
    // Return empty fallback
  }
  return []
}

export async function loadDemoSchedule(projectId?: string): Promise<StageItem[]> {
  try {
    const validId = isValidUuid(projectId) ? projectId : undefined
    const url = validId
      ? `${API_PREFIX}/schedule/load-demo?project_id=${validId}`
      : `${API_PREFIX}/schedule/load-demo`
    const res = await fetch(url, { method: 'POST' })
    if (res.ok) {
      const data = await res.json()
      const stages = data.stages || data
      if (Array.isArray(stages) && stages.length > 0) return stages
    }
  } catch {
    // fallback below
  }
  return DEMO_REFERENCE_STAGES
}

export async function uploadScheduleFile(file: File, projectId?: string): Promise<StageItem[]> {
  const formData = new FormData()
  formData.append('file', file)
  const validId = isValidUuid(projectId) ? projectId : undefined
  const url = validId
    ? `${API_PREFIX}/schedule/upload?project_id=${validId}`
    : `${API_PREFIX}/schedule/upload`
  const res = await fetch(url, {
    method: 'POST',
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
  const validId = isValidUuid(projectId) ? projectId : undefined
  const url = validId
    ? `${API_PREFIX}/schedule/clear?project_id=${validId}`
    : `${API_PREFIX}/schedule/clear`
  await fetch(url, { method: 'POST' })
}

export async function updateStageDates(
  stageId: string,
  data: { name?: string; planned_start?: string; planned_end?: string; duration_days?: number }
): Promise<StageItem> {
  const res = await fetch(`${API_PREFIX}/schedule/stages/${stageId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Ошибка обновления этапа')
  return await res.json()
}

export async function cascadeShiftStages(
  delayedStageId: string,
  delayDays: number
): Promise<CascadeShiftResponse> {
  try {
    const res = await fetch(`${API_PREFIX}/schedule/cascade-shift`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delayed_stage_id: delayedStageId, delay_days: delayDays }),
    })
    if (res.ok) return await res.json()
  } catch {
    // Local calculation fallback if server is offline
  }

  const stages = getFallbackStages()
  const targetIndex = stages.findIndex((s) => s.id === delayedStageId)
  if (targetIndex >= 0) {
    for (let i = targetIndex + 1; i < stages.length; i++) {
      const start = new Date(stages[i].planned_start)
      const end = new Date(stages[i].planned_end)
      start.setDate(start.getDate() + delayDays)
      end.setDate(end.getDate() + delayDays)
      stages[i].planned_start = start.toISOString().split('T')[0]
      stages[i].planned_end = end.toISOString().split('T')[0]
    }
  }

  return {
    delayed_stage_id: delayedStageId,
    delay_days: delayDays,
    shifted_stage_count: stages.length - (targetIndex + 1),
    updated_stages: stages,
    message: `Успешно сдвинуты последующие этапы на ${delayDays} дн.`,
  }
}

// ----------------------------------------------------------------------------
// Video API
// ----------------------------------------------------------------------------

export async function uploadVideoAsset(file: File, startTimestamp: string): Promise<VideoAsset> {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('start_timestamp', startTimestamp)

  try {
    const res = await fetch(`${API_PREFIX}/videos/upload`, {
      method: 'POST',
      body: formData,
    })
    if (res.ok) return await res.json()
  } catch {
    // Fallback mock
  }

  return {
    video_id: 'vid-demo-01',
    filename: file.name,
    start_timestamp: startTimestamp,
    duration_seconds: 120.0,
    fps: 25.0,
    status: 'READY',
    message: 'Видео зарегистрировано в локальном режиме',
  }
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

function applyLocalOverridesToResponse(resp: StageProbabilityResponse, stageId: string): void {
  const overrides = LOCAL_PROBABILITY_OVERRIDES[stageId]
  if (!overrides) return
  const statusMeta: Record<string, { prob: number; level: string }> = {
    MANDATORY: { prob: 0.95, level: 'Обязательная' },
    RECOMMENDED: { prob: 0.75, level: 'Рекомендованная' },
    NEUTRAL: { prob: 0.40, level: 'Допустимая' },
    UNCHARACTERISTIC: { prob: 0.05, level: 'Не допускается' },
  }
  resp.probabilities = resp.probabilities.map((item) => {
    const ov = overrides[item.machinery_code]
    if (ov && statusMeta[ov]) {
      return {
        ...item,
        probability: statusMeta[ov].prob,
        requirement_level: statusMeta[ov].level,
        classification: ov as any,
      }
    }
    return item
  })
}

export function getStageCustomOverrides(stageId?: string): Record<string, string> {
  if (!stageId) return {}
  return LOCAL_PROBABILITY_OVERRIDES[stageId] || {}
}

export async function fetchStageProbabilities(stageId: string): Promise<StageProbabilityResponse> {
  const hasLocal = Boolean(LOCAL_PROBABILITY_OVERRIDES[stageId] && Object.keys(LOCAL_PROBABILITY_OVERRIDES[stageId]).length > 0)
  try {
    const res = await fetch(`${API_PREFIX}/schedule/stages/${stageId}/probabilities`)
    if (res.ok) {
      const data: StageProbabilityResponse = await res.json()
      if (data.has_custom_override) {
        return data
      }
      // If server explicitly confirmed NO overrides in DB, clean any stale local override
      if (hasLocal && data.has_custom_override === false) {
        delete LOCAL_PROBABILITY_OVERRIDES[stageId]
        saveLocalOverrides()
      }
      return {
        ...data,
        has_custom_override: false,
      }
    }
  } catch {
    // Fallback probability calculation
  }
  const fallback = getFallbackProbabilities(stageId)
  if (hasLocal) {
    applyLocalOverridesToResponse(fallback, stageId)
  }
  return {
    ...fallback,
    has_custom_override: hasLocal,
  }
}

export async function updateStageProbabilities(
  stageId: string,
  overrides: Record<string, string | number>
): Promise<StageProbabilityResponse> {
  const stringOverrides: Record<string, string> = {}
  for (const [k, v] of Object.entries(overrides)) {
    stringOverrides[k] = String(v)
  }
  LOCAL_PROBABILITY_OVERRIDES[stageId] = {
    ...(LOCAL_PROBABILITY_OVERRIDES[stageId] || {}),
    ...stringOverrides,
  }
  saveLocalOverrides()

  try {
    const res = await fetch(`${API_PREFIX}/schedule/stages/${stageId}/probabilities`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides }),
    })
    if (res.ok) {
      const data = await res.json()
      return { ...data, has_custom_override: true }
    }
  } catch {
    // offline fallback
  }
  const fallback = getFallbackProbabilities(stageId)
  applyLocalOverridesToResponse(fallback, stageId)
  return { ...fallback, has_custom_override: true }
}

export async function resetStageProbabilities(
  stageId: string
): Promise<StageProbabilityResponse> {
  delete LOCAL_PROBABILITY_OVERRIDES[stageId]
  saveLocalOverrides()

  try {
    const res = await fetch(`${API_PREFIX}/schedule/stages/${stageId}/probabilities`, {
      method: 'DELETE',
    })
    if (res.ok) {
      const data = await res.json()
      return { ...data, has_custom_override: false }
    }
  } catch {
    // offline fallback
  }
  const fallback = getFallbackProbabilities(stageId)
  return { ...fallback, has_custom_override: false }
}

// ----------------------------------------------------------------------------
// Incidents & VLM Verification API
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ violation_evaluation_window_seconds: seconds }),
  })
  if (!res.ok) throw new Error('Ошибка обновления периода фиксации нарушений')
  return await res.json()
}

export async function createIncident(data: IncidentCreatePayload): Promise<IncidentAlertItem> {
  const res = await fetch(`${API_PREFIX}/incidents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error('Ошибка регистрации инцидента')
  return await res.json()
}

export async function fetchIncidents(projectId?: string): Promise<IncidentAlertItem[]> {
  try {
    const url = projectId ? `${API_PREFIX}/incidents?project_id=${projectId}` : `${API_PREFIX}/incidents`
    const res = await fetch(url)
    if (res.ok) return await res.json()
  } catch {
    // Return mock incidents
  }
  return getFallbackIncidents()
}

export async function verifyIncidentVlm(incidentId: string): Promise<VlmVerificationResult> {
  const res = await fetch(`${API_PREFIX}/incidents/${incidentId}/verify-vlm`, {
    method: 'POST',
  })
  if (!res.ok) {
    throw new Error(`Сервис VLM недоступен: HTTP ${res.status}`)
  }
  return await res.json()
}

// ----------------------------------------------------------------------------
// Fallback Mock Data Providers
// ----------------------------------------------------------------------------

function getFallbackStages(): StageItem[] {
  return []
}

function getFallbackProbabilities(stageId: string): StageProbabilityResponse {
  const isExcavation = stageId.includes('02')
  return {
    stage_id: stageId,
    stage_name: isExcavation ? 'Выемка грунта котлована под фундамент' : 'Строительный этап СМР',
    matched_catalog_stage: isExcavation ? 'Выемка грунта котлована' : 'Общестроительные работы',
    similarity_confidence: 0.98,
    top_machinery: isExcavation ? ['Экскаватор', 'Самосвал', 'Бульдозер'] : ['Башенный кран', 'Автобетоносмеситель'],
    probabilities: [
      {
        machinery_code: 'MACHINERY_EXCAVATOR',
        machinery_name_ru: 'Экскаватор',
        probability: isExcavation ? 0.96 : 0.08,
        classification: isExcavation ? 'MANDATORY' : 'UNCHARACTERISTIC',
        requirement_level: isExcavation ? 'Обязательная' : 'Не допускается',
      },
      {
        machinery_code: 'MACHINERY_DUMP_TRUCK',
        machinery_name_ru: 'Самосвал',
        probability: isExcavation ? 0.92 : 0.35,
        classification: isExcavation ? 'MANDATORY' : 'NEUTRAL',
        requirement_level: isExcavation ? 'Обязательная' : 'Допустимая',
      },
      {
        machinery_code: 'MACHINERY_BULLDOZER',
        machinery_name_ru: 'Бульдозер',
        probability: isExcavation ? 0.84 : 0.12,
        classification: isExcavation ? 'MANDATORY' : 'UNCHARACTERISTIC',
        requirement_level: isExcavation ? 'Обязательная' : 'Не допускается',
      },
      {
        machinery_code: 'MACHINERY_LOADER',
        machinery_name_ru: 'Погрузчик',
        probability: 0.72,
        classification: 'RECOMMENDED',
        requirement_level: 'Рекомендованная',
      },
      {
        machinery_code: 'MACHINERY_ROLLER',
        machinery_name_ru: 'Каток',
        probability: isExcavation ? 0.45 : 0.10,
        classification: isExcavation ? 'NEUTRAL' : 'UNCHARACTERISTIC',
        requirement_level: isExcavation ? 'Допустимая' : 'Не допускается',
      },
      {
        machinery_code: 'MACHINERY_BACKHOE_LOADER',
        machinery_name_ru: 'Экскаватор-погрузчик',
        probability: 0.65,
        classification: 'RECOMMENDED',
        requirement_level: 'Рекомендованная',
      },
      {
        machinery_code: 'MACHINERY_TRUCK_CRANE',
        machinery_name_ru: 'Автокран',
        probability: isExcavation ? 0.30 : 0.85,
        classification: isExcavation ? 'NEUTRAL' : 'MANDATORY',
        requirement_level: isExcavation ? 'Допустимая' : 'Обязательная',
      },
      {
        machinery_code: 'MACHINERY_CONCRETE_MIXER',
        machinery_name_ru: 'Автобетоносмеситель',
        probability: isExcavation ? 0.10 : 0.90,
        classification: isExcavation ? 'UNCHARACTERISTIC' : 'MANDATORY',
        requirement_level: isExcavation ? 'Не допускается' : 'Обязательная',
      },
      {
        machinery_code: 'MACHINERY_TOWER_CRANE',
        machinery_name_ru: 'Башенный кран',
        probability: isExcavation ? 0.05 : 0.95,
        classification: isExcavation ? 'UNCHARACTERISTIC' : 'MANDATORY',
        requirement_level: isExcavation ? 'Не допускается' : 'Обязательная',
      },
      {
        machinery_code: 'MACHINERY_GRADER',
        machinery_name_ru: 'Автогрейдер',
        probability: 0.06,
        classification: 'UNCHARACTERISTIC',
        requirement_level: 'Не допускается',
      },
    ],
  }
}

function getFallbackIncidents(): IncidentAlertItem[] {
  return [
    {
      id: 'inc-001',
      code: 'INC-042',
      stage_id: 'stg-02',
      stage_name: 'Выемка грунта котлована под фундамент',
      severity: 'ERROR',
      discrepancy_type: 'MISSING_MANDATORY',
      machinery_type: 'Экскаватор',
      stage_probability: 0.96,
      observed_count: 0,
      is_vlm_verified: true,
      vlm_summary: 'На этапе выемки грунта отсутствует обязательный экскаватор. Камера подтверждает отсутствие техники на площадке.',
      created_at: new Date().toISOString(),
    },
    {
      id: 'inc-002',
      code: 'INC-043',
      stage_id: 'stg-02',
      stage_name: 'Выемка грунта котлована под фундамент',
      severity: 'WARNING',
      discrepancy_type: 'MISSING_RECOMMENDED',
      machinery_type: 'Погрузчик',
      stage_probability: 0.72,
      observed_count: 0,
      is_vlm_verified: false,
      vlm_summary: 'Рекомендованный погрузчик не зафиксирован на кадрах рабочей смены.',
      created_at: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
    },
  ]
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
    body: formData,
  })

  if (!response.ok) {
    throw new Error(`Сервис YOLO недоступен: HTTP ${response.status}`)
  }

  return await response.json()
}

/**
 * Выбирает текущий этап строительства исходя из текущей календарной даты (по умолчанию 2026-09-24).
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

  // Если системный год меньше 2026, используем 2026-09-24 как рабочую дату системы
  const effectiveDate =
    referenceDate.getFullYear() < 2026
      ? new Date('2026-09-24T12:00:00Z')
      : referenceDate

  const refTime = effectiveDate.getTime()

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
