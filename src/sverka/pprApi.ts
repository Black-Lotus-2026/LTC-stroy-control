import { API_PREFIX, getAuthHeaders } from '../api/stroyControlApi'
import { ApiError, req } from './api'

export interface PprDocument {
  id: string
  project_id: string
  filename: string
  media_type: string
  size_bytes: number
  sha256: string
  uploaded_by: string
  created_at: string
  preview_kind: 'pdf' | 'image' | 'text'
  series_id?: string | null
  version_no?: number | null
  supersedes_id?: string | null
  area_id?: string | null
  owner_participation_id?: string | null
}
export interface PprDocumentDetail extends PprDocument { display_text: string | null }
export interface PprRequirement {
  id: string
  document_id: string
  document_sha256: string
  page_number: number
  title: string
  type: 'equipment_required' | 'equipment_forbidden' | 'ppe_required' | 'other'
  equipment_class: string | null
  scope_text: string
  quote: string
  quote_verified: boolean
  detector_supported: boolean
  active: boolean
  extraction_method: string
  applicability: 'project' | 'stage' | 'manual'
  stage_name: string | null
  stage_id: string | null
  human_confirmed: boolean
  activated_at?: string | null
  reviewed_by?: string | null
  reviewed_at?: string | null
}
export interface PprAnalysis {
  id: string
  document_id: string
  document_sha256: string
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'PARTIAL' | 'FAILED'
  error_code: string | null
  pages_total: number
  pages_processed: number
  attempts: number
  updated_at: string
  provider: string | null
  model: string | null
  pages: { page_number: number; status: 'PENDING' | 'COMPLETED' | 'FAILED'; error_code: string | null; extraction_method: string | null; text_sha256: string | null; preview_available: boolean }[]
  requirements: PprRequirement[]
}
export interface PprCitation {
  document_id: string
  analysis_id?: string
  document_sha256?: string
  page_number: number
  title?: string
  quote?: string
  filename?: string
  requirement_id?: string
  activated_at?: string | null
  rule_activated_at?: string | null
  kind?: string
  scope_text?: string
  source_url?: string
}
export const pprCitationFingerprint = (citations: PprCitation[] = []) => citations.length ? JSON.stringify(citations.map(row => [row.requirement_id || '', row.document_id, row.document_sha256 || '', row.page_number, row.rule_activated_at || row.activated_at || '']).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))) : ''
export const MAX_PPR_BYTES = 50 * 1024 * 1024
export const PPR_ACCEPT = '.pdf,.docx,.png,.jpg,.jpeg'
const path = (projectId: string) => `/projects/${encodeURIComponent(projectId)}/ppr-documents`
const pendingRequests = new Map<string, string>()
const requestKey = (key: string) => {
  const scope = `${getAuthHeaders()['X-Project-Assignment'] || ''}:${key}`
  let value = pendingRequests.get(scope)
  if (!value) { value = crypto.randomUUID(); pendingRequests.set(scope, value) }
  return value
}
export const listPprDocuments = (projectId: string, signal?: AbortSignal) => req<PprDocument[]>(path(projectId), { signal }, 'Не удалось загрузить документы ППР')
export const readPprDocument = (projectId: string, id: string, signal?: AbortSignal) => req<PprDocumentDetail>(`${path(projectId)}/${encodeURIComponent(id)}`, { signal }, 'Не удалось открыть документ')
export async function readPprAnalysis(projectId: string, id: string, signal?: AbortSignal): Promise<PprAnalysis | null> {
  try { return await req<PprAnalysis>(`${path(projectId)}/${encodeURIComponent(id)}/analysis`, { signal }, 'Не удалось получить результат разбора ППР') }
  catch (error) { if (error instanceof ApiError && error.status === 404) return null; throw error }
}
export const analyzePprDocument = async (projectId: string, id: string) => {
  const route = `${path(projectId)}/${encodeURIComponent(id)}/analyze`
  const result = await req<PprAnalysis>(route, { method: 'POST', headers: { 'Idempotency-Key': requestKey(route) } }, 'Не удалось запустить разбор ППР')
  pendingRequests.delete(`${getAuthHeaders()['X-Project-Assignment'] || ''}:${route}`)
  return result
}
export const activatePprRequirement = (projectId: string, documentId: string, requirementId: string, body: { active: boolean; applicability: 'project' | 'stage'; stage_id: string | null; human_confirmed: boolean }) => req<PprRequirement>(`${path(projectId)}/${encodeURIComponent(documentId)}/requirements/${encodeURIComponent(requirementId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'Не удалось сохранить применение требования ППР')

/** Each citation opens a real page, including the paginated PDF representation of DOCX. */
export async function pprSourcePage(projectId: string, id: string, page: number, signal?: AbortSignal, sourceUrl?: string, analysisId?: string): Promise<Blob> {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Номер страницы ППР не указан.')
  const defaultPath = `${path(projectId)}/${encodeURIComponent(id)}/pages/${page}/original`
  const apiPath = new URL(API_PREFIX, 'https://ppr.invalid').pathname.replace(/\/$/, '')
  let route = defaultPath
  if (sourceUrl && sourceUrl !== `${apiPath}${defaultPath}`) {
    const suffix = sourceUrl.startsWith(`${apiPath}/`) ? sourceUrl.slice(apiPath.length) : ''
    if (!/^\/(?:customer-control\/incidents|incidents|safety\/events)\/[a-zA-Z0-9_-]+\/ppr-sources\/[a-zA-Z0-9_-]+$/.test(suffix)) throw new Error('Ссылка на источник ППР недопустима.')
    route = suffix
  }
  if (analysisId && route === defaultPath) route += `?analysis_id=${encodeURIComponent(analysisId)}`
  const response = await fetch(`${API_PREFIX}${route}`, { headers: getAuthHeaders(), signal })
  if (!response.ok) throw new Error(response.status === 404 ? 'Страница источника пока недоступна. Проверьте статус разбора документа.' : 'Не удалось открыть страницу ППР. Повторите попытку.')
  return response.blob()
}

export function validatePprFile(file: Pick<File, 'name' | 'size'>): string | null {
  if (!/\.(pdf|docx|png|jpe?g)$/i.test(file.name)) return 'Выберите PDF, DOCX, JPG или PNG.'
  if (!file.size) return 'Файл пуст. Выберите другой документ.'
  if (file.size > MAX_PPR_BYTES) return 'Документ больше 50 МБ. Выберите файл меньшего размера.'
  return null
}

export function uploadPprDocument(projectId: string, file: File, signal: AbortSignal, onProgress: (value: number) => void, context?: { area_id?: string; series_id?: string }): Promise<PprDocument> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    const abort = () => xhr.abort()
    const finish = () => signal.removeEventListener('abort', abort)
    xhr.open('POST', `${API_PREFIX}${path(projectId)}`)
    for (const [key, value] of Object.entries(getAuthHeaders())) xhr.setRequestHeader(key, value)
    xhr.setRequestHeader('Idempotency-Key', requestKey(`${path(projectId)}:${file.name}:${file.size}:${file.lastModified}:${context?.area_id || ''}:${context?.series_id || ''}`))
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(Math.min(100, Math.round(event.loaded / event.total * 100))) }
    xhr.onload = () => {
      finish()
      let body: unknown
      try { body = JSON.parse(xhr.responseText) } catch { /* response may be unavailable */ }
      if (xhr.status >= 200 && xhr.status < 300 && body && typeof body === 'object' && 'id' in body) resolve(body as PprDocument)
      else {
        const detail = body && typeof body === 'object' && 'detail' in body ? body.detail : null
        reject(new Error(typeof detail === 'string' ? detail : 'Не удалось сохранить документ. Повторите загрузку.'))
      }
    }
    xhr.onerror = () => { finish(); reject(new Error('Соединение прервано. Документ не подтверждён сервером. Повторите загрузку.')) }
    xhr.onabort = () => { finish(); reject(new DOMException('Загрузка отменена', 'AbortError')) }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) { finish(); reject(new DOMException('Загрузка отменена', 'AbortError')); return }
    const form = new FormData()
    form.append('file', file)
    if (context?.area_id) form.append('area_id', context.area_id)
    if (context?.series_id) form.append('series_id', context.series_id)
    xhr.send(form)
  })
}

export async function pprOriginal(projectId: string, id: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(`${API_PREFIX}${path(projectId)}/${encodeURIComponent(id)}/original`, { headers: getAuthHeaders(), signal })
  if (!response.ok) throw new Error(response.status === 404 ? 'Оригинал не найден. Обновите список или обратитесь к загрузившему документ.' : 'Не удалось получить оригинал. Попробуйте ещё раз.')
  return response.blob()
}
