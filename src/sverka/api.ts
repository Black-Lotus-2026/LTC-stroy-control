/*
 * API client for the new interface. Unlike the legacy client it never substitutes demo data:
 * a failed request throws, and the screen shows what went wrong.
 */
import { API_BASE_URL, API_PREFIX, getStoredToken, setStoredToken } from '../api/stroyControlApi'
import type { CameraItem, ProjectItem, StageItem, UserProfile, ZoneItem } from '../api/stroyControlApi'

export type { CameraItem, ProjectItem, StageItem, UserProfile, ZoneItem }

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function authHeaders(): Record<string, string> {
  const t = getStoredToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

async function req<T>(path: string, init: RequestInit = {}, fallbackMessage = 'Сервер не ответил'): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_PREFIX}${path}`, { ...init, headers: { ...authHeaders(), ...(init.headers || {}) } })
  } catch {
    throw new ApiError('Нет связи с сервером. Проверьте, что API запущен.', 0)
  }
  if (!res.ok) {
    let msg = fallbackMessage
    try {
      const body = await res.json()
      const d = body?.detail ?? body?.error?.message
      if (typeof d === 'string') msg = d
      else if (Array.isArray(d) && d[0]?.msg) msg = d[0].msg
    } catch {
      // body is not JSON
    }
    throw new ApiError(msg, res.status)
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
export async function register(username: string, password: string, confirm: string) {
  const r = await req<TokenResponse>('/auth/register', json('POST', { username, password, confirm_password: confirm }), 'Не удалось зарегистрироваться')
  setStoredToken(r.access_token)
  return r.user
}
export async function me(): Promise<UserProfile | null> {
  if (!getStoredToken()) return null
  try {
    return await req<UserProfile>('/auth/me')
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) setStoredToken(null)
    if (e instanceof ApiError && e.status === 0) throw e
    return null
  }
}
export const logout = () => setStoredToken(null)

/* projects, zones, cameras */
export const projects = () => req<ProjectItem[]>('/projects')
export const createProject = (data: { name: string; address?: string; object_kind?: string; owner_username?: string }) =>
  req<ProjectItem>('/projects', json('POST', data), 'Не удалось создать объект')
export const updateProject = (projectId: string, data: { name?: string; code?: string; address?: string; object_kind?: string }) =>
  req<ProjectItem>(`/projects/${projectId}`, json('PATCH', data), 'Не удалось сохранить объект')
export const deleteProject = (projectId: string) => req<void>(`/projects/${projectId}`, { method: 'DELETE' }, 'Не удалось удалить объект')
export const zones = (projectId: string) => req<ZoneItem[]>(`/projects/${projectId}/zones`)
export const createZone = (projectId: string, data: { name: string; code?: string; description?: string }) =>
  req<ZoneItem>(`/projects/${projectId}/zones`, json('POST', data), 'Не удалось создать зону')
export const updateZone = (projectId: string, zoneId: string, data: { name?: string; code?: string; description?: string }) =>
  req<ZoneItem>(`/projects/${projectId}/zones/${zoneId}`, json('PATCH', data), 'Не удалось сохранить зону')
export const deleteZone = (projectId: string, zoneId: string) => req<void>(`/projects/${projectId}/zones/${zoneId}`, { method: 'DELETE' }, 'Не удалось удалить зону')
export const cameras = (projectId: string) => req<CameraItem[]>(`/projects/${projectId}/cameras`)
export const createCamera = (projectId: string, data: { name: string; stream_url: string; zone_id?: string | null }) =>
  req<CameraItem>(`/projects/${projectId}/cameras`, json('POST', data), 'Не удалось сохранить камеру')
export const updateCamera = (projectId: string, cameraId: string, data: { name: string; stream_url: string; zone_id: string | null }) =>
  req<CameraItem>(`/projects/${projectId}/cameras/${cameraId}`, json('PATCH', data), 'Не удалось сохранить камеру')
export const deleteCamera = (projectId: string, cameraId: string) =>
  req<void>(`/projects/${projectId}/cameras/${cameraId}`, { method: 'DELETE' }, 'Не удалось удалить камеру')

export interface StreamCheck { status: 'online' | 'offline' | 'warning' | 'unknown'; protocol?: string; message?: string; error?: string; suggestion?: string }
export const checkStream = (url: string) => req<StreamCheck>(`/videos/check-stream?url=${encodeURIComponent(url)}`)
export const proxyUrl = (url: string) => `${API_PREFIX}/videos/proxy-stream?url=${encodeURIComponent(url)}`
/**
 * One frame from an HTTP camera through the existing proxy: load the stream, take the first
 * frame, close the connection. Holding MJPEG streams open would use up the browser's six
 * connections per host and stall every other request to the API.
 */
export function grabFrame(url: string, timeoutMs = 6000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.decoding = 'async'
    const timer = window.setTimeout(() => {
      img.onload = img.onerror = null
      img.removeAttribute('src')
      reject(new ApiError('Камера не прислала кадр за 6 секунд', 0))
    }, timeoutMs)
    img.onload = () => {
      window.clearTimeout(timer)
      img.onload = img.onerror = null
      resolve(img)
    }
    img.onerror = () => {
      window.clearTimeout(timer)
      img.onload = img.onerror = null
      reject(new ApiError('Камера не ответила через сервер', 0))
    }
    img.src = `${proxyUrl(url)}&_=${Date.now()}`
  })
}

/** Check a camera before saving it. HTTP: try to get a frame; RTSP: the server checks the port. */
export async function probeCamera(url: string): Promise<{ ok: boolean; message: string }> {
  const u = url.trim()
  if (/^https?:\/\//i.test(u)) {
    try {
      const img = await grabFrame(u)
      const msg = `Кадр получен · ${img.naturalWidth}×${img.naturalHeight}`
      img.removeAttribute('src')
      return { ok: true, message: msg }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Камера не ответила' }
    }
  }
  const r = await checkStream(u)
  return { ok: r.status === 'online', message: r.status === 'online' ? r.message || 'Порт отвечает' : r.error || r.suggestion || 'Не отвечает' }
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
}
export interface ApiProfile {
  stage_id: string
  stage_name: string
  matched_catalog_stage?: string | null
  similarity_confidence: number
  probabilities: ApiMachinery[]
  has_custom_override?: boolean
}
export const updateStage = (stageId: string, data: { planned_start: string; planned_end: string; duration_days: number }) =>
  req<StageItem>(`/schedule/stages/${stageId}`, json('PUT', data), 'Не удалось сохранить сроки этапа')
/** Always scoped to the object: without project_id the server clears the plans of every object. */
export const clearPlan = (projectId: string) => req<{ deleted_count: number }>(`/schedule/clear?project_id=${projectId}`, { method: 'POST' }, 'Не удалось очистить план')
export const profile = (stageId: string) => req<ApiProfile>(`/schedule/stages/${stageId}/probabilities`)
export const putOverrides = (stageId: string, overrides: Record<string, unknown>) =>
  req<ApiProfile>(`/schedule/stages/${stageId}/probabilities`, json('PUT', { overrides }), 'Не удалось сохранить правило')

/* detection */
export interface ApiDetection { raw_label: string; canonical_code: string; label_ru: string; confidence: number; x1: number; y1: number; x2: number; y2: number }
export interface DetectResponse { model_ready: boolean; detector_status: string; message?: string | null; detections: ApiDetection[] }
export function detectFrame(blob: Blob, stageName?: string) {
  const fd = new FormData()
  fd.append('file', blob, 'frame.jpg')
  if (stageName) fd.append('stage_name', stageName)
  return req<DetectResponse>('/videos/detect-frame', { method: 'POST', body: fd }, 'Сервис распознавания не ответил')
}
export interface DetectorStatus { ready: boolean; status: string; message?: string | null; supported_classes: string[] }
export const detectorStatus = () => req<DetectorStatus>('/videos/detector-status')

export interface VideoAsset { video_id: string; filename: string; start_timestamp: string; duration_seconds: number }
export function uploadVideo(projectId: string, file: File, startIso: string) {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('start_timestamp', startIso)
  return req<VideoAsset>(`/videos/upload?project_id=${projectId}`, { method: 'POST', body: fd }, 'Не удалось сохранить запись на сервере')
}

/* incidents */
export interface ApiIncident {
  id: string
  code: string
  project_id: string
  stage_id?: string | null
  stage_name?: string | null
  zone_name?: string | null
  camera_name?: string | null
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
}
export interface IncidentCreate {
  project_id: string
  stage_id?: string | null
  stage_name?: string | null
  zone_name?: string | null
  camera_name?: string | null
  severity: 'ERROR' | 'WARNING'
  discrepancy_type: 'MISSING_MANDATORY' | 'UNCHARACTERISTIC_PRESENT'
  machinery_type: string
  stage_probability?: number
  observed_count?: number
  title: string
  description: string
  album_snapshots?: { camera_name: string; snapshot_base64: string; is_primary?: boolean }[]
}
export const incidents = (projectId: string) => req<ApiIncident[]>(`/incidents?project_id=${projectId}&limit=1000`)
export const createIncident = (data: IncidentCreate) => req<ApiIncident>('/incidents', json('POST', data), 'Не удалось сохранить событие')
export const setIncidentStatus = (id: string, status: string) =>
  req<ApiIncident>(`/incidents/${id}/status`, json('PATCH', { status }), 'Не удалось сохранить решение')
export const resetProfile = (stageId: string) =>
  req<ApiProfile>(`/schedule/stages/${stageId}/probabilities`, { method: 'DELETE' }, 'Не удалось сбросить профиль')
export const incidentConfig = () => req<{ violation_evaluation_window_seconds: number }>('/incidents/config')
export const setIncidentConfig = (seconds: number) =>
  req<{ violation_evaluation_window_seconds: number }>('/incidents/config', json('PATCH', { violation_evaluation_window_seconds: seconds }), 'Не удалось сохранить окно сверки')
