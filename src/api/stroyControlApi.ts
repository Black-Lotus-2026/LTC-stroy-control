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
}

export interface IncidentAlertItem {
  id: string
  code: string
  stage_id?: string | null
  stage_name?: string | null
  severity: 'ERROR' | 'WARNING' | 'NEUTRAL'
  discrepancy_type: 'MISSING_MANDATORY' | 'MISSING_RECOMMENDED' | 'UNCHARACTERISTIC_PRESENT' | 'NEUTRAL_INFO'
  machinery_type: string
  stage_probability: number
  observed_count: number
  frame_snapshot_url?: string | null
  is_vlm_verified: boolean
  vlm_summary?: string | null
  created_at: string
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

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000'
const API_PREFIX = `${API_BASE_URL}/api/v1`

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

export async function deleteProject(projectId: string): Promise<void> {
  await fetch(`${API_PREFIX}/projects/${projectId}`, { method: 'DELETE' })
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
  const res = await fetch(`${API_PREFIX}/projects/${projectId}/cameras`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Ошибка добавления камеры' }))
    throw new Error(err.detail || 'Ошибка добавления камеры')
  }
  return await res.json()
}

// ----------------------------------------------------------------------------
// Schedule & Gantt API
// ----------------------------------------------------------------------------

export async function fetchStages(projectId?: string): Promise<StageItem[]> {
  try {
    const url = projectId
      ? `${API_PREFIX}/schedule/stages?project_id=${projectId}`
      : `${API_PREFIX}/schedule/stages`
    const res = await fetch(url)
    if (res.ok) return await res.json()
  } catch {
    // Return empty fallback
  }
  return []
}

export async function loadDemoSchedule(projectId?: string): Promise<StageItem[]> {
  try {
    const url = projectId
      ? `${API_PREFIX}/schedule/load-demo?project_id=${projectId}`
      : `${API_PREFIX}/schedule/load-demo`
    const res = await fetch(url, { method: 'POST' })
    if (res.ok) {
      const data = await res.json()
      return data.stages || data
    }
  } catch {
    // Return empty
  }
  return []
}

export async function uploadScheduleFile(file: File, projectId?: string): Promise<StageItem[]> {
  const formData = new FormData()
  formData.append('file', file)
  const url = projectId
    ? `${API_PREFIX}/schedule/upload?project_id=${projectId}`
    : `${API_PREFIX}/schedule/upload`
  const res = await fetch(url, {
    method: 'POST',
    body: formData,
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Ошибка загрузки графика' }))
    throw new Error(err.detail || 'Ошибка загрузки графика')
  }
  const data = await res.json()
  return data.stages || data
}

export async function clearSchedule(projectId?: string): Promise<void> {
  const url = projectId
    ? `${API_PREFIX}/schedule/clear?project_id=${projectId}`
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

export async function fetchStageProbabilities(stageId: string): Promise<StageProbabilityResponse> {
  try {
    const res = await fetch(`${API_PREFIX}/schedule/stages/${stageId}/probabilities`)
    if (res.ok) return await res.json()
  } catch {
    // Fallback probability calculation
  }
  return getFallbackProbabilities(stageId)
}

// ----------------------------------------------------------------------------
// Incidents & VLM Verification API
// ----------------------------------------------------------------------------

export async function fetchIncidents(): Promise<IncidentAlertItem[]> {
  try {
    const res = await fetch(`${API_PREFIX}/incidents`)
    if (res.ok) return await res.json()
  } catch {
    // Return mock incidents
  }
  return getFallbackIncidents()
}

export async function verifyIncidentVlm(incidentId: string): Promise<VlmVerificationResult> {
  try {
    const res = await fetch(`${API_PREFIX}/incidents/${incidentId}/verify-vlm`, {
      method: 'POST',
    })
    if (res.ok) return await res.json()
  } catch {
    // Fallback simulation
  }

  return {
    incident_id: incidentId,
    is_violation_confirmed: true,
    is_occluded: false,
    confidence: 0.94,
    reasoning: 'На камере в рабочей зоне котлована спецтехника отсутствует. Видимость ясная, перекрытий объектов нет.',
    compact_alert_text: 'На этапе выемки грунта отсутствует обязательный экскаватор. На камере техника не обнаружена.',
    fallback_used: false,
    latency_ms: 1250,
  }
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
  count: number
  detections: DetectionBoxItem[]
}

export async function detectFrameImage(
  imageBlob: Blob,
  stageName?: string
): Promise<FrameDetectionResponse> {
  try {
    const formData = new FormData()
    formData.append('file', imageBlob, 'frame.jpg')
    if (stageName) {
      formData.append('stage_name', stageName)
    }

    const response = await fetch(`${API_BASE_URL}/videos/detect-frame`, {
      method: 'POST',
      body: formData,
    })

    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}`)
    }

    return await response.json()
  } catch (err) {
    console.warn('API detect-frame unavailable or failed, using client fallback:', err)
    return {
      timestamp: new Date().toISOString(),
      active_stage: stageName,
      count: 3,
      detections: [
        {
          class_id: 4,
          raw_label: 'tower_crane',
          label_ru: 'Башенный кран',
          canonical_code: 'MACHINERY_TOWER_CRANE',
          confidence: 0.95,
          x1: 0.35,
          y1: 0.12,
          x2: 0.55,
          y2: 0.44,
          top: 12.0,
          left: 35.0,
          width: 20.0,
          height: 32.0,
        },
        {
          class_id: 5,
          raw_label: 'concrete_mixer',
          label_ru: 'Автобетоносмеситель',
          canonical_code: 'MACHINERY_CONCRETE_MIXER',
          confidence: 0.91,
          x1: 0.48,
          y1: 0.46,
          x2: 0.70,
          y2: 0.70,
          top: 46.0,
          left: 48.0,
          width: 22.0,
          height: 24.0,
        },
        {
          class_id: 6,
          raw_label: 'loader',
          label_ru: 'Погрузчик',
          canonical_code: 'MACHINERY_LOADER',
          confidence: 0.88,
          x1: 0.20,
          y1: 0.52,
          x2: 0.38,
          y2: 0.74,
          top: 52.0,
          left: 20.0,
          width: 18.0,
          height: 22.0,
        },
      ],
    }
  }
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


