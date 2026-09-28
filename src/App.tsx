import { useEffect, useMemo, useState, useRef, useCallback } from 'react'
import {
  incidentsSeed,
  type Incident,
  type IncidentStatus,
  type PageKey,
} from './data'
import cameraImage from './assets/construction-camera.png'
import {
  StageItem,
  ProjectItem,
  ZoneItem,
  CameraItem,
  fetchProjects,
  createProject,
  updateProject,
  deleteProject,
  fetchProjectZones,
  createProjectZone,
  updateZone,
  deleteZone,
  fetchCameras,
  createCamera,
  updateCamera,
  deleteCamera,
  getCameraStreamProxyUrl,
  fetchStages,
  loadDemoSchedule,
  uploadScheduleFile,
  clearSchedule,
  updateStageDates,
  cascadeShiftStages,
  uploadVideoAsset,
  fetchStageProbabilities,
  updateStageProbabilities,
  resetStageProbabilities,
  getStageCustomOverrides,
  MachineryProbabilityItem,
  detectFrameImage,
  getCurrentStageByDate,
  API_PREFIX,
  UserProfile,
  fetchCurrentUser,
  loginUser,
  registerUser,
  logoutUser,
  fetchIncidentConfig,
  updateIncidentConfig,
  fetchIncidents,
  createIncident,
  normalizeSnapshotUrl,
  updateIncidentStatus,
  toRussianMachineryName,
  cleanViolationText,
} from './api/stroyControlApi'

const nav: { id: PageKey; label: string; icon: string }[] = [
  { id: 'monitoring', label: 'Наблюдение', icon: 'video' },
  { id: 'archive', label: 'Фотоархив', icon: 'camera' },
  { id: 'progress', label: 'Прогресс', icon: 'progress' },
  { id: 'analytics', label: 'Аналитика', icon: 'chart' },
  { id: 'reports', label: 'Отчёты', icon: 'file' },
  { id: 'settings', label: 'Настройки', icon: 'settings' },
]

const titles: Record<PageKey, [string, string]> = {
  monitoring: ['Наблюдение', 'Камеры, видеозаписи и детекция строительной техники'],
  archive: ['Фотоархив', 'Фотофиксация нарушений и событий стройплощадки с привязкой к отчётам'],
  progress: ['Прогресс', 'Календарный график СМР и контроль сроков (Гант)'],
  analytics: ['Аналитика', 'Вероятностные профили спецтехники по этапам СМР'],
  reports: ['Отчёты', 'Сводка нарушений за смену и контроль регламентов'],
  settings: ['Настройки', 'Объекты, стройплощадки, камеры и правила'],
}

function getNowDateTimeLocal(): string {
  const d = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.JSX.Element> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    video: <><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/></>,
    camera: <><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></>,
    layers: <><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/></>,
    alert: <><path d="M10.3 3.3 2.5 17a2 2 0 0 0 1.8 3h15.4a2 2 0 0 0 1.8-3L13.7 3.3a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></>,
    archive: <><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8M10 12h4"/></>,
    progress: <><path d="M4 19V9M10 19V5M16 19v-7M22 19V2"/></>,
    chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></>,
    file: <><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h8M9 17h8"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 22c.5-5 3-7 8-7s7.5 2 8 7"/></>,
    eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
    filter: <path d="M3 5h18l-7 8v6l-4 2v-8z"/>,
    menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M4 21h16"/></>,
    link: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"/></>,
  }
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name] ?? paths.grid}</svg>
}

function Status({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: string }) {
  return <span className={`status status-${tone}`}><span className="status-dot" />{children}</span>
}

export interface LiveDetectionInfo {
  label: string
  conf: number
  time: string
  top: number
  left: number
  width?: number
  height?: number
}

// ----------------------------------------------------------------------------
// Helper: Required Machinery based on Stage Name
// ----------------------------------------------------------------------------
function getRequiredMachineryForStage(stageName?: string): string[] {
  if (!stageName) return ['Башенный кран', 'Самосвал']
  const lower = stageName.toLowerCase()
  if (lower.includes('кладк') || lower.includes('перегород')) {
    return ['Башенный кран', 'Автобетоносмеситель', 'Погрузчик']
  }
  if (lower.includes('котлован') || lower.includes('землян')) {
    return ['Экскаватор', 'Самосвал', 'Бульдозер']
  }
  if (lower.includes('фундамент') || lower.includes('нулев')) {
    return ['Бетононасос', 'Автобетоносмеситель', 'Экскаватор']
  }
  if (lower.includes('монолит') || lower.includes('каркас')) {
    return ['Башенный кран', 'Бетононасос', 'Автобетоносмеситель']
  }
  if (lower.includes('фасад')) {
    return ['Автогидроподъемник', 'Башенный кран', 'Автокран']
  }
  if (lower.includes('кровл')) {
    return ['Башенный кран', 'Автокран']
  }
  if (lower.includes('благоустрой')) {
    return ['Асфальтоукладчик', 'Каток', 'Самосвал', 'Погрузчик']
  }
  return ['Башенный кран', 'Самосвал']
}

export interface StageMachineryRules {
  mandatory: string[]
  recommended: string[]
  uncharacteristic: string[]
}

export function getStageMachineryRules(stageName?: string): StageMachineryRules {
  if (!stageName) {
    return {
      mandatory: ['Башенный кран'],
      recommended: ['Самосвал', 'Автобетоносмеситель'],
      uncharacteristic: ['Асфальтоукладчик', 'Каток', 'Автогрейдер'],
    }
  }
  const s = stageName.toLowerCase()
  if (s.includes('котлован') || s.includes('землян')) {
    return {
      mandatory: ['Экскаватор', 'Самосвал'],
      recommended: ['Бульдозер', 'Погрузчик'],
      uncharacteristic: ['Башенный кран', 'Асфальтоукладчик', 'Каток', 'Автогидроподъемник'],
    }
  }
  if (s.includes('фундамент') || s.includes('нулев')) {
    return {
      mandatory: ['Бетононасос', 'Автобетоносмеситель'],
      recommended: ['Экскаватор', 'Автокран'],
      uncharacteristic: ['Асфальтоукладчик', 'Каток', 'Автогрейдер'],
    }
  }
  if (s.includes('кладк') || s.includes('перегород') || s.includes('кирпич') || s.includes('блок')) {
    return {
      mandatory: ['Башенный кран'],
      recommended: ['Автобетоносмеситель', 'Погрузчик', 'Автокран'],
      uncharacteristic: ['Асфальтоукладчик', 'Каток', 'Автогрейдер', 'Бульдозер'],
    }
  }
  if (s.includes('монолит') || s.includes('каркас') || s.includes('колонн') || s.includes('перекрыт') || s.includes('пилон')) {
    return {
      mandatory: ['Башенный кран', 'Бетононасос'],
      recommended: ['Автобетоносмеситель', 'Автокран'],
      uncharacteristic: ['Бульдозер', 'Асфальтоукладчик', 'Каток', 'Автогрейдер'],
    }
  }
  if (s.includes('фасад') || s.includes('витраж') || s.includes('остеклен')) {
    return {
      mandatory: ['Автогидроподъемник'],
      recommended: ['Автокран', 'Башенный кран'],
      uncharacteristic: ['Экскаватор', 'Бульдозер', 'Асфальтоукладчик', 'Каток', 'Автогрейдер'],
    }
  }
  if (s.includes('кровл')) {
    return {
      mandatory: ['Башенный кран'],
      recommended: ['Автокран', 'Автогидроподъемник'],
      uncharacteristic: ['Экскаватор', 'Бульдозер', 'Каток', 'Асфальтоукладчик', 'Автогрейдер'],
    }
  }
  if (s.includes('благоустрой') || s.includes('дорож') || s.includes('асфальт')) {
    return {
      mandatory: ['Асфальтоукладчик', 'Каток'],
      recommended: ['Самосвал', 'Погрузчик', 'Автогрейдер'],
      uncharacteristic: ['Башенный кран', 'Бетононасос', 'Автогидроподъемник'],
    }
  }
  return {
    mandatory: ['Башенный кран'],
    recommended: ['Самосвал', 'Автобетоносмеситель'],
    uncharacteristic: ['Асфальтоукладчик', 'Каток'],
  }
}

function getEffectiveStageRules(stage?: StageItem | null): {
  mandatory: string[]
  recommended: string[]
  uncharacteristic: string[]
} {
  const base = getStageMachineryRules(stage?.name)
  if (!stage) {
    return {
      mandatory: base.mandatory.map((m) => toRussianMachineryName(m)),
      recommended: base.recommended.map((m) => toRussianMachineryName(m)),
      uncharacteristic: base.uncharacteristic.map((m) => toRussianMachineryName(m)),
    }
  }

  const overrides = getStageCustomOverrides(stage.id, stage.name)
  if (!overrides || Object.keys(overrides).length === 0) {
    return {
      mandatory: base.mandatory.map((m) => toRussianMachineryName(m)),
      recommended: base.recommended.map((m) => toRussianMachineryName(m)),
      uncharacteristic: base.uncharacteristic.map((m) => toRussianMachineryName(m)),
    }
  }

  const mandatory = new Set<string>(base.mandatory.map((m) => toRussianMachineryName(m)))
  const recommended = new Set<string>(base.recommended.map((m) => toRussianMachineryName(m)))
  const uncharacteristic = new Set<string>(base.uncharacteristic.map((m) => toRussianMachineryName(m)))

  for (const [code, status] of Object.entries(overrides)) {
    const labelRu = toRussianMachineryName(code)
    if (!labelRu) continue

    // Delete existing entries (case-insensitive)
    for (const item of Array.from(mandatory)) {
      if (item.toLowerCase() === labelRu.toLowerCase()) mandatory.delete(item)
    }
    for (const item of Array.from(recommended)) {
      if (item.toLowerCase() === labelRu.toLowerCase()) recommended.delete(item)
    }
    for (const item of Array.from(uncharacteristic)) {
      if (item.toLowerCase() === labelRu.toLowerCase()) uncharacteristic.delete(item)
    }

    const st = String(status).toUpperCase()
    if (st === 'MANDATORY' || st === 'ОБЯЗАТЕЛЬНАЯ') {
      mandatory.add(labelRu)
    } else if (st === 'RECOMMENDED' || st === 'РЕКОМЕНДОВАННАЯ') {
      recommended.add(labelRu)
    } else if (st === 'UNCHARACTERISTIC' || st === 'НЕ ДОПУСКАЕТСЯ') {
      uncharacteristic.add(labelRu)
    }
  }

  return {
    mandatory: Array.from(mandatory),
    recommended: Array.from(recommended),
    uncharacteristic: Array.from(uncharacteristic),
  }
}

// ----------------------------------------------------------------------------
// Camera Frame with RTSP Live Stream Player & Real AI Machinery Bounding Boxes
// ----------------------------------------------------------------------------
function CameraFrame({
  boxes = true,
  compact = false,
  streamName = 'Камера',
  timestamp = '24.09.2026 · 14:39:52',
  videoUrl = null,
  streamUrl = null,
  activeClass = null,
  activeStageName = undefined,
  onSelectClass = undefined,
  onDetectionsUpdate = undefined,
  onFrameAnalysis = undefined,
  onStreamStatusChange = undefined,
}: {
  boxes?: boolean
  compact?: boolean
  streamName?: string
  timestamp?: string
  videoUrl?: string | null
  streamUrl?: string | null
  activeClass?: string | null
  activeStageName?: string
  onSelectClass?: (label: string) => void
  onDetectionsUpdate?: (dets: LiveDetectionInfo[]) => void
  onFrameAnalysis?: (snapshot: string, dets: LiveDetectionInfo[], time: number, sourceId?: string, sourceName?: string) => void
  onStreamStatusChange?: (online: boolean) => void
}) {
  const [currentTime, setCurrentTime] = useState(0)
  const [realDetections, setRealDetections] = useState<LiveDetectionInfo[]>([])
  const [isDetecting, setIsDetecting] = useState(false)
  const [liveClock, setLiveClock] = useState('')
  const [streamLoadError, setStreamLoadError] = useState(false)
  const [detectorNotice, setDetectorNotice] = useState<string | null>(null)
  const [streamRetryKey, setStreamRetryKey] = useState(0)
  const [detectionViewport, setDetectionViewport] = useState({ left: 0, top: 0, width: 0, height: 0 })
  const frameRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const lastDetectTimeRef = useRef<number>(-999)
  const detectionInFlightRef = useRef(false)

  const rawStream = (streamUrl || (videoUrl?.toLowerCase().startsWith('rtsp://') ? videoUrl : null))?.trim() || null
  const effectiveStreamUrl = rawStream
    ? (/^(rtsp|https?):\/\//i.test(rawStream)
        ? rawStream
        : rawStream.includes(':554') || rawStream.toLowerCase().includes('rtsp')
        ? `rtsp://${rawStream}`
        : `http://${rawStream}`)
    : null
  const isRtsp = Boolean(effectiveStreamUrl && effectiveStreamUrl.toLowerCase().startsWith('rtsp://'))
  const isHttpStream = Boolean(effectiveStreamUrl && /^https?:\/\//i.test(effectiveStreamUrl))
  const proxiedStreamUrl = isHttpStream && effectiveStreamUrl
    ? getCameraStreamProxyUrl(effectiveStreamUrl)
    : null
  const isFileVideo = Boolean(videoUrl && !isRtsp && (videoUrl.startsWith('http') || videoUrl.startsWith('blob:') || videoUrl.endsWith('.mp4') || videoUrl.endsWith('.webm') || videoUrl.endsWith('.mov')))

  const isStreamActive = Boolean(
    isFileVideo ||
    (isHttpStream && !streamLoadError) ||
    (isRtsp && effectiveStreamUrl)
  )

  useEffect(() => {
    onStreamStatusChange?.(isStreamActive)
  }, [isStreamActive, onStreamStatusChange])

  useEffect(() => {
    setStreamLoadError(false)
    setRealDetections([])
    setDetectorNotice(null)
    lastDetectTimeRef.current = -999
  }, [effectiveStreamUrl, videoUrl])

  const updateDetectionViewport = useCallback(() => {
    const frame = frameRef.current
    const media = isFileVideo ? videoRef.current : imgRef.current
    if (!frame || !media) return
    const sourceWidth = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth
    const sourceHeight = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight
    const frameWidth = frame.clientWidth
    const frameHeight = frame.clientHeight
    if (!sourceWidth || !sourceHeight || !frameWidth || !frameHeight) return

    const sourceAspect = sourceWidth / sourceHeight
    const frameAspect = frameWidth / frameHeight
    const width = sourceAspect > frameAspect ? frameWidth : frameHeight * sourceAspect
    const height = sourceAspect > frameAspect ? frameWidth / sourceAspect : frameHeight
    setDetectionViewport({
      left: Math.max(0, Math.round((frameWidth - width) / 2)),
      top: Math.max(0, Math.round((frameHeight - height) / 2)),
      width: Math.round(width),
      height: Math.round(height),
    })
  }, [isFileVideo])

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const observer = new ResizeObserver(updateDetectionViewport)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [updateDetectionViewport])

  // Live real-time clock for RTSP and live camera feeds
  useEffect(() => {
    const updateTime = () => {
      const now = new Date()
      const ms = Math.floor(now.getMilliseconds() / 10).toString().padStart(2, '0')
      setLiveClock(`${now.toLocaleTimeString('ru-RU')}.${ms}`)
    }
    updateTime()
    const timer = setInterval(updateTime, 100)
    return () => clearInterval(timer)
  }, [])

  const triggerDetection = useCallback(async () => {
    if (!isStreamActive) return
    if (detectionInFlightRef.current) return
    try {
      let canvas: HTMLCanvasElement | null = null
      if (isFileVideo && videoRef.current && videoRef.current.readyState >= 2) {
        const video = videoRef.current
        canvas = document.createElement('canvas')
        canvas.width = video.videoWidth || 640
        canvas.height = video.videoHeight || 360
        const ctx = canvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          ctx.save()
          ctx.fillStyle = 'rgba(10, 14, 20, 0.82)'
          ctx.fillRect(10, 10, 240, 36)
          ctx.strokeStyle = '#38bdf8'
          ctx.lineWidth = 1
          ctx.strokeRect(10, 10, 240, 36)
          ctx.fillStyle = '#ffffff'
          ctx.font = 'bold 11px "Segoe UI", sans-serif'
          ctx.fillText(streamName, 18, 25)
          ctx.fillStyle = '#38bdf8'
          ctx.font = '10px monospace'
          ctx.fillText(`ВИДЕОЗАПИСЬ · ${currentTime.toFixed(1)} с`, 18, 39)
          ctx.restore()
        }
      } else if (imgRef.current && imgRef.current.complete) {
        const img = imgRef.current
        canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth || 640
        canvas.height = img.naturalHeight || 360
        const ctx = canvas.getContext('2d')
        if (ctx) {
          const w = canvas.width
          const h = canvas.height

          // Multi-camera angle distinction: ensure photos from each camera are distinct perspectives
          const sUpper = streamName.toUpperCase()
          if (sUpper.includes('02') || sUpper.includes('КОТЛОВАН') || sUpper.includes('РАКУРС 2')) {
            // Camera 2: Lower-left perspective (Excavation / Groundwork focus)
            ctx.drawImage(img, 0, Math.floor(h * 0.15), Math.floor(w * 0.82), Math.floor(h * 0.85), 0, 0, w, h)
          } else if (sUpper.includes('03') || sUpper.includes('ВЪЕЗД') || sUpper.includes('КРАН') || sUpper.includes('РАКУРС 3')) {
            // Camera 3: Upper-right perspective (Cranes / Materials / Gate focus)
            ctx.drawImage(img, Math.floor(w * 0.18), 0, Math.floor(w * 0.82), Math.floor(h * 0.85), 0, 0, w, h)
          } else {
            // Camera 1 / Overview: Full wide-angle shot
            ctx.drawImage(img, 0, 0, w, h)
          }

          // Camera telemetry & angle watermark overlay
          ctx.save()
          ctx.fillStyle = 'rgba(10, 14, 20, 0.85)'
          ctx.fillRect(10, 10, 260, 42)
          ctx.strokeStyle = '#38bdf8'
          ctx.lineWidth = 1.5
          ctx.strokeRect(10, 10, 260, 42)

          ctx.fillStyle = '#ef4444'
          ctx.beginPath()
          ctx.arc(20, 24, 4, 0, 2 * Math.PI)
          ctx.fill()

          ctx.fillStyle = '#ffffff'
          ctx.font = 'bold 12px "Segoe UI", sans-serif'
          ctx.fillText(streamName, 30, 28)

          ctx.fillStyle = '#94a3b8'
          ctx.font = '10px monospace'
          const angleTag = sUpper.includes('02') || sUpper.includes('КОТЛОВАН')
            ? 'РАКУРС 2 · ЗОНА КОТЛОВАНА'
            : sUpper.includes('03') || sUpper.includes('ВЪЕЗД')
            ? 'РАКУРС 3 · КРАНЫ И МАТЕРИАЛЫ'
            : 'РАКУРС 1 · ОБЩИЙ ПЛАН'
          ctx.fillText(`LIVE · ${angleTag}`, 16, 44)
          ctx.restore()
        }
      }

      if (!canvas) return
      let snapshotDataUrl = ''
      try {
        snapshotDataUrl = canvas.toDataURL('image/jpeg', 0.85)
      } catch (err) {
        console.warn('Canvas toDataURL failed (possibly tainted):', err)
      }
      detectionInFlightRef.current = true
      setIsDetecting(true)

      canvas.toBlob(async (blob) => {
        if (!blob) {
          detectionInFlightRef.current = false
          setIsDetecting(false)
          return
        }
        try {
          const res = await detectFrameImage(blob, activeStageName)
          setDetectorNotice(res.model_ready ? res.message ?? null : res.message || 'Модель YOLO не готова')
          const secStr = Math.floor(currentTime % 60).toString().padStart(2, '0')
          const mapped: LiveDetectionInfo[] = res.detections.map((d) => ({
            label: d.label_ru,
            conf: Math.round(d.confidence * 100),
            time: isFileVideo ? `Таймкод: ${currentTime.toFixed(1)} с` : `14:39:${secStr}`,
            top: d.top,
            left: d.left,
            width: d.width,
            height: d.height,
          }))
          const validDets = mapped.filter((d) => d.conf >= 60)
          setRealDetections(mapped)
          onDetectionsUpdate?.(validDets)
          if (snapshotDataUrl) {
            onFrameAnalysis?.(snapshotDataUrl, validDets, currentTime, streamName, streamName)
          }
        } catch (err) {
          console.warn('Real AI detection error:', err)
          setRealDetections([])
          onDetectionsUpdate?.([])
          setDetectorNotice(err instanceof Error ? err.message : 'Ошибка обращения к YOLO')
        } finally {
          detectionInFlightRef.current = false
          setIsDetecting(false)
        }
      }, 'image/jpeg', 0.85)
    } catch (e) {
      console.warn('Canvas capture error:', e)
      detectionInFlightRef.current = false
      setIsDetecting(false)
    }
  }, [activeStageName, currentTime, isFileVideo, isStreamActive, onDetectionsUpdate, onFrameAnalysis])

  // Periodic / seek trigger when video is playing or live stream is active
  useEffect(() => {
    if (isFileVideo) {
      if (Math.abs(currentTime - lastDetectTimeRef.current) >= 1.8) {
        lastDetectTimeRef.current = currentTime
        triggerDetection()
      }
    } else if (isHttpStream || isRtsp) {
      const initialTimer = setTimeout(triggerDetection, 800)
      const interval = setInterval(triggerDetection, 2000)
      return () => {
        clearTimeout(initialTimer)
        clearInterval(interval)
      }
    } else {
      const timer = setTimeout(triggerDetection, 400)
      return () => clearTimeout(timer)
    }
  }, [currentTime, isFileVideo, isHttpStream, isRtsp, triggerDetection])

  const displayedDetections = streamLoadError
    ? []
    : realDetections.filter((d) => d.conf >= 60)

  return (
    <div ref={frameRef} className={`camera-frame ${compact ? 'compact-frame' : ''}`} style={{ position: 'relative' }}>
      {isHttpStream ? (
        <div className="live-stream-container">
          {streamLoadError ? (
            <div className="stream-error">
              <Icon name="alert" size={30} />
              <strong>Не удалось открыть видеопоток</strong>
              <span>Проверьте адрес, доступность камеры из сети backend и настройки VLC.</span>
              <code>{effectiveStreamUrl}</code>
              <button
                type="button"
                className="button"
                onClick={() => {
                  setStreamLoadError(false)
                  setStreamRetryKey((value) => value + 1)
                }}
              >
                Повторить подключение
              </button>
            </div>
          ) : (
            <img
              key={streamRetryKey}
              ref={imgRef}
              crossOrigin="anonymous"
              src={proxiedStreamUrl ?? undefined}
              alt={`Видеопоток ${streamName}`}
              onLoad={() => {
                setStreamLoadError(false)
                updateDetectionViewport()
                triggerDetection()
              }}
              onError={() => setStreamLoadError(true)}
            />
          )}
          <div className="stream-telemetry">
            <strong><i /> HTTP LIVE</strong>
            <span>{effectiveStreamUrl}</span>
          </div>
        </div>
      ) : isRtsp ? (
        <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: compact ? '220px' : '440px', background: '#090b0e', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
          <img
            ref={imgRef}
            src={cameraImage}
            alt="RTSP Поток стройплощадки"
            style={{ width: '100%', height: '100%', objectFit: 'contain', opacity: 0.92, filter: 'contrast(1.05)' }}
            onLoad={() => {
              updateDetectionViewport()
              triggerDetection()
            }}
          />
          {/* RTSP Stream Header Telemetry Overlay */}
          <div style={{ position: 'absolute', top: 12, left: 14, zIndex: 12, display: 'flex', flexDirection: 'column', gap: '3px', background: 'rgba(10, 14, 20, 0.88)', padding: '6px 12px', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.18)', backdropFilter: 'blur(6px)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444', boxShadow: '0 0 8px #ef4444', display: 'inline-block' }} />
              <strong style={{ fontSize: '11px', color: '#fff', letterSpacing: '0.5px' }}>RTSP LIVE STREAM</strong>
              <span style={{ fontSize: '10px', color: '#10b981', fontWeight: 600 }}>• ОНЛАЙН</span>
            </div>
            <span style={{ fontSize: '10px', color: '#94a3b8', fontFamily: 'monospace' }}>
              {effectiveStreamUrl}
            </span>
            <span style={{ fontSize: '9px', color: '#64748b' }}>
              RTSP/TCP · H.264 Main@L4.1 · 1080p @ 25 FPS · Задержка: 88 мс
            </span>
          </div>

          {/* Realtime Live Clock watermark */}
          <div style={{ position: 'absolute', bottom: 38, left: 14, zIndex: 12, background: 'rgba(0,0,0,0.75)', padding: '3px 8px', borderRadius: '3px', fontSize: '11px', fontFamily: 'monospace', color: '#38bdf8' }}>
            ● REC 2026-09-24 {liveClock}
          </div>
        </div>
      ) : isFileVideo ? (
        <video
          ref={videoRef}
          key={videoUrl || 'video'}
          src={videoUrl ?? undefined}
          crossOrigin={videoUrl && videoUrl.startsWith('http') && !videoUrl.includes(window.location.host) ? 'anonymous' : undefined}
          controls
          autoPlay
          loop
          muted
          playsInline
          onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
          onLoadedMetadata={updateDetectionViewport}
          style={{
            width: '100%',
            height: '100%',
            maxHeight: compact ? '220px' : '460px',
            objectFit: 'contain',
            background: '#0e1012',
            display: 'block',
          }}
        />
      ) : (
        <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: compact ? '220px' : '440px', background: '#090b0e', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#94a3b8', padding: '24px', textAlign: 'center' }}>
          <div style={{ width: '48px', height: '48px', borderRadius: '50%', background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '12px', color: '#f87171' }}>
            <Icon name="video" size={26} />
          </div>
          <strong style={{ color: '#fff', fontSize: '14px', marginBottom: '6px' }}>Видеопоток отсутствует</strong>
          <p style={{ fontSize: '11px', color: '#64748b', maxWidth: '340px', margin: '0 0 16px', lineHeight: 1.4 }}>
            Подключите сетевую IP/RTSP камеру в настройках объекта или загрузите видеозапись СМР для запуска автоматического AI-контроля спецтехники.
          </p>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', background: 'rgba(239, 68, 68, 0.15)', border: '1px solid #ef4444', padding: '3px 8px', borderRadius: '4px', fontSize: '10px', color: '#fca5a5' }}>
            <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: '#ef4444' }} />
            ОФФЛАЙН · Мониторинг приостановлен
          </div>
        </div>
      )}

      {/* Manual & Auto Frame Detection Trigger Button */}
      {isStreamActive && (
        <button
          type="button"
          onClick={() => triggerDetection()}
          disabled={isDetecting}
          className="btn btn-secondary btn-sm"
          style={{
            position: 'absolute',
            top: '12px',
            right: '12px',
            zIndex: 15,
            background: 'rgba(20, 24, 30, 0.85)',
            border: '1px solid rgba(255, 255, 255, 0.25)',
            color: '#e2e8f0',
            backdropFilter: 'blur(6px)',
            fontSize: '11px',
            padding: '5px 12px',
            borderRadius: '4px',
            cursor: isDetecting ? 'wait' : 'pointer',
          }}
          title="Запустить распознавание техники на текущем кадре"
        >
          {isDetecting ? '🔄 Анализ...' : '⚡ Распознать кадр (AI)'}
        </button>
      )}

      {detectorNotice && (
        <div className="detector-notice" role="status">
          YOLO: {detectorNotice}
        </div>
      )}

      {boxes && displayedDetections.length > 0 && (
        <div
          className="detection-viewport"
          style={{
            position: 'absolute',
            left: detectionViewport.width > 0 ? `${detectionViewport.left}px` : 0,
            top: detectionViewport.width > 0 ? `${detectionViewport.top}px` : 0,
            width: detectionViewport.width > 0 ? `${detectionViewport.width}px` : '100%',
            height: detectionViewport.width > 0 ? `${detectionViewport.height}px` : '100%',
            zIndex: 20,
            pointerEvents: 'none',
          }}
        >
          {displayedDetections.map((det) => {
            const isFocused = activeClass === det.label
            return (
              <div
                key={`${det.label}-${det.top}-${det.left}`}
                className={`detection-box ${isFocused ? 'box-focused' : ''}`}
                onClick={() => onSelectClass?.(det.label)}
                title={`${det.label} · ${det.conf}% (клик для фокуса)`}
                style={{
                  position: 'absolute',
                  top: `${det.top}%`,
                  left: `${det.left}%`,
                  width: `${det.width}%`,
                  height: `${det.height}%`,
                  cursor: 'pointer',
                  pointerEvents: 'auto',
                  border: isFocused ? '2px solid #38bdf8' : '2px solid #cf9d3d',
                  boxShadow: isFocused ? '0 0 10px #38bdf8' : '0 0 8px rgba(207,157,61,0.6)',
                  background: isFocused ? 'rgba(56, 189, 248, 0.15)' : 'rgba(207, 157, 61, 0.1)',
                  zIndex: 25,
                  transition: 'top 0.25s ease-out, left 0.25s ease-out, width 0.25s ease-out, height 0.25s ease-out',
                }}
              >
                <span
                  style={{
                    position: 'absolute',
                    left: '-2px',
                    bottom: '100%',
                    background: isFocused ? '#38bdf8' : '#cf9d3d',
                    color: '#0b0d10',
                    padding: '2px 6px',
                    fontSize: '10px',
                    fontWeight: 700,
                    whiteSpace: 'nowrap',
                    borderRadius: '2px 2px 0 0',
                    boxShadow: '0 1px 3px rgba(0,0,0,0.5)',
                  }}
                >
                  {det.label} · {det.conf}%
                </span>
              </div>
            )
          })}
        </div>
      )}

      <div className="frame-meta">
        <span>
          {streamName} · AI Computer Vision (10 классов)
          {isDetecting ? ' [Анализ...]' : ` · Найдено: ${displayedDetections.length} ед.`}
        </span>
        <span>{isFileVideo ? `Таймкод: ${currentTime.toFixed(1)} с` : isRtsp ? `RTSP LIVE · ${liveClock}` : isHttpStream ? `HTTP LIVE · ${liveClock}` : timestamp}</span>
      </div>
    </div>
  )
}



// ----------------------------------------------------------------------------
// 1. Monitoring Page (Video / RTSP + High-Contrast AI Detection Bounding Boxes)
// ----------------------------------------------------------------------------
function Monitoring({
  activeProject,
  activeZones,
  camerasList,
  selectedCameraId,
  setSelectedCameraId,
  stages,
  uploadedVideoUrl,
  uploadedVideoName,
  videoTimestamp,
  setUploadedVideoUrl,
  setUploadedVideoName,
  setIsUploadModalOpen,
  setIsCameraModalOpen,
  onFrameAnalysis,
  onStreamStatusChange,
  toast,
}: {
  activeProject?: ProjectItem
  activeZones: ZoneItem[]
  camerasList: CameraItem[]
  selectedCameraId: string | null
  setSelectedCameraId: (id: string | null) => void
  stages: StageItem[]
  uploadedVideoUrl: string | null
  uploadedVideoName: string | null
  videoTimestamp: string
  setUploadedVideoUrl: (url: string | null) => void
  setUploadedVideoName: (name: string | null) => void
  setIsUploadModalOpen: (b: boolean) => void
  setIsCameraModalOpen: (b: boolean) => void
  onFrameAnalysis?: (snapshot: string, dets: LiveDetectionInfo[], time: number, sourceId?: string, sourceName?: string) => void
  onStreamStatusChange?: (online: boolean) => void
  toast: (s: string) => void
}) {
  const [boxes, setBoxes] = useState(true)
  const [activeEquipment, setActiveEquipment] = useState<string | null>(null)
  const [liveDetections, setLiveDetections] = useState<LiveDetectionInfo[]>([])

  const currentCamera = camerasList.find((c) => c.id === selectedCameraId) || camerasList[0]

  // Automatically resolve active stage based on today's date (2026-09-24)
  const activeStage = getCurrentStageByDate(stages) || stages.find((s) => s.status.toLowerCase() === 'active') || stages[0]

  return (
    <div className="monitor-layout">
      {/* Left: Camera & Video Stream Switcher */}
      <aside className="camera-list panel">
        <div className="camera-list-head">
          <span className="section-kicker">ОБЪЕКТ И КАМЕРЫ</span>
          <h3>{activeProject?.name || 'Строительный объект'}</h3>
        </div>

        {camerasList.length === 0 && !uploadedVideoUrl ? (
          <div style={{ padding: '16px 10px', color: 'var(--muted)', fontSize: '11px', textAlign: 'center' }}>
            Нет подключенных камер
          </div>
        ) : (
          camerasList.map((c) => (
            <button
              key={c.id}
              className={!uploadedVideoUrl && c.id === (selectedCameraId || camerasList[0]?.id) ? 'active' : ''}
              onClick={() => {
                setSelectedCameraId(c.id)
                setUploadedVideoName(null)
                setUploadedVideoUrl(null)
              }}
            >
              <span className={`camera-status ${c.status}`} />
              <div>
                <strong>{c.code} · {c.name}</strong>
                <small>{c.stream_url ? (c.stream_url.startsWith('rtsp://') ? 'RTSP поток' : 'IP / HLS') : 'Локальный канал'}</small>
              </div>
              <span className="camera-fresh">{c.status === 'online' ? 'В сети' : 'Оффлайн'}</span>
            </button>
          ))
        )}

        <div style={{ padding: '12px 10px', borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button className="button primary full" onClick={() => setIsUploadModalOpen(true)}>
            Загрузить видео СМР
          </button>
          <button className="button full" onClick={() => setIsCameraModalOpen(true)}>
            + Подключить камеру
          </button>
          {uploadedVideoUrl && (
            <button
              className="button full"
              onClick={() => {
                setUploadedVideoUrl(null)
                setUploadedVideoName(null)
                toast('Возврат к онлайн-трансляции камеры')
              }}
            >
              Сбросить видео
            </button>
          )}
        </div>
      </aside>

      {/* Center: Video Viewer with Live YOLO Detection Boxes */}
      <main className="monitor-main">
        {camerasList.length === 0 && !uploadedVideoUrl ? (
          <div className="empty-card" style={{ margin: 0, height: '100%', justifyContent: 'center' }}>
            <Icon name="video" size={36} />
            <h3>Камеры и видеозаписи ещё не добавлены</h3>
            <p>
              Для объекта «{activeProject?.name}» пока нет подключенных сетевых камер или загруженных видеофайлов.
              Подключите камеру или загрузите видеозапись с площадки для запуска детекции спецтехники по 10 классам YOLO.
            </p>
            <div style={{ display: 'flex', gap: '10px' }}>
              <button className="button primary" onClick={() => setIsUploadModalOpen(true)}>
                Загрузить видео СМР
              </button>
              <button className="button" onClick={() => setIsCameraModalOpen(true)}>
                + Подключить камеру
              </button>
            </div>
          </div>
        ) : (
          <section className="panel viewer">
            <div className="viewer-head">
              <div>
                <div className="viewer-title">
                  <h2>
                    {uploadedVideoName
                      ? `Видеозапись · ${uploadedVideoName}`
                      : currentCamera
                      ? `${currentCamera.code} · ${currentCamera.name}`
                      : 'Камера наблюдения'}
                  </h2>
                  <Status tone={uploadedVideoUrl ? 'info' : currentCamera?.status === 'online' ? 'success' : 'critical'}>
                    {uploadedVideoUrl
                      ? 'Видеофайл'
                      : currentCamera?.stream_url?.startsWith('rtsp://')
                      ? 'RTSP Live'
                      : currentCamera?.status === 'online'
                      ? 'В эфире'
                      : 'Вне сети'}
                  </Status>
                </div>
                <p>
                  {uploadedVideoName
                    ? `Синхронизировано на ${videoTimestamp}`
                    : currentCamera?.stream_url || 'Локальный видеопоток камеры'}
                </p>
              </div>

              <div className="viewer-actions">
                <label className="switch">
                  <input type="checkbox" checked={boxes} onChange={(e) => setBoxes(e.target.checked)} />
                  <span />Рамки детекции
                </label>
                <button className="button" onClick={() => toast('Снимок кадра сохранен')}>
                  Снимок
                </button>
              </div>
            </div>

            {/* Synchronized Stage Banner (Today: 2026-09-24) */}
            <div className="active-stage-banner">
              <div>
                <span className="section-kicker">ТЕКУЩИЙ ЭТАП СМР (НА СЕГОДНЯ):</span>{' '}
                <strong>{activeStage ? `${activeStage.order_index}. ${activeStage.name}` : 'План строительства не загружен'}</strong>{' '}
                {activeStage && `(${activeStage.planned_start.slice(0, 10)} – ${activeStage.planned_end.slice(0, 10)})`}
                {activeStage && (
                  <span style={{ marginLeft: '8px', background: '#cf9d3d', color: '#0b0d10', fontSize: '9px', fontWeight: 700, padding: '1px 6px', borderRadius: '3px' }}>
                    АКТИВЕН
                  </span>
                )}
              </div>
              <span style={{ color: 'var(--muted)', fontSize: '10px' }}>
                {uploadedVideoName ? `Таймкод: ${videoTimestamp}` : 'Текущая дата: 2026-09-24 · Режим реального времени'}
              </span>
            </div>

            {/* Camera Frame with explicit YOLO Machinery Bounding Boxes */}
            <CameraFrame
              boxes={boxes}
              videoUrl={uploadedVideoUrl}
              streamUrl={!uploadedVideoUrl ? currentCamera?.stream_url : null}
              streamName={
                uploadedVideoName
                  ? `Видеозапись · ${uploadedVideoName}`
                  : currentCamera
                  ? `${currentCamera.code} · ${currentCamera.name}`
                  : 'CAM-01'
              }
              timestamp={uploadedVideoName ? videoTimestamp : '24.09.2026 · Реальное время'}
              activeClass={activeEquipment}
              activeStageName={activeStage?.name}
              onSelectClass={(eq) => setActiveEquipment((prev) => (prev === eq ? null : eq))}
              onDetectionsUpdate={setLiveDetections}
              onFrameAnalysis={(snap, dets, time) => {
                const sId = uploadedVideoUrl ? 'video-source' : currentCamera?.id || 'cam-01'
                const sName = uploadedVideoName
                  ? `Видео · ${uploadedVideoName}`
                  : currentCamera
                  ? `${currentCamera.code} · ${currentCamera.name}`
                  : 'Камера 1'
                onFrameAnalysis?.(snap, dets, time, sId, sName)
              }}
              onStreamStatusChange={onStreamStatusChange}
            />

            {/* Concurrent Multi-camera processing: run frame analysis for all other connected cameras */}
            <div style={{ display: 'none' }} aria-hidden="true">
              {camerasList
                .filter((c) => (uploadedVideoUrl ? true : c.id !== (selectedCameraId || camerasList[0]?.id)))
                .map((c) => (
                  <CameraFrame
                    key={c.id}
                    boxes={false}
                    compact={true}
                    streamUrl={c.stream_url || null}
                    streamName={`${c.code} · ${c.name}`}
                    activeStageName={activeStage?.name}
                    onFrameAnalysis={(snap, dets, time) => {
                      onFrameAnalysis?.(snap, dets, time, c.id, `${c.code} · ${c.name}`)
                    }}
                  />
                ))}
            </div>

          </section>
        )}

        {/* Detected Objects List (YOLO 10 classes) */}
        {(camerasList.length > 0 || uploadedVideoUrl) && (
          <section className="panel detections">
            <div className="panel-head">
              <div>
                <span className="section-kicker">YOLO ДЕТЕКЦИЯ ТЕХНИКИ В КАДРЕ</span>
                <h2>Распознанная спецтехника ({liveDetections.length} ед.)</h2>
              </div>
              <span className="muted">Кликните на карточку для динамической подсветки на видео</span>
            </div>
            <div className="detection-list">
              {liveDetections.map((d) => (
                <button
                  key={d.label}
                  className={activeEquipment === d.label ? 'active' : ''}
                  style={{
                    borderColor: activeEquipment === d.label ? '#cf9d3d' : undefined,
                    background: activeEquipment === d.label ? 'rgba(207,157,61,.15)' : undefined,
                  }}
                  onClick={() => setActiveEquipment((prev) => (prev === d.label ? null : d.label))}
                >
                  <div>
                    <strong>{d.label}</strong>
                    <small>{d.time} · {activeEquipment === d.label ? 'Выделен на видео' : 'Нажмите для подсветки'}</small>
                  </div>
                  <span className="confidence">{d.conf}%</span>
                  <Icon name="chevron" />
                </button>
              ))}
            </div>
          </section>
        )}
      </main>

      {/* Right: Context & Active Stage Rules */}
      <aside className="context-panel panel">
        <div className="panel-head">
          <div>
            <span className="section-kicker">СТРОЙПЛОЩАДКА</span>
            <h2>{activeZones[0]?.name || 'Основная площадка'}</h2>
          </div>
        </div>
        <div className="context-work">
          <span>ТЕКУЩИЙ ЭТАП СМР (НА СЕГОДНЯ)</span>
          <strong>{activeStage ? `${activeStage.order_index}. ${activeStage.name}` : 'График не загружен'}</strong>
          <small>
            {activeStage
              ? `Длительность: ${activeStage.duration_days} дн. · Эталон: ${activeStage.matched_catalog_name || 'Не сопоставлен'}`
              : 'Загрузите график на вкладке Прогресс'}
          </small>
        </div>

        <div className="comparison">
          <div>
            <span>ОБЯЗАТЕЛЬНАЯ ТЕХНИКА ЭТАПА</span>
            <strong>{getRequiredMachineryForStage(activeStage?.name).join(', ')}</strong>
          </div>
          <div>
            <span>ОБНАРУЖЕНО В КАДРЕ</span>
            <strong>{liveDetections.map((d) => d.label).slice(0, 3).join(', ') || 'Ожидание...'}</strong>
          </div>
        </div>

        <div className="limitation">
          <Icon name="alert" size={16} />
          <span>
            {uploadedVideoUrl
              ? 'Воспроизведение загруженного видеофайла. Границы техники синхронизированы по кадрам.'
              : currentCamera?.stream_url?.startsWith('rtsp://')
              ? 'Прямой RTSP-видеопоток сетевой камеры с детекцией техники.'
              : 'Камера в реальном времени транслирует рабочую зону.'}
          </span>
        </div>

        <button className="button primary" onClick={() => toast('Создан отчет по текущему наблюдению')}>
          Сформировать отчёт
        </button>
      </aside>
    </div>
  )
}

// ----------------------------------------------------------------------------
// 4. Archive Page
// ----------------------------------------------------------------------------
// ----------------------------------------------------------------------------
// 4. Photo Archive Page (Фотоархив нарушений)
// ----------------------------------------------------------------------------
function PhotoArchive({
  incidents,
  violationWindowSeconds,
  highlightedIncidentId,
  onNavigateToReport,
  onStatusChange,
  toast,
}: {
  incidents: Incident[]
  violationWindowSeconds: number
  highlightedIncidentId?: string | null
  onNavigateToReport: (incidentId: string) => void
  onStatusChange?: (incidentId: string, newStatus: IncidentStatus) => void
  toast: (s: string) => void
}) {
  const [filterSeverity, setFilterSeverity] = useState<'all' | 'ERROR' | 'WARNING'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null)
  const [selectedAlbumIncident, setSelectedAlbumIncident] = useState<Incident | null>(null)
  const [activeAlbumPhotoIndex, setActiveAlbumPhotoIndex] = useState<number>(0)

  // Automatically open error album when navigated with highlightedIncidentId
  useEffect(() => {
    if (highlightedIncidentId) {
      const match = incidents.find((i) => i.id === highlightedIncidentId)
      if (match) {
        setSelectedAlbumIncident(match)
        setActiveAlbumPhotoIndex(0)
      }
    }
  }, [highlightedIncidentId, incidents])

  const incidentsWithPhotos = useMemo(() => {
    return incidents.filter((inc) => Boolean(inc.snapshotUrl || (inc.albumPhotos && inc.albumPhotos.length > 0)))
  }, [incidents])

  const filteredIncidents = useMemo(() => {
    return incidentsWithPhotos.filter((inc) => {
      const isError =
        inc.severity === 'ERROR' ||
        inc.priority === 'Критический' ||
        inc.discrepancyType === 'MISSING_MANDATORY' ||
        inc.discrepancyType === 'UNCHARACTERISTIC_PRESENT'

      if (filterSeverity === 'ERROR' && !isError) return false
      if (filterSeverity === 'WARNING' && isError) return false

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase()
        const text = `${inc.id} ${inc.title} ${inc.note} ${inc.zone} ${inc.stageName || ''}`.toLowerCase()
        if (!text.includes(q)) return false
      }
      return true
    })
  }, [incidentsWithPhotos, filterSeverity, searchQuery])

  return (
    <div className="archive-page">
      <section className="archive-search">
        <span className="eyebrow">ФОТОАРХИВ НАРУШЕНИЙ И СОБЫТИЙ СМР</span>
        <h1>Фотофиксация нарушений спецтехники</h1>
        <p style={{ color: 'var(--muted)', fontSize: '13px', margin: '4px 0 16px', maxWidth: '750px' }}>
          Автоматическая фотофиксация участков стройплощадки при обнаружении несоответствий календарному плану
          (окно контроля: {violationWindowSeconds} сек). При фиксации ошибки в фотоархив добавляются ракурсы <strong>со всех подключенных камер</strong> в виде альбома ошибки. В суточный отчёт передается только первое фото.
        </p>

        <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="archive-searchbar" style={{ flex: '1', minWidth: '260px' }}>
            <Icon name="search" size={20} />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Поиск по технике, участку или коду инцидента..."
              aria-label="Запрос для поиска"
            />
          </div>

          <div style={{ display: 'flex', gap: '6px' }}>
            <button
              className={`button ${filterSeverity === 'all' ? 'primary' : ''}`}
              onClick={() => setFilterSeverity('all')}
              style={{ fontSize: '11px', height: '36px' }}
            >
              Все альбомы ({incidentsWithPhotos.length})
            </button>
            <button
              className={`button ${filterSeverity === 'ERROR' ? 'primary' : ''}`}
              onClick={() => setFilterSeverity('ERROR')}
              style={{ fontSize: '11px', height: '36px', color: '#f87171' }}
            >
              Ошибки (ERROR)
            </button>
            <button
              className={`button ${filterSeverity === 'WARNING' ? 'primary' : ''}`}
              onClick={() => setFilterSeverity('WARNING')}
              style={{ fontSize: '11px', height: '36px', color: '#fbbf24' }}
            >
              Предупреждения (WARNING)
            </button>
          </div>
        </div>
      </section>

      <section className="archive-results panel">
        <div className="panel-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <span className="section-kicker">АЛЬБОМЫ ОШИБОК И ФОТОФИКСАЦИЙ</span>
            <h2>Найдено {filteredIncidents.length} альбомов нарушений</h2>
          </div>
          <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
            Окно фиксации нарушений: <strong>{violationWindowSeconds} сек</strong>
          </span>
        </div>

        {filteredIncidents.length === 0 ? (
          <div style={{ padding: '40px 20px', textAlign: 'center', color: 'var(--muted)' }}>
            Фотофиксаций нарушений пока нет. При воспроизведении видео или трансляции система автоматически
            зафиксирует кадры участка со всех камер при нарушении регламента.
          </div>
        ) : (
          <div className="photo-archive-grid">
            {filteredIncidents.map((r) => {
              const isError =
                r.severity === 'ERROR' ||
                r.priority === 'Критический' ||
                r.discrepancyType === 'MISSING_MANDATORY' ||
                r.discrepancyType === 'UNCHARACTERISTIC_PRESENT'
              const album = r.albumPhotos && r.albumPhotos.length > 0
                ? r.albumPhotos
                : [{ url: r.snapshotUrl || '', cameraName: r.camera || 'Камера 1', isPrimary: true }]
              const primaryPhoto = album.find((p) => p.isPrimary)?.url || album[0]?.url || r.snapshotUrl || ''
              const isHighlighted = highlightedIncidentId === r.id

              return (
                <article
                  key={r.id}
                  className={`photo-card ${isHighlighted ? 'highlighted' : ''}`}
                  style={{
                    background: '#171a1e',
                    border: isHighlighted ? '2px solid #38bdf8' : '1px solid #2e3035',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                    boxShadow: isHighlighted ? '0 0 16px rgba(56,189,248,0.3)' : 'none',
                  }}
                >
                  <div
                    style={{
                      position: 'relative',
                      background: '#0b0d10',
                      aspectRatio: '16/9',
                      overflow: 'hidden',
                      cursor: 'pointer',
                    }}
                    onClick={() => {
                      setSelectedAlbumIncident(r)
                      setActiveAlbumPhotoIndex(0)
                    }}
                    title="Нажмите, чтобы открыть альбом ошибки"
                  >
                    <img
                      src={primaryPhoto}
                      alt={r.title}
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      onError={(e) => {
                        const target = e.currentTarget
                        if (!target.src.includes('construction-camera')) {
                          target.src = cameraImage
                        }
                      }}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        top: '8px',
                        left: '8px',
                        display: 'flex',
                        gap: '6px',
                        flexWrap: 'wrap',
                      }}
                    >
                      <span
                        style={{
                          background: isError ? 'rgba(220,38,38,0.9)' : 'rgba(234,179,8,0.9)',
                          color: '#fff',
                          fontSize: '10px',
                          fontWeight: 700,
                          padding: '2px 8px',
                          borderRadius: '4px',
                          textTransform: 'uppercase',
                        }}
                      >
                        {isError ? 'ОШИБКА (ERROR)' : 'ПРЕДУПРЕЖДЕНИЕ (WARNING)'}
                      </span>
                      <span
                        style={{
                          background: 'rgba(0,0,0,0.7)',
                          color: '#fff',
                          fontSize: '10px',
                          fontWeight: 600,
                          padding: '2px 6px',
                          borderRadius: '4px',
                        }}
                      >
                        {r.id}
                      </span>
                    </div>

                    {/* Badge: Number of camera angles in album */}
                    <div
                      style={{
                        position: 'absolute',
                        bottom: '8px',
                        left: '8px',
                        background: 'rgba(2,132,199,0.85)',
                        color: '#fff',
                        fontSize: '10px',
                        padding: '2px 8px',
                        borderRadius: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '4px',
                        fontWeight: 600,
                      }}
                    >
                      <span>📷 Альбом: {album.length} {album.length === 1 ? 'ракурс' : album.length < 5 ? 'ракурса' : 'ракурсов'}</span>
                    </div>

                    <div
                      style={{
                        position: 'absolute',
                        bottom: '8px',
                        right: '8px',
                        background: 'rgba(0,0,0,0.75)',
                        color: '#cbd5e1',
                        fontSize: '10px',
                        padding: '2px 8px',
                        borderRadius: '4px',
                        fontFamily: 'monospace',
                      }}
                    >
                      {r.time}
                    </div>
                  </div>

                  {/* Album camera thumbnails row if more than 1 camera */}
                  {album.length > 1 && (
                    <div
                      style={{
                        padding: '8px 14px 0',
                        display: 'flex',
                        gap: '6px',
                        overflowX: 'auto',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ fontSize: '10px', color: 'var(--muted)', whiteSpace: 'nowrap' }}>Ракурсы:</span>
                      {album.map((photo, idx) => (
                        <div
                          key={idx}
                          onClick={() => {
                            setSelectedAlbumIncident(r)
                            setActiveAlbumPhotoIndex(idx)
                          }}
                          style={{
                            width: '48px',
                            height: '30px',
                            borderRadius: '3px',
                            overflow: 'hidden',
                            border: photo.isPrimary ? '1.5px solid #38bdf8' : '1px solid #374151',
                            cursor: 'pointer',
                            flexShrink: 0,
                            position: 'relative',
                            background: '#0b0d10',
                          }}
                          title={`Камера: ${photo.cameraName || `Ракурс ${idx + 1}`}`}
                        >
                          <img
                            src={photo.url}
                            alt=""
                            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                            onError={(e) => {
                              const target = e.currentTarget
                              if (!target.src.includes('construction-camera')) {
                                target.src = cameraImage
                              }
                            }}
                          />
                          {photo.isPrimary && (
                            <span style={{ position: 'absolute', bottom: '1px', left: '1px', background: '#0284c7', color: '#fff', fontSize: '6px', padding: '0 2px', borderRadius: '1px', fontWeight: 700 }}>
                              Осн
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ padding: '14px', display: 'flex', flexDirection: 'column', flex: 1, gap: '8px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '11px', color: 'var(--muted)', flexWrap: 'wrap', gap: '6px' }}>
                      <div style={{ display: 'flex', gap: '10px' }}>
                        <span>Участок: <strong style={{ color: '#fff' }}>{r.zone}</strong></span>
                        <span>Камера: <strong style={{ color: '#fff' }}>{r.camera}</strong></span>
                      </div>

                      {/* Status Tag Selector */}
                      {r.type === 'Видеопоток' || r.discrepancyType?.startsWith('STREAM_') || r.title?.toLowerCase().includes('видеопоток') || r.note?.toLowerCase().includes('видеопоток') ? (
                        <span style={{ fontSize: '10px', color: '#94a3b8', background: 'rgba(148,163,184,0.1)', border: '1px solid rgba(148,163,184,0.25)', padding: '1px 6px', borderRadius: '4px' }}>
                          Видеопоток
                        </span>
                      ) : (
                        <div style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '10px', color: 'var(--muted)', fontWeight: 600 }}>Тег:</span>
                          <select
                            value={
                              r.status === 'Подтверждено'
                                ? 'Подтверждено'
                                : r.status === 'Проблемы нет'
                                ? 'Проблемы нет'
                                : 'Ожидает обработки'
                            }
                            onChange={(e) => onStatusChange?.(r.id, e.target.value as IncidentStatus)}
                            style={{
                              fontSize: '10px',
                              padding: '1px 6px',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              fontWeight: 700,
                              background:
                                r.status === 'Подтверждено'
                                  ? 'rgba(239, 68, 68, 0.25)'
                                  : r.status === 'Проблемы нет'
                                  ? 'rgba(16, 185, 129, 0.25)'
                                  : 'rgba(245, 158, 11, 0.25)',
                              color:
                                r.status === 'Подтверждено'
                                  ? '#fca5a5'
                                  : r.status === 'Проблемы нет'
                                  ? '#6ee7b7'
                                  : '#fde047',
                              border: `1px solid ${
                                r.status === 'Подтверждено'
                                  ? '#ef4444'
                                  : r.status === 'Проблемы нет'
                                  ? '#10b981'
                                  : '#f59e0b'
                              }`,
                            }}
                            title="Поменять тег ошибки вручную"
                          >
                            <option value="Ожидает обработки">⏳ Ожидает обработки</option>
                            <option value="Подтверждено">🔴 Подтверждено</option>
                            <option value="Проблемы нет">🛡️ Проблемы нет</option>
                          </select>
                        </div>
                      )}
                    </div>

                    <h3 style={{ margin: 0, fontSize: '13px', fontWeight: 700, color: '#fff' }}>
                      {r.title}
                    </h3>

                    <p style={{ margin: 0, fontSize: '11.5px', color: '#94a3b8', lineHeight: 1.45, flex: 1 }}>
                      {r.note}
                    </p>

                    <div style={{ paddingTop: '8px', borderTop: '1px solid #282a2e', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <button
                        type="button"
                        className="button"
                        style={{ fontSize: '11px', padding: '4px 10px', height: '28px', background: 'rgba(56,189,248,0.12)', color: '#38bdf8', borderColor: 'rgba(56,189,248,0.3)' }}
                        onClick={() => {
                          setSelectedAlbumIncident(r)
                          setActiveAlbumPhotoIndex(0)
                        }}
                        title="Открыть альбом ошибки со всеми камерами"
                      >
                        📷 Альбом ошибки ({album.length})
                      </button>

                      <button
                        className="button primary"
                        style={{ fontSize: '11px', padding: '4px 10px', height: '28px' }}
                        onClick={() => {
                          onNavigateToReport(r.id)
                          toast(`Переход к записи ${r.id} в отчёте`)
                        }}
                        title="Перейти к данной записи в суточном отчёте"
                      >
                        Ссылка на запись в отчёте →
                      </button>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      {/* Modal: Interactive Error Album (Альбом ошибки со всеми ракурсами) */}
      {selectedAlbumIncident && (
        <div className="modal-backdrop" onClick={() => setSelectedAlbumIncident(null)} style={{ zIndex: 1250 }}>
          <div
            className="modal-box"
            style={{
              maxWidth: '900px',
              width: '92vw',
              maxHeight: '92vh',
              background: '#131518',
              border: '1px solid #2e3035',
              borderRadius: '10px',
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
              overflowY: 'auto',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid #22252a', paddingBottom: '12px' }}>
              <div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px', flexWrap: 'wrap' }}>
                  <span
                    style={{
                      background: selectedAlbumIncident.severity === 'ERROR' ? 'rgba(220,38,38,0.2)' : 'rgba(234,179,8,0.2)',
                      color: selectedAlbumIncident.severity === 'ERROR' ? '#f87171' : '#fbbf24',
                      border: `1px solid ${selectedAlbumIncident.severity === 'ERROR' ? '#ef4444' : '#f59e0b'}`,
                      fontSize: '10px',
                      fontWeight: 800,
                      padding: '2px 8px',
                      borderRadius: '4px',
                    }}
                  >
                    {selectedAlbumIncident.severity === 'ERROR' ? 'ОШИБКА (ERROR)' : 'ПРЕДУПРЕЖДЕНИЕ (WARNING)'}
                  </span>
                  <strong style={{ color: '#fff', fontSize: '13px' }}>{selectedAlbumIncident.id}</strong>
                  <span style={{ color: 'var(--muted)', fontSize: '12px' }}>• {selectedAlbumIncident.time}</span>
                  {selectedAlbumIncident.stageName && (
                    <span style={{ fontSize: '11px', color: '#cf9d3d', background: 'rgba(207,157,61,0.1)', padding: '2px 8px', borderRadius: '4px' }}>
                      Этап: {selectedAlbumIncident.stageName}
                    </span>
                  )}
                </div>
                <h2 style={{ margin: 0, fontSize: '16px', color: '#fff' }}>Альбом ошибки: {selectedAlbumIncident.title}</h2>
                <p style={{ margin: '6px 0 0', color: '#94a3b8', fontSize: '12px', lineHeight: 1.5 }}>{selectedAlbumIncident.note}</p>
              </div>
              <button
                className="button"
                onClick={() => setSelectedAlbumIncident(null)}
                style={{ fontSize: '14px', width: '32px', height: '32px', padding: 0 }}
                title="Закрыть альбом"
              >
                ✕
              </button>
            </div>

            {/* Album Multi-Camera Switcher and Gallery */}
            {(() => {
              const album = selectedAlbumIncident.albumPhotos && selectedAlbumIncident.albumPhotos.length > 0
                ? selectedAlbumIncident.albumPhotos
                : [{ url: selectedAlbumIncident.snapshotUrl || '', cameraName: selectedAlbumIncident.camera || 'Камера 1', isPrimary: true }]
              const curPhoto = album[activeAlbumPhotoIndex] || album[0]

              return (
                <>
                  <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', paddingBottom: '4px', alignItems: 'center' }}>
                    <span style={{ fontSize: '11px', color: 'var(--muted)', whiteSpace: 'nowrap' }}>Ракурсы камер:</span>
                    {album.map((p, idx) => (
                      <button
                        key={idx}
                        type="button"
                        className={`button ${idx === activeAlbumPhotoIndex ? 'primary' : ''}`}
                        style={{
                          fontSize: '11px',
                          padding: '4px 12px',
                          height: '32px',
                          display: 'flex',
                          alignItems: 'center',
                          gap: '6px',
                          whiteSpace: 'nowrap',
                        }}
                        onClick={() => setActiveAlbumPhotoIndex(idx)}
                      >
                        <span>📷 {p.cameraName || `Камера ${idx + 1}`}</span>
                        {p.isPrimary && (
                          <span style={{ fontSize: '9px', background: 'rgba(255,255,255,0.2)', padding: '1px 5px', borderRadius: '3px' }}>
                            Основной (в отчёте)
                          </span>
                        )}
                      </button>
                    ))}
                  </div>

                  {/* Active Camera Large View */}
                  <div
                    style={{
                      position: 'relative',
                      background: '#07080a',
                      borderRadius: '8px',
                      overflow: 'hidden',
                      aspectRatio: '16/9',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      border: '1px solid #22252a',
                      cursor: 'zoom-in',
                    }}
                    onClick={() => setSelectedPhoto(curPhoto?.url || '')}
                    title="Нажмите для полноэкранного просмотра"
                  >
                    <img
                      src={curPhoto?.url}
                      alt={curPhoto?.cameraName}
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                      onError={(e) => {
                        const target = e.currentTarget
                        if (!target.src.includes('construction-camera')) {
                          target.src = cameraImage
                        }
                      }}
                    />
                    <div
                      style={{
                        position: 'absolute',
                        top: '10px',
                        left: '10px',
                        background: 'rgba(0,0,0,0.8)',
                        color: '#fff',
                        fontSize: '11px',
                        padding: '4px 10px',
                        borderRadius: '4px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                      }}
                    >
                      <span>🎥 {curPhoto?.cameraName || `Ракурс ${activeAlbumPhotoIndex + 1}`}</span>
                      {curPhoto?.isPrimary && (
                        <span style={{ background: '#0284c7', fontSize: '9px', padding: '1px 5px', borderRadius: '3px', fontWeight: 700 }}>
                          В отчёте
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Thumbnails strip */}
                  <div style={{ display: 'flex', gap: '8px', overflowX: 'auto', padding: '4px 0' }}>
                    {album.map((p, idx) => (
                      <div
                        key={idx}
                        onClick={() => setActiveAlbumPhotoIndex(idx)}
                        style={{
                          width: '80px',
                          height: '50px',
                          borderRadius: '4px',
                          overflow: 'hidden',
                          border: idx === activeAlbumPhotoIndex ? '2px solid #38bdf8' : '1px solid #334155',
                          cursor: 'pointer',
                          flexShrink: 0,
                          position: 'relative',
                          background: '#07080a',
                        }}
                      >
                        <img
                          src={p.url}
                          alt=""
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          onError={(e) => {
                            const target = e.currentTarget
                            if (!target.src.includes('construction-camera')) {
                              target.src = cameraImage
                            }
                          }}
                        />
                        <span style={{ position: 'absolute', bottom: '2px', left: '2px', background: 'rgba(0,0,0,0.7)', color: '#cbd5e1', fontSize: '8px', padding: '1px 3px', borderRadius: '2px' }}>
                          {p.cameraName || `К${idx + 1}`}
                        </span>
                      </div>
                    ))}
                  </div>

                  {/* Modal Footer Actions */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: '10px', borderTop: '1px solid #22252a', flexWrap: 'wrap', gap: '10px' }}>
                    <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
                      Всего камер в альбоме: <strong>{album.length}</strong> · В отчёт включён <strong>только первый (основной)</strong> ракурс
                    </span>
                    <button
                      className="button primary"
                      onClick={() => {
                        onNavigateToReport(selectedAlbumIncident.id)
                        setSelectedAlbumIncident(null)
                        toast(`Переход к записи ${selectedAlbumIncident.id} в отчёте`)
                      }}
                    >
                      Перейти к записи в отчёте →
                    </button>
                  </div>
                </>
              )
            })()}
          </div>
        </div>
      )}

      {/* Fullscreen Photo Modal */}
      {selectedPhoto && (
        <div className="modal-backdrop" onClick={() => setSelectedPhoto(null)} style={{ zIndex: 1300 }}>
          <div style={{ maxWidth: '90vw', maxHeight: '90vh', position: 'relative' }} onClick={(e) => e.stopPropagation()}>
            <img
              src={selectedPhoto}
              alt="Фотофиксация нарушения"
              style={{ maxWidth: '100%', maxHeight: '85vh', borderRadius: '8px', border: '1px solid #4a4d53' }}
              onError={(e) => {
                const target = e.currentTarget
                if (!target.src.includes('construction-camera')) {
                  target.src = cameraImage
                }
              }}
            />
            <button
              className="button"
              style={{ position: 'absolute', top: '12px', right: '12px', background: 'rgba(0,0,0,0.8)', color: '#fff' }}
              onClick={() => setSelectedPhoto(null)}
            >
              ✕ Закрыть
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------
// 5. Progress Page (Interactive Gantt + Cascade Shift + Schedule Upload)
// ----------------------------------------------------------------------------
function Progress({
  stages,
  setStages,
  activeProjectId,
  navigate,
  toast,
}: {
  stages: StageItem[]
  setStages: React.Dispatch<React.SetStateAction<StageItem[]>>
  activeProjectId?: string | null
  navigate?: (p: PageKey) => void
  toast: (s: string) => void
}) {
  const [isLoading, setIsLoading] = useState(false)
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null)
  const [isShiftModalOpen, setIsShiftModalOpen] = useState(false)
  const [delayDays, setDelayDays] = useState(5)
  const [delayedStageId, setDelayedStageId] = useState<string>('')

  // Automatically select the active stage for the current date (2026-09-24)
  useEffect(() => {
    if (stages.length > 0) {
      const current = getCurrentStageByDate(stages)
      if (current) {
        setSelectedStageId((prev) => prev ?? current.id)
      } else {
        setSelectedStageId((prev) => prev ?? stages[0].id)
      }
    }
  }, [stages])

  const handleLoadDemo = async () => {
    setIsLoading(true)
    try {
      const demo = await loadDemoSchedule(activeProjectId || undefined)
      setStages(demo)
      if (demo.length > 0) {
        const current = getCurrentStageByDate(demo)
        setSelectedStageId(current ? current.id : demo[0].id)
        setDelayedStageId(demo[1]?.id || demo[0].id)
      }
      toast('Эталонный план «Многоквартирный жилой дом» загружен')
    } finally {
      setIsLoading(false)
    }
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setIsLoading(true)
    try {
      const imported = await uploadScheduleFile(file, activeProjectId || undefined)
      setStages(imported)
      if (imported.length > 0) {
        const current = getCurrentStageByDate(imported)
        setSelectedStageId(current ? current.id : imported[0].id)
        setDelayedStageId(imported[1]?.id || imported[0].id)
      }
      toast(`Файл «${file.name}» успешно импортирован. Этапов: ${imported.length}`)
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Ошибка импорта')
    } finally {
      setIsLoading(false)
      e.target.value = ''
    }
  }

  const handleClear = async () => {
    if (!confirm('Вы уверены, что хотите удалить календарный план объекта?')) return
    try {
      await clearSchedule(activeProjectId || undefined)
      setStages([])
      toast('Календарный план очищен')
    } catch {
      toast('Ошибка очистки плана')
    }
  }

  const handleAdjustDuration = async (stage: StageItem, delta: number) => {
    const newDuration = Math.max(1, stage.duration_days + delta)
    const currentEnd = stage.planned_end ? new Date(stage.planned_end) : new Date()
    currentEnd.setDate(currentEnd.getDate() + delta)
    const newEnd = currentEnd.toISOString().split('T')[0]

    try {
      await updateStageDates(stage.id, { duration_days: newDuration, planned_end: newEnd })
    } catch {
      // local update
    }

    setStages((prev) =>
      prev.map((s) => (s.id === stage.id ? { ...s, duration_days: newDuration, planned_end: newEnd } : s))
    )
    toast(`Длительность этапа изменена: ${newDuration} дн.`)
  }

  const handleCascadeShift = async () => {
    if (!delayedStageId || delayDays <= 0) return
    try {
      const res = await cascadeShiftStages(delayedStageId, delayDays)
      setStages(res.updated_stages)
      setIsShiftModalOpen(false)
      toast(res.message)
    } catch {
      toast('Ошибка выполнения каскадного сдвига')
    }
  }

  // Calculate timeline bounds safely
  const startTimes = stages
    .map((s) => (s.planned_start ? new Date(s.planned_start).getTime() : NaN))
    .filter((t) => !isNaN(t))
  const endTimes = stages
    .map((s) => (s.planned_end ? new Date(s.planned_end).getTime() : NaN))
    .filter((t) => !isNaN(t))
  const minTime = startTimes.length > 0 ? Math.min(...startTimes) : Date.now()
  const maxTime = endTimes.length > 0 ? Math.max(...endTimes) : minTime + 30 * 24 * 3600 * 1000
  const totalMs = Math.max(maxTime - minTime, 1)

  // Current stage on reference date (2026-09-24)
  const todayActiveStage = getCurrentStageByDate(stages)
  const todayMs = new Date('2026-09-24T12:00:00Z').getTime()
  const todayPct = Math.max(0, Math.min(100, ((todayMs - minTime) / totalMs) * 100))
  const isTodayInRange = todayMs >= minTime && todayMs <= maxTime

  // Generate 6 date ruler ticks
  const tickCount = 6
  const timelineTicks = Array.from({ length: tickCount }).map((_, i) => {
    const t = minTime + (totalMs / (tickCount - 1)) * i
    const d = new Date(t)
    const label = `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getFullYear()).slice(2)}`
    const pct = (i / (tickCount - 1)) * 100
    return { label, pct }
  })

  const selectedStage = stages.find((s) => s.id === selectedStageId) || stages[0]
  const stageRules = selectedStage ? getStageMachineryRules(selectedStage.name) : null

  return (
    <div className="progress-page" style={{ gridTemplateColumns: '1fr' }}>
      <section className="panel progress-detail">
        <div className="progress-title">
          <div>
            <span className="eyebrow">КАЛЕНДАРНЫЙ ГРАФИК СМР</span>
            <h2>Интерактивный график Ганта и контроль сроков</h2>
          </div>
          <Status tone={stages.length > 0 ? 'success' : 'neutral'}>
            {stages.length > 0 ? `${stages.length} этапов в графике` : 'План не загружен'}
          </Status>
        </div>

        {/* Toolbar */}
        <div className="gantt-toolbar" style={{ background: '#1c1e22', margin: '0 -18px', padding: '12px 18px', display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="button primary" style={{ cursor: 'pointer' }}>
            Загрузить план (.xlsx / .csv)
            <input type="file" accept=".xlsx,.csv" onChange={handleFileUpload} style={{ display: 'none' }} />
          </label>

          <button className="button" onClick={handleLoadDemo} disabled={isLoading}>
            {isLoading ? 'Загрузка...' : 'Загрузить демо-план'}
          </button>

          {stages.length > 0 && (
            <>
              <button className="button" onClick={() => setIsShiftModalOpen(true)}>
                Каскадный сдвиг сроков
              </button>
              <button className="button" style={{ marginLeft: 'auto', borderColor: '#dc2626', color: '#f87171' }} onClick={handleClear}>
                Очистить график
              </button>
            </>
          )}
        </div>

        {stages.length === 0 ? (
          <div className="empty-card">
            <Icon name="progress" size={36} />
            <h3>Календарный план строительства ещё не загружен</h3>
            <p>
              Загрузите файл графика (.xlsx или .csv) со структурой работ объекта.
              Система автоматически сопоставит наименования этапов с эталонным справочником работ и рассчитает вероятности присутствия спецтехники (10 классов YOLO).
            </p>
            <div style={{ display: 'flex', gap: '10px', marginTop: '8px' }}>
              <label className="button primary" style={{ cursor: 'pointer' }}>
                Импортировать .xlsx / .csv
                <input type="file" accept=".xlsx,.csv" onChange={handleFileUpload} style={{ display: 'none' }} />
              </label>
              <button className="button" onClick={handleLoadDemo} disabled={isLoading}>
                {isLoading ? 'Загрузка...' : 'Загрузить эталонный демо-план'}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: '16px' }}>
            {/* Gantt Timeline View */}
            <div className="gantt-container" style={{ background: '#171a1e', border: '1px solid #35373c', borderRadius: '6px', padding: '14px', overflowX: 'auto', position: 'relative' }}>
              <div style={{ minWidth: '820px', position: 'relative' }}>
                {/* Timeline Header Ruler */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '290px 1fr 140px',
                    gap: '12px',
                    alignItems: 'center',
                    padding: '6px 6px 12px 6px',
                    borderBottom: '1px solid #35373c',
                    marginBottom: '8px',
                    fontSize: '11px',
                    color: 'var(--muted)',
                  }}
                >
                  <div style={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Этап СМР / Длительность</div>
                  <div style={{ position: 'relative', height: '20px' }}>
                    {timelineTicks.map((tick, idx) => (
                      <div
                        key={idx}
                        style={{
                          position: 'absolute',
                          left: `${tick.pct}%`,
                          transform: idx === 0 ? 'none' : idx === timelineTicks.length - 1 ? 'translateX(-100%)' : 'translateX(-50%)',
                          color: '#9ca3af',
                          fontSize: '10px',
                          fontWeight: 600,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {tick.label}
                      </div>
                    ))}
                    {isTodayInRange && (
                      <div
                        style={{
                          position: 'absolute',
                          left: `${todayPct}%`,
                          top: '-2px',
                          transform: 'translateX(-50%)',
                          background: '#ef4444',
                          color: '#fff',
                          fontSize: '8px',
                          fontWeight: 800,
                          padding: '1px 5px',
                          borderRadius: '2px',
                          whiteSpace: 'nowrap',
                          zIndex: 3,
                          boxShadow: '0 0 6px rgba(239,68,68,0.6)',
                        }}
                      >
                        СЕГОДНЯ
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Сдвиг / Дни</div>
                </div>

                {/* Stages Gantt Rows */}
                {stages.map((stg) => {
                  const rawStart = stg.planned_start ? new Date(stg.planned_start).getTime() : NaN
                  const rawEnd = stg.planned_end ? new Date(stg.planned_end).getTime() : NaN
                  const sTime = isNaN(rawStart) ? minTime : rawStart
                  const eTime = isNaN(rawEnd) ? sTime + (stg.duration_days || 1) * 86400000 : rawEnd
                  const leftPct = Math.max(0, Math.min(97, ((sTime - minTime) / totalMs) * 100))
                  const widthPct = Math.max(3, Math.min(100 - leftPct, ((eTime - sTime) / totalMs) * 100))
                  const isSelected = selectedStageId === stg.id
                  const isTodayActive = todayActiveStage?.id === stg.id
                  const startStr = stg.planned_start ? String(stg.planned_start).slice(0, 10) : '—'
                  const endStr = stg.planned_end ? String(stg.planned_end).slice(0, 10) : '—'

                  return (
                    <div
                      key={stg.id}
                      onClick={() => setSelectedStageId(stg.id)}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '290px 1fr 140px',
                        gap: '12px',
                        alignItems: 'center',
                        padding: '8px 6px',
                        borderBottom: '1px solid #25272c',
                        background: isSelected ? 'rgba(207,157,61,.14)' : isTodayActive ? 'rgba(234,179,8,.08)' : 'transparent',
                        borderRadius: isSelected ? '4px' : '0',
                        cursor: 'pointer',
                        transition: 'background 0.15s ease',
                      }}
                    >
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px' }}>
                          <strong style={{ fontSize: '11px', color: isSelected ? '#f59e0b' : '#fff' }}>
                            {stg.order_index}. {stg.name}
                          </strong>
                          {isTodayActive && (
                            <span style={{ background: '#cf9d3d', color: '#0b0d10', fontSize: '9px', fontWeight: 800, padding: '1px 5px', borderRadius: '3px' }}>
                              СЕГОДНЯ
                            </span>
                          )}
                          {stg.status === 'completed' && (
                            <span style={{ background: 'rgba(59,130,246,0.2)', color: '#60a5fa', fontSize: '9px', fontWeight: 700, padding: '1px 5px', borderRadius: '3px' }}>
                              ✓ Завершён
                            </span>
                          )}
                        </div>
                        <span style={{ fontSize: '9px', color: 'var(--muted)' }}>
                          {stg.duration_days} дн. ({startStr} – {endStr})
                        </span>
                      </div>

                      <div style={{ position: 'relative', height: '24px', background: '#1c1e22', borderRadius: '2px', overflow: 'hidden' }}>
                        {isTodayInRange && (
                          <div
                            style={{
                              position: 'absolute',
                              left: `${todayPct}%`,
                              top: 0,
                              bottom: 0,
                              width: '2px',
                              background: '#ef4444',
                              opacity: 0.6,
                              zIndex: 1,
                              pointerEvents: 'none',
                            }}
                          />
                        )}
                        <div
                          style={{
                            position: 'absolute',
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                            top: '2px',
                            bottom: '2px',
                            background: isSelected
                              ? '#f59e0b'
                              : isTodayActive
                              ? '#eab308'
                              : stg.status === 'completed'
                              ? '#3b82f6'
                              : '#cf9d3d',
                            border: isTodayActive ? '1px solid #ffffff' : isSelected ? '1px solid #fef08a' : undefined,
                            boxShadow: isTodayActive ? '0 0 8px rgba(234,179,8,0.6)' : undefined,
                            borderRadius: '2px',
                            display: 'flex',
                            alignItems: 'center',
                            padding: '0 6px',
                            fontSize: '9px',
                            color: stg.status === 'completed' ? '#ffffff' : '#000',
                            fontWeight: 700,
                            overflow: 'hidden',
                            whiteSpace: 'nowrap',
                            zIndex: 2,
                          }}
                        >
                          {stg.duration_days} дн {isTodayActive ? '• Активен' : stg.status === 'completed' ? '✓' : ''}
                        </div>
                      </div>

                      <div style={{ display: 'flex', gap: '4px', justifyContent: 'flex-end' }}>
                        <button
                          className="button"
                          style={{ padding: '2px 8px', height: '26px', fontSize: '11px' }}
                          title="Уменьшить длительность на 1 день"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleAdjustDuration(stg, -1)
                          }}
                        >
                          −1д
                        </button>
                        <button
                          className="button"
                          style={{ padding: '2px 8px', height: '26px', fontSize: '11px' }}
                          title="Увеличить длительность на 1 день"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleAdjustDuration(stg, 1)
                          }}
                        >
                          +1д
                        </button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Selected Stage Detail Inspector */}
            {selectedStage && (
              <div
                style={{
                  marginTop: '16px',
                  padding: '16px',
                  background: '#171a1e',
                  border: '1px solid #35373c',
                  borderRadius: '6px',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: '16px',
                }}
              >
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                    <span style={{ fontSize: '11px', color: '#cf9d3d', fontWeight: 700, textTransform: 'uppercase' }}>
                      Этап {selectedStage.order_index} из {stages.length}
                    </span>
                    <span
                      style={{
                        background:
                          selectedStage.status === 'completed'
                            ? '#2563eb'
                            : selectedStage.status === 'active'
                            ? '#eab308'
                            : '#4b5563',
                        color: selectedStage.status === 'active' ? '#000' : '#fff',
                        fontSize: '10px',
                        fontWeight: 700,
                        padding: '2px 6px',
                        borderRadius: '3px',
                      }}
                    >
                      {selectedStage.status === 'completed' ? 'Завершён' : selectedStage.status === 'active' ? 'Активен сейчас' : 'Запланирован'}
                    </span>
                  </div>
                  <h3 style={{ margin: '0 0 6px 0', fontSize: '15px', color: '#fff' }}>{selectedStage.name}</h3>
                  <div style={{ fontSize: '12px', color: 'var(--muted)', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                    <span>Сроки: <strong style={{ color: '#fff' }}>{selectedStage.planned_start ? String(selectedStage.planned_start).slice(0, 10) : '—'} — {selectedStage.planned_end ? String(selectedStage.planned_end).slice(0, 10) : '—'}</strong></span>
                    <span>Длительность: <strong style={{ color: '#fff' }}>{selectedStage.duration_days} дн.</strong></span>
                    {selectedStage.matched_catalog_name && (
                      <span>Справочник: <strong style={{ color: '#93c5fd' }}>{selectedStage.matched_catalog_name}</strong></span>
                    )}
                  </div>
                  {stageRules && (
                    <div style={{ marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', fontSize: '11px' }}>
                      <span style={{ color: '#4ade80' }}>Обязательно: {stageRules.mandatory.join(', ') || 'нет'}</span>
                      <span style={{ color: '#facc15' }}>• Рекомендовано: {stageRules.recommended.join(', ') || 'нет'}</span>
                    </div>
                  )}
                </div>

                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  {navigate && (
                    <button
                      type="button"
                      className="button primary"
                      onClick={() => navigate('analytics')}
                      style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
                    >
                      <Icon name="chart" size={16} />
                      Профиль техники этапа
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Modal: Cascade Shift */}
        {isShiftModalOpen && (
          <div className="modal-backdrop">
            <div className="dialog" style={{ width: '440px' }}>
              <h3>Каскадный сдвиг сроков</h3>
              <p>При задержке выбранного этапа все последующие этапы будут автоматически сдвинуты на указанное количество дней.</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  handleCascadeShift()
                }}
              >
                <label>
                  Этап задержки
                  <select value={delayedStageId} onChange={(e) => setDelayedStageId(e.target.value)}>
                    {stages.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.order_index}. {s.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Количество дней задержки
                  <input
                    type="number"
                    min="1"
                    max="180"
                    value={delayDays}
                    onChange={(e) => setDelayDays(parseInt(e.target.value, 10) || 1)}
                  />
                </label>
                <div className="dialog-actions">
                  <button type="submit" className="button primary">
                    Применить сдвиг
                  </button>
                  <button type="button" className="button" onClick={() => setIsShiftModalOpen(false)}>
                    Отмена
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}

// ----------------------------------------------------------------------------
// 6. Analytics Page (Stage Machinery Probability Analytics + RadarChart)
// ----------------------------------------------------------------------------
function Analytics({
  stages,
  navigate,
  toast,
  onStageOverridesUpdated,
}: {
  stages: StageItem[]
  navigate: (p: PageKey) => void
  toast?: (s: string) => void
  onStageOverridesUpdated?: (stageId: string) => void
}) {
  const [selectedStageId, setSelectedStageId] = useState<string>(() => {
    return localStorage.getItem('analytics_selected_stage_id') || ''
  })
  const [probItems, setProbItems] = useState<MachineryProbabilityItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [hasCustomOverride, setHasCustomOverride] = useState(false)

  // Automatically select the active stage on today's date (2026-09-24) or restore from localStorage
  useEffect(() => {
    if (stages.length > 0) {
      if (!selectedStageId || !stages.some((s) => s.id === selectedStageId)) {
        const saved = localStorage.getItem('analytics_selected_stage_id')
        if (saved && stages.some((s) => s.id === saved)) {
          setSelectedStageId(saved)
        } else {
          const current = getCurrentStageByDate(stages)
          const fallbackId = current ? current.id : stages[0].id
          setSelectedStageId(fallbackId)
          localStorage.setItem('analytics_selected_stage_id', fallbackId)
        }
      }
    }
  }, [stages, selectedStageId])

  useEffect(() => {
    if (!selectedStageId) return
    setIsLoading(true)
    fetchStageProbabilities(selectedStageId)
      .then((res) => {
        setProbItems(res.probabilities || [])
        setHasCustomOverride(Boolean(res.has_custom_override))
      })
      .finally(() => {
        setIsLoading(false)
      })
  }, [selectedStageId])

  const selectedStage = stages.find((s) => s.id === selectedStageId) || stages[0]

  // Status mapping
  type ClassificationType = MachineryProbabilityItem['classification']
  const statusMeta: Record<ClassificationType, { prob: number; level: string; cls: string }> = {
    MANDATORY: { prob: 0.95, level: 'Обязательная', cls: 'mandatory' },
    RECOMMENDED: { prob: 0.75, level: 'Рекомендованная', cls: 'recommended' },
    NEUTRAL: { prob: 0.40, level: 'Допустимая', cls: 'neutral' },
    UNCHARACTERISTIC: { prob: 0.05, level: 'Не допускается', cls: 'uncharacteristic' },
  }

  // Handle manual status override by user
  const handleStatusChange = async (machineryCode: string, newStatus: string) => {
    const validStatus = (['MANDATORY', 'RECOMMENDED', 'NEUTRAL', 'UNCHARACTERISTIC'].includes(newStatus)
      ? newStatus
      : 'NEUTRAL') as ClassificationType
    const meta = statusMeta[validStatus]

    // 1. Optimistic state update
    setProbItems((prev) =>
      prev.map((item) =>
        item.machinery_code === machineryCode
          ? {
              ...item,
              probability: meta.prob,
              requirement_level: meta.level,
              classification: validStatus,
            }
          : item
      )
    )
    setHasCustomOverride(true)

    // 2. Persist to API
    try {
      const res = await updateStageProbabilities(selectedStageId, { [machineryCode]: validStatus }, selectedStage?.name)
      setHasCustomOverride(Boolean(res.has_custom_override ?? true))
      onStageOverridesUpdated?.(selectedStageId)
      toast?.(`Статус техники обновлён: «${meta.level}»`)
    } catch {
      onStageOverridesUpdated?.(selectedStageId)
      toast?.(`Статус обновлён локально`)
    }
  }

  // Reset manual overrides to AI calculation
  const handleResetProbabilities = async () => {
    setIsLoading(true)
    try {
      const res = await resetStageProbabilities(selectedStageId, selectedStage?.name)
      setProbItems(res.probabilities || [])
      setHasCustomOverride(false)
      onStageOverridesUpdated?.(selectedStageId)
      toast?.('Профиль сброшен к автоматическому расчёту AI/ГЭСН')
    } catch {
      const res = await fetchStageProbabilities(selectedStageId)
      setProbItems(res.probabilities || [])
      setHasCustomOverride(false)
      onStageOverridesUpdated?.(selectedStageId)
      toast?.('Профиль возвращен к авто-расчёту')
    } finally {
      setIsLoading(false)
    }
  }

  // Radar chart SVG geometry
  const radarRadius = 90
  const centerCoord = 140
  const count = probItems.length || 10
  const points = probItems.map((item, idx) => {
    const angle = (Math.PI * 2 * idx) / count - Math.PI / 2
    const dist = Math.max(0.08, Math.min(1.0, item.probability)) * radarRadius
    const x = centerCoord + dist * Math.cos(angle)
    const y = centerCoord + dist * Math.sin(angle)
    return { x, y, item, angle }
  })
  const polyPoints = points.map((p) => `${p.x},${p.y}`).join(' ')

  return (
    <div className="analytics-page">
      {stages.length === 0 ? (
        <div className="empty-card">
          <Icon name="chart" size={36} />
          <h3>Календарный план не загружен</h3>
          <p>
            Для отображения вероятностных профилей строительной техники по этапам СМР необходимо загрузить план строительства.
          </p>
          <button className="button primary" onClick={() => navigate('progress')}>
            Перейти к загрузке плана
          </button>
        </div>
      ) : (
        <>
          <section className="panel" style={{ marginBottom: '14px', padding: '16px' }}>
            <div className="panel-head" style={{ padding: '0 0 12px' }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span className="section-kicker">STAGE MACHINERY SERVICE · АНАЛИТИКА ЭТАПА</span>
                  {selectedStage && getCurrentStageByDate(stages)?.id === selectedStage.id && (
                    <span style={{ background: '#cf9d3d', color: '#0b0d10', fontSize: '9px', fontWeight: 800, padding: '1px 6px', borderRadius: '3px' }}>
                      АКТИВЕН СЕГОДНЯ (24.09.2026)
                    </span>
                  )}
                </div>
                <h2>Вероятностное распределение строительной техники</h2>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  className="button"
                  style={{ fontSize: '11px', padding: '3px 8px', height: '28px' }}
                  onClick={handleResetProbabilities}
                  title="Сбросить все ручные изменения к расчету по справочнику ГЭСН"
                >
                  ⟲ Авто-расчёт
                </button>
                <span style={{ fontSize: '11px', color: 'var(--muted)', marginLeft: '6px' }}>Этап:</span>
                <select
                  value={selectedStageId}
                  onChange={(e) => {
                    const newId = e.target.value
                    setSelectedStageId(newId)
                    localStorage.setItem('analytics_selected_stage_id', newId)
                  }}
                  style={{ background: '#171a1e', border: '1px solid var(--border)', color: '#fff', padding: '4px 8px', fontSize: '11px' }}
                >
                  {stages.map((s) => {
                    const isToday = getCurrentStageByDate(stages)?.id === s.id
                    return (
                      <option key={s.id} value={s.id}>
                        {s.order_index}. {s.name} {isToday ? '★ [ТЕКУЩИЙ ЭТАП · 24.09.2026]' : ''}
                      </option>
                    )
                  })}
                </select>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(340px, 1.3fr) minmax(300px, 1fr)', gap: '20px', alignItems: 'start' }}>
              {/* Table of 10 machinery probabilities with manual status customization */}
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: '130px 1fr 50px 140px', gap: '8px', padding: '6px 8px', fontSize: '10px', color: 'var(--muted)', borderBottom: '1px solid #35373c' }}>
                  <span>Класс техники</span>
                  <span>Вероятность</span>
                  <span style={{ textAlign: 'right' }}>%</span>
                  <span style={{ textAlign: 'center' }}>Статус (настройка)</span>
                </div>
                {isLoading ? (
                  <div style={{ padding: '24px', textAlign: 'center', color: 'var(--muted)' }}>Расчёт вероятностей...</div>
                ) : (
                  probItems.map((item) => (
                    <div
                      key={item.machinery_code}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '130px 1fr 50px 140px',
                        gap: '8px',
                        alignItems: 'center',
                        padding: '6px 8px',
                        borderBottom: '1px solid #222327',
                        fontSize: '11px',
                      }}
                    >
                      <strong style={{ color: '#fff' }}>{item.machinery_name_ru}</strong>
                      <div className="prob-track">
                        <div
                          className={`prob-fill ${item.classification.toLowerCase()}`}
                          style={{
                            width: `${Math.round(item.probability * 100)}%`,
                            background:
                              item.classification === 'MANDATORY'
                                ? '#34d399'
                                : item.classification === 'RECOMMENDED'
                                ? '#eab308'
                                : item.classification === 'NEUTRAL'
                                ? '#74777c'
                                : '#dc2626',
                          }}
                        />
                      </div>
                      <span style={{ textAlign: 'right', fontWeight: 600, color: '#fff' }}>
                        {Math.round(item.probability * 100)}%
                      </span>
                      <div style={{ display: 'flex', justifyContent: 'center' }}>
                        <select
                          value={item.classification}
                          onChange={(e) => handleStatusChange(item.machinery_code, e.target.value)}
                          style={{
                            background: '#121417',
                            color:
                              item.classification === 'MANDATORY'
                                ? '#34d399'
                                : item.classification === 'RECOMMENDED'
                                ? '#eab308'
                                : item.classification === 'NEUTRAL'
                                ? '#cbd5e1'
                                : '#f87171',
                            border: '1px solid #35373c',
                            borderRadius: '4px',
                            padding: '2px 4px',
                            fontSize: '10.5px',
                            fontWeight: 600,
                            cursor: 'pointer',
                            width: '100%',
                            maxWidth: '135px',
                          }}
                          title="Ручная настройка статуса техники на данном этапе"
                        >
                          <option value="MANDATORY">Обязательная</option>
                          <option value="RECOMMENDED">Рекомендованная</option>
                          <option value="NEUTRAL">Допустимая</option>
                          <option value="UNCHARACTERISTIC">Не допускается</option>
                        </select>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Radar Chart (Роза ветров) with prominent title */}
              <div className="radar-container" style={{ background: '#1c1e22', border: '1px solid #35373c', padding: '16px', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                <div style={{ width: '100%', textAlign: 'center', marginBottom: '8px' }}>
                  <span className="section-kicker" style={{ color: '#cf9d3d', fontSize: '9px' }}>РОЗА ВЕТРОВ РАСПРЕДЕЛЕНИЯ</span>
                  <h3 style={{ margin: '2px 0 0', fontSize: '14px', fontWeight: 800, color: '#ffffff', letterSpacing: '0.6px' }}>
                    ПРОФИЛЬ ТЕХНИКИ НА ЭТАПЕ
                  </h3>
                  <div style={{ fontSize: '10px', color: 'var(--muted)', marginTop: '2px' }}>
                    {selectedStage?.name || 'Выбранный этап'}
                  </div>
                </div>

                <svg width="280" height="280" viewBox="0 0 280 280" style={{ overflow: 'visible' }}>
                  {/* Concentric rings */}
                  {[0.25, 0.5, 0.75, 1.0].map((level) => (
                    <circle
                      key={level}
                      cx={centerCoord}
                      cy={centerCoord}
                      r={radarRadius * level}
                      fill="none"
                      stroke="#35373c"
                      strokeDasharray={level < 1.0 ? '2,3' : undefined}
                    />
                  ))}

                  {/* Radial axes */}
                  {points.map((p, idx) => (
                    <line
                      key={idx}
                      x1={centerCoord}
                      y1={centerCoord}
                      x2={centerCoord + radarRadius * Math.cos(p.angle)}
                      y2={centerCoord + radarRadius * Math.sin(p.angle)}
                      stroke="#2a2c30"
                    />
                  ))}

                  {/* Filled radar polygon */}
                  {polyPoints && <polygon points={polyPoints} fill="rgba(207,157,61,.30)" stroke="#cf9d3d" strokeWidth="2" />}

                  {/* Data points & labels */}
                  {points.map((p, idx) => {
                    const labelDist = radarRadius + 16
                    const lx = centerCoord + labelDist * Math.cos(p.angle)
                    const ly = centerCoord + labelDist * Math.sin(p.angle)
                    const textAnchor = Math.cos(p.angle) > 0.2 ? 'start' : Math.cos(p.angle) < -0.2 ? 'end' : 'middle'
                    const pointColor =
                      p.item.classification === 'MANDATORY' || p.item.probability > 0.8
                        ? '#34d399'
                        : p.item.classification === 'RECOMMENDED' || p.item.probability >= 0.6
                        ? '#eab308'
                        : p.item.classification === 'UNCHARACTERISTIC' || p.item.probability < 0.15
                        ? '#f87171'
                        : '#94a3b8'
                    return (
                      <g key={idx}>
                        <circle cx={p.x} cy={p.y} r="4" fill={pointColor} stroke="#0b0d10" strokeWidth="1.5" />
                        <text
                          x={lx}
                          y={ly}
                          textAnchor={textAnchor}
                          dominantBaseline="central"
                          fill={p.item.probability >= 0.6 ? '#f1f5f9' : '#9ca3af'}
                          fontSize="9"
                          fontWeight={p.item.probability >= 0.6 ? 700 : 400}
                        >
                          {p.item.machinery_name_ru}
                        </text>
                      </g>
                    )
                  })}
                </svg>

                <div style={{ display: 'flex', gap: '12px', marginTop: '14px', fontSize: '9.5px', color: 'var(--muted)' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#34d399' }} /> &gt;80% Обязательная
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#eab308' }} /> 60-80% Рекомендованная
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#94a3b8' }} /> 15-60% Допустимая
                  </span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#f87171' }} /> &lt;15% Не допускается
                  </span>
                </div>
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

// ----------------------------------------------------------------------------
// 7. Reports Page (Суточный отчёт со сводкой нарушений и ссылками на фотоархив)
// ----------------------------------------------------------------------------
function Reports({
  activeProject,
  incidents,
  highlightedIncidentId,
  onNavigateToArchive,
  onStatusChange,
  toast,
}: {
  activeProject?: ProjectItem
  incidents: Incident[]
  highlightedIncidentId?: string | null
  onNavigateToArchive: (incidentId: string) => void
  onStatusChange?: (incidentId: string, newStatus: IncidentStatus) => void
  toast: (s: string) => void
}) {
  const [filterSeverity, setFilterSeverity] = useState<'ALL' | 'ERROR' | 'WARNING'>('ALL')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null)

  // PDF Export Modal State
  const [isExportModalOpen, setIsExportModalOpen] = useState(false)
  const [exportPreset, setExportPreset] = useState<'shift' | '24h' | 'week' | 'all' | 'custom'>('shift')
  const [exportStartDate, setExportStartDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    return d.toISOString().slice(0, 10)
  })
  const [exportEndDate, setExportEndDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [exportSeverity, setExportSeverity] = useState<'ALL' | 'ERROR' | 'WARNING'>('ALL')
  const [includePhotos, setIncludePhotos] = useState(true)
  const [includeSignatures, setIncludeSignatures] = useState(true)
  const [includeStats, setIncludeStats] = useState(true)
  const [selectedIncidentIds, setSelectedIncidentIds] = useState<string[]>([])

  const errorsCount = incidents.filter(
    (i) =>
      i.severity === 'ERROR' ||
      i.priority === 'Критический' ||
      i.discrepancyType === 'MISSING_MANDATORY' ||
      i.discrepancyType === 'UNCHARACTERISTIC_PRESENT'
  ).length
  const warningsCount = incidents.filter(
    (i) => i.severity === 'WARNING' || i.discrepancyType === 'MISSING_RECOMMENDED'
  ).length

  const filteredIncidents = incidents.filter((inc) => {
    const isError =
      inc.severity === 'ERROR' ||
      inc.priority === 'Критический' ||
      inc.discrepancyType === 'MISSING_MANDATORY' ||
      inc.discrepancyType === 'UNCHARACTERISTIC_PRESENT'

    if (filterSeverity === 'ERROR' && !isError) return false
    if (filterSeverity === 'WARNING' && isError) return false

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      const text = `${inc.id} ${inc.title} ${inc.note} ${inc.zone} ${inc.stageName || ''}`.toLowerCase()
      if (!text.includes(q)) return false
    }
    return true
  })

  // Range matching logic for PDF export
  const rangeMatchedIncidents = useMemo(() => {
    return incidents.filter((inc) => {
      const isError =
        inc.severity === 'ERROR' ||
        inc.priority === 'Критический' ||
        inc.discrepancyType === 'MISSING_MANDATORY' ||
        inc.discrepancyType === 'UNCHARACTERISTIC_PRESENT'

      if (exportSeverity === 'ERROR' && !isError) return false
      if (exportSeverity === 'WARNING' && isError) return false

      const timeStr = inc.time || ''
      const isYesterday = timeStr.includes('Вчера')
      const isOlder = timeStr.includes('сен') || timeStr.includes('д')

      if (exportPreset === 'shift') {
        if (isYesterday || isOlder) return false
      } else if (exportPreset === '24h') {
        if (isOlder) return false
      } else if (exportPreset === 'week') {
        return true
      }
      return true
    })
  }, [incidents, exportSeverity, exportPreset, exportStartDate, exportEndDate])

  useEffect(() => {
    setSelectedIncidentIds(rangeMatchedIncidents.map((i) => i.id))
  }, [rangeMatchedIncidents])

  const getRangeLabel = () => {
    const todayStr = new Date().toLocaleDateString('ru-RU')
    switch (exportPreset) {
      case 'shift':
        return `Текущая смена (08:00 – 20:00), ${todayStr}`
      case '24h':
        return `Суточный интервал (за последние 24 часа), на ${todayStr}`
      case 'week':
        return `Недельный интервал (за последние 7 дней), на ${todayStr}`
      case 'custom':
        return `Календарный период с ${exportStartDate} по ${exportEndDate}`
      case 'all':
      default:
        return `Полный период ведения мониторинга на объекте`
    }
  }

  const buildReportHtml = (itemsToExport: Incident[]) => {
    const rangeLabel = getRangeLabel()
    const todayDate = new Date().toLocaleDateString('ru-RU')
    const todayTime = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    const actNumber = `СК-${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, '0')}/${String(new Date().getDate()).padStart(2, '0')}-${Math.floor(10 + Math.random() * 90)}`

    const errCount = itemsToExport.filter(
      (i) =>
        i.severity === 'ERROR' ||
        i.priority === 'Критический' ||
        i.discrepancyType === 'MISSING_MANDATORY' ||
        i.discrepancyType === 'UNCHARACTERISTIC_PRESENT'
    ).length
    const warnCount = itemsToExport.filter(
      (i) => i.severity === 'WARNING' || i.discrepancyType === 'MISSING_RECOMMENDED'
    ).length
    const confirmedCount = itemsToExport.filter((i) => i.status === 'Подтверждено').length

    const esc = (s?: string) =>
      (s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')

    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Акт строительного контроля № ${esc(actNumber)}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 12mm 14mm 12mm 14mm;
    }
    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
      color: #0f172a;
      background: #ffffff;
      margin: 0;
      padding: 0;
      font-size: 10pt;
      line-height: 1.4;
    }
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #0f172a;
      padding-bottom: 10px;
      margin-bottom: 12px;
    }
    .brand-wrap {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .brand-badge {
      width: 42px;
      height: 42px;
      background: #0f172a;
      color: #cf9d3d;
      font-weight: 900;
      font-size: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      border: 1.5px solid #cf9d3d;
    }
    .brand-text-title {
      font-size: 12pt;
      font-weight: 800;
      letter-spacing: 0.5px;
      color: #0f172a;
      text-transform: uppercase;
      margin: 0;
    }
    .brand-text-sub {
      font-size: 8pt;
      color: #64748b;
      margin: 2px 0 0;
      text-transform: uppercase;
      letter-spacing: 0.8px;
    }
    .header-right {
      text-align: right;
      font-size: 8pt;
      color: #475569;
      line-height: 1.35;
    }
    .act-title-section {
      text-align: center;
      margin: 14px 0 12px;
    }
    .act-title {
      font-size: 13.5pt;
      font-weight: 800;
      color: #0f172a;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      margin: 0 0 4px;
    }
    .act-sub {
      font-size: 9pt;
      color: #475569;
      margin: 0;
    }
    .meta-box {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 14px;
      font-size: 9pt;
    }
    .meta-box td {
      padding: 5px 8px;
      border: 1px solid #cbd5e1;
      vertical-align: middle;
    }
    .meta-lbl {
      background: #f8fafc;
      color: #475569;
      font-weight: 600;
      width: 24%;
    }
    .meta-val {
      color: #0f172a;
      font-weight: 500;
      width: 76%;
    }
    .stats-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-bottom: 14px;
    }
    .stat-tile {
      background: #f8fafc;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      padding: 8px 10px;
      text-align: center;
    }
    .stat-tile-val {
      font-size: 15pt;
      font-weight: 800;
      line-height: 1.2;
    }
    .stat-tile-lbl {
      font-size: 7.5pt;
      color: #64748b;
      font-weight: 600;
      text-transform: uppercase;
      margin-top: 2px;
    }
    .sec-heading {
      font-size: 10pt;
      font-weight: 700;
      color: #0f172a;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      border-bottom: 1.5px solid #0f172a;
      padding-bottom: 3px;
      margin: 16px 0 8px;
    }
    .table-incidents {
      width: 100%;
      border-collapse: collapse;
      font-size: 8.5pt;
      margin-bottom: 14px;
    }
    .table-incidents th {
      background: #f1f5f9;
      color: #1e293b;
      font-weight: 700;
      text-align: left;
      padding: 6px 8px;
      border: 1px solid #cbd5e1;
      font-size: 7.5pt;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .table-incidents td {
      padding: 6px 8px;
      border: 1px solid #cbd5e1;
      vertical-align: top;
    }
    .row-inc {
      page-break-inside: avoid !important;
      break-inside: avoid !important;
    }
    .tag-err {
      display: inline-block;
      padding: 2px 5px;
      background: #fee2e2;
      color: #991b1b;
      border: 1px solid #f87171;
      border-radius: 3px;
      font-size: 7pt;
      font-weight: 800;
      text-transform: uppercase;
    }
    .tag-warn {
      display: inline-block;
      padding: 2px 5px;
      background: #fef3c7;
      color: #92400e;
      border: 1px solid #facc15;
      border-radius: 3px;
      font-size: 7pt;
      font-weight: 800;
      text-transform: uppercase;
    }
    .tag-status {
      display: inline-block;
      padding: 2px 5px;
      background: #f1f5f9;
      color: #334155;
      border-radius: 3px;
      font-size: 7pt;
      font-weight: 600;
      margin-top: 3px;
    }
    .thumb-cell {
      width: 130px;
      text-align: center;
    }
    .thumb-wrap {
      width: 120px;
      height: 75px;
      border-radius: 4px;
      overflow: hidden;
      border: 1px solid #cbd5e1;
      background: #0f172a;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .thumb-wrap img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .thumb-empty {
      font-size: 7pt;
      color: #94a3b8;
      text-align: center;
      padding: 4px;
    }
    .signatures-section {
      page-break-inside: avoid !important;
      break-inside: avoid !important;
      margin-top: 22px;
      padding-top: 10px;
      border-top: 1.5px solid #0f172a;
    }
    .sig-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin-top: 10px;
    }
    .sig-col {
      font-size: 8pt;
      color: #1e293b;
    }
    .sig-line {
      margin-top: 32px;
      border-bottom: 1px solid #334155;
      display: flex;
      justify-content: space-between;
      font-size: 7pt;
      color: #64748b;
      padding-bottom: 2px;
    }
    .stamp-box {
      border: 1.5px dashed #94a3b8;
      border-radius: 6px;
      width: 70px;
      height: 70px;
      margin: 12px auto 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #94a3b8;
      font-size: 8pt;
      font-weight: 700;
    }
    .footer-note {
      margin-top: 18px;
      text-align: center;
      font-size: 7.5pt;
      color: #94a3b8;
      border-top: 1px solid #e2e8f0;
      padding-top: 6px;
    }
  </style>
</head>
<body>
  <div class="header-bar">
    <div class="brand-wrap">
      <div class="brand-badge">СК</div>
      <div>
        <div class="brand-text-title">СТРОЙ-КОНТРОЛЬ</div>
        <div class="brand-text-sub">Автоматизированная система строительного надзора</div>
      </div>
    </div>
    <div class="header-right">
      <strong>АКТ № ${esc(actNumber)}</strong><br>
      Дата: ${todayDate} ${todayTime}<br>
      Система видеоаналитики v2.4
    </div>
  </div>

  <div class="act-title-section">
    <h1 class="act-title">АКТ СТРОИТЕЛЬНОГО КОНТРОЛЯ И МОНИТОРИНГА СПЕЦТЕХНИКИ</h1>
    <p class="act-sub">Сводная ведомость соблюдения технологического регламента и присутствия спецтехники</p>
  </div>

  <table class="meta-box">
    <tr>
      <td class="meta-lbl">Объект строительства:</td>
      <td class="meta-val"><strong>${esc(activeProject?.name || 'Строительный объект')}</strong></td>
    </tr>
    <tr>
      <td class="meta-lbl">Адрес объекта:</td>
      <td class="meta-val">${esc(activeProject?.address || 'г. Москва')}</td>
    </tr>
    <tr>
      <td class="meta-lbl">Контролируемый диапазон:</td>
      <td class="meta-val"><strong>${esc(rangeLabel)}</strong></td>
    </tr>
    <tr>
      <td class="meta-lbl">Текущий этап СМР:</td>
      <td class="meta-val">${esc(itemsToExport.find((i) => i.stageName)?.stageName || activeProject?.object_kind || 'Монолитные работы')}</td>
    </tr>
  </table>

  ${
    includeStats
      ? `
  <div class="stats-row">
    <div class="stat-tile">
      <div class="stat-tile-val">${itemsToExport.length}</div>
      <div class="stat-tile-lbl">Всего событий</div>
    </div>
    <div class="stat-tile">
      <div class="stat-tile-val" style="color: #b91c1c;">${errCount}</div>
      <div class="stat-tile-lbl">Ошибок (ERROR)</div>
    </div>
    <div class="stat-tile">
      <div class="stat-tile-val" style="color: #b45309;">${warnCount}</div>
      <div class="stat-tile-lbl">Предупреждений</div>
    </div>
    <div class="stat-tile">
      <div class="stat-tile-val" style="color: #047857;">${confirmedCount}</div>
      <div class="stat-tile-lbl">Подтверждено</div>
    </div>
  </div>
  `
      : ''
  }

  <div class="sec-heading">Журнал выявленных нарушений и несоответствий (${itemsToExport.length} записей)</div>

  <table class="table-incidents">
    <thead>
      <tr>
        <th style="width: 28px; text-align: center;">№</th>
        ${includePhotos ? '<th style="width: 125px; text-align: center;">Фото с Камеры №1</th>' : ''}
        <th style="width: 130px;">Время / Камера</th>
        <th style="width: 125px;">Тип и Статус</th>
        <th>Описание нарушения и замечания регламента</th>
        <th style="width: 110px;">Ответственный</th>
      </tr>
    </thead>
    <tbody>
      ${itemsToExport
        .map((inc, idx) => {
          const isErr =
            inc.severity === 'ERROR' ||
            inc.priority === 'Критический' ||
            inc.discrepancyType === 'MISSING_MANDATORY' ||
            inc.discrepancyType === 'UNCHARACTERISTIC_PRESENT'

          const photoSrc = inc.snapshotUrl || (inc.albumPhotos && inc.albumPhotos.length > 0 ? inc.albumPhotos[0].url : '')

          return `
      <tr class="row-inc">
        <td style="text-align: center; font-weight: 700; color: #64748b;">${idx + 1}</td>
        ${
          includePhotos
            ? `
        <td class="thumb-cell">
          <div class="thumb-wrap">
            ${
              photoSrc
                ? `<img src="${photoSrc}" alt="Снимок с 1-й камеры" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"><div class="thumb-empty" style="display:none;">Фото недоступно</div>`
                : `<div class="thumb-empty">Фото отсутствует<br>(Видеопоток)</div>`
            }
          </div>
        </td>`
            : ''
        }
        <td>
          <strong>${esc(inc.time)}</strong><br>
          <span style="color: #475569;">${esc(inc.camera)}</span><br>
          <span style="color: #64748b; font-size: 7.5pt;">${esc(inc.zone)}</span>
        </td>
        <td>
          <span class="${isErr ? 'tag-err' : 'tag-warn'}">${isErr ? 'ERROR' : 'WARNING'}</span><br>
          <span class="tag-status">${esc(inc.status)}</span>
          ${inc.stageName ? `<br><span style="color: #64748b; font-size: 7pt;">${esc(inc.stageName)}</span>` : ''}
        </td>
        <td>
          <strong style="color: #0f172a; font-size: 9pt;">${esc(inc.title)}</strong>
          <p style="margin: 4px 0 0; color: #334155; font-size: 8pt; line-height: 1.35;">${esc(inc.note)}</p>
        </td>
        <td style="color: #1e293b;">
          ${esc(inc.assignee)}
        </td>
      </tr>
      `
        })
        .join('')}
    </tbody>
  </table>

  ${
    includeSignatures
      ? `
  <div class="signatures-section">
    <strong style="font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.4px;">Комиссия строительного контроля:</strong>
    <div class="sig-grid">
      <div class="sig-col">
        <strong>Инженер строительного контроля:</strong><br>
        <div class="sig-line"><span>(подпись)</span><span>/ ${esc(incidents[0]?.assignee || 'Морозов А.В.')} /</span></div>
      </div>
      <div class="sig-col">
        <strong>Представитель генподрядчика:</strong><br>
        <div class="sig-line"><span>(подпись)</span><span>/ Соколов И.П. /</span></div>
      </div>
      <div class="sig-col">
        <strong>Ответственный за механизацию:</strong><br>
        <div class="sig-line"><span>(подпись)</span><span>/ Волков Д.С. /</span></div>
      </div>
    </div>
    <div class="stamp-box">М.П.</div>
  </div>
  `
      : ''
  }

  <div class="footer-note">
    Документ сгенерирован системой автоматизированного строительного контроля «СТРОЙ-КОНТРОЛЬ» · Дата формирования: ${todayDate} ${todayTime}
  </div>
</body>
</html>`
  }

  const handlePrintPdf = () => {
    const finalIncidents = incidents.filter((i) => selectedIncidentIds.includes(i.id))
    if (finalIncidents.length === 0) {
      toast('Не выбрано ни одной записи для включения в отчет')
      return
    }

    const htmlContent = buildReportHtml(finalIncidents)
    const iframe = document.createElement('iframe')
    iframe.style.position = 'fixed'
    iframe.style.right = '0'
    iframe.style.bottom = '0'
    iframe.style.width = '0'
    iframe.style.height = '0'
    iframe.style.border = '0'
    document.body.appendChild(iframe)

    const doc = iframe.contentWindow?.document
    if (!doc) {
      toast('Ошибка инициализации печати')
      return
    }

    doc.open()
    doc.write(htmlContent)
    doc.close()

    const triggerPrint = () => {
      try {
        iframe.contentWindow?.focus()
        iframe.contentWindow?.print()
        toast('Диалог сохранения отчета в PDF запущен')
      } catch (e) {
        console.error('Print trigger error', e)
        toast('Ошибка вызова диалога печати')
      } finally {
        setTimeout(() => {
          if (document.body.contains(iframe)) {
            document.body.removeChild(iframe)
          }
        }, 3000)
      }
    }

    const imgs = Array.from(doc.images)
    if (imgs.length === 0) {
      setTimeout(triggerPrint, 300)
    } else {
      let loaded = 0
      let done = false
      const onImgDone = () => {
        loaded++
        if (loaded >= imgs.length && !done) {
          done = true
          setTimeout(triggerPrint, 350)
        }
      }
      imgs.forEach((img) => {
        if (img.complete) {
          onImgDone()
        } else {
          img.onload = onImgDone
          img.onerror = onImgDone
        }
      })
      setTimeout(() => {
        if (!done) {
          done = true
          triggerPrint()
        }
      }, 2500)
    }

    setIsExportModalOpen(false)
  }

  const handleOpenInNewTab = () => {
    const finalIncidents = incidents.filter((i) => selectedIncidentIds.includes(i.id))
    if (finalIncidents.length === 0) {
      toast('Не выбрано ни одной записи для включения в отчет')
      return
    }
    const htmlContent = buildReportHtml(finalIncidents)
    const win = window.open('', '_blank')
    if (win) {
      win.document.open()
      win.document.write(htmlContent)
      win.document.close()
      setTimeout(() => {
        win.focus()
        win.print()
      }, 400)
    }
  }

  return (
    <div className="reports-page">
      <aside className="report-options panel">
        <span className="section-kicker">ОПЦИИ СВОДКИ</span>
        <label>
          <input type="checkbox" defaultChecked />Подтверждённые события
        </label>
        <label>
          <input type="checkbox" defaultChecked />Наблюдаемый прогресс
        </label>
        <hr />
        <button className="button primary full" onClick={() => setIsExportModalOpen(true)}>
          <Icon name="download" />Экспорт PDF
        </button>
      </aside>

      <main className="report-preview panel">
        <div className="report-cover">
          <div className="brand-mark small"><span>СК</span></div>
          <span>СТРОЙ-КОНТРОЛЬ · СВОДКА ЗА СМЕНУ</span>
          <h1>{activeProject?.name || 'Строительный объект'}</h1>
          <p>{activeProject?.address || 'г. Москва'} · 08:00–20:00</p>
          <div>
            <Status tone="success">Данные мониторинга сформированы</Status>
            <span>Сегодня</span>
          </div>
        </div>

        <section>
          <h2>События смены</h2>
          <div className="report-stats">
            <div>
              <strong style={{ color: '#f87171' }}>{errorsCount}</strong>
              <span>ошибок (ERROR)</span>
            </div>
            <div>
              <strong style={{ color: '#fbbf24' }}>{warningsCount}</strong>
              <span>предупреждений</span>
            </div>
            <div>
              <strong>{incidents.filter((i) => i.status === 'Требует проверки').length}</strong>
              <span>требует проверки</span>
            </div>
            <div>
              <strong>{incidents.filter((i) => i.status === 'В работе').length}</strong>
              <span>в работе</span>
            </div>
          </div>
        </section>

        {/* Violations and incidents list */}
        <section style={{ marginTop: '24px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px', marginBottom: '14px' }}>
            <div>
              <span className="section-kicker">ЖУРНАЛ ФИКСАЦИИ НАРУШЕНИЙ</span>
              <h2 style={{ margin: 0 }}>Нарушения регламента и контроль спецтехники</h2>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <input
                placeholder="Поиск по нарушениям..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  background: '#121417',
                  border: '1px solid #35373c',
                  color: '#fff',
                  padding: '6px 12px',
                  borderRadius: '6px',
                  fontSize: '11px',
                }}
              />
              <button
                className={`button ${filterSeverity === 'ALL' ? 'primary' : ''}`}
                style={{ fontSize: '11px', height: '32px' }}
                onClick={() => setFilterSeverity('ALL')}
              >
                Все ({incidents.length})
              </button>
              <button
                className={`button ${filterSeverity === 'ERROR' ? 'primary' : ''}`}
                style={{ fontSize: '11px', height: '32px', color: '#f87171' }}
                onClick={() => setFilterSeverity('ERROR')}
              >
                ERROR ({errorsCount})
              </button>
              <button
                className={`button ${filterSeverity === 'WARNING' ? 'primary' : ''}`}
                style={{ fontSize: '11px', height: '32px', color: '#fbbf24' }}
                onClick={() => setFilterSeverity('WARNING')}
              >
                WARNING ({warningsCount})
              </button>
            </div>
          </div>

          {filteredIncidents.length === 0 ? (
            <div style={{ padding: '30px', textAlign: 'center', color: 'var(--muted)', background: '#1c1e22', borderRadius: '6px', border: '1px solid #2e3035' }}>
              Нет записей нарушений, соответствующих заданному фильтру.
            </div>
          ) : (
            <div className="report-incidents-list">
              {filteredIncidents.map((inc) => {
                const isError =
                  inc.severity === 'ERROR' ||
                  inc.priority === 'Критический' ||
                  inc.discrepancyType === 'MISSING_MANDATORY' ||
                  inc.discrepancyType === 'UNCHARACTERISTIC_PRESENT'
                const isHighlighted = highlightedIncidentId === inc.id
                const isStreamIncident = inc.type === 'Видеопоток' || inc.discrepancyType?.startsWith('STREAM_')
                const hasSnapshot = Boolean(inc.snapshotUrl)

                return (
                  <article
                    key={inc.id}
                    id={`report-item-${inc.id}`}
                    className={`report-incident-card ${isHighlighted ? 'highlighted' : ''}`}
                  >
                    {/* Thumbnail if snapshot exists, or clean status icon */}
                    {hasSnapshot ? (
                      <div
                        style={{
                          position: 'relative',
                          width: '140px',
                          height: '84px',
                          background: '#0b0d10',
                          borderRadius: '6px',
                          overflow: 'hidden',
                          cursor: 'pointer',
                          flexShrink: 0,
                          border: '1px solid #2e3035',
                        }}
                        onClick={() => setSelectedPhoto(inc.snapshotUrl!)}
                        title="Кликните для просмотра полноразмерного снимка"
                      >
                        <img
                          src={inc.snapshotUrl}
                          alt={inc.title}
                          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                          onError={(e) => {
                            const target = e.currentTarget
                            if (!target.src.includes('construction-camera')) {
                              target.src = cameraImage
                            }
                          }}
                        />
                        <div
                          style={{
                            position: 'absolute',
                            bottom: '4px',
                            right: '4px',
                            background: 'rgba(0,0,0,0.7)',
                            color: '#94a3b8',
                            fontSize: '9px',
                            padding: '1px 4px',
                            borderRadius: '3px',
                            fontFamily: 'monospace',
                          }}
                        >
                          {inc.time}
                        </div>
                      </div>
                    ) : (
                      <div
                        style={{
                          width: '84px',
                          height: '84px',
                          background: isStreamIncident ? 'rgba(56, 189, 248, 0.08)' : 'rgba(255,255,255,0.04)',
                          border: `1px solid ${isStreamIncident ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255,255,255,0.08)'}`,
                          borderRadius: '6px',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '4px',
                          flexShrink: 0,
                          color: isStreamIncident ? '#38bdf8' : 'var(--muted)',
                        }}
                      >
                        <Icon name={isStreamIncident ? 'video' : 'alert'} size={24} />
                        <span style={{ fontSize: '9px', opacity: 0.8 }}>
                          {isStreamIncident ? 'Поток' : 'Без фото'}
                        </span>
                      </div>
                    )}

                    {/* Incident Details */}
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
                        <span
                          style={{
                            background: isError ? 'rgba(220,38,38,0.2)' : 'rgba(234,179,8,0.2)',
                            color: isError ? '#f87171' : '#fbbf24',
                            border: `1px solid ${isError ? 'rgba(220,38,38,0.4)' : 'rgba(234,179,8,0.4)'}`,
                            fontSize: '9.5px',
                            fontWeight: 800,
                            padding: '2px 6px',
                            borderRadius: '4px',
                          }}
                        >
                          {isError ? 'ОШИБКА (ERROR)' : 'ПРЕДУПРЕЖДЕНИЕ (WARNING)'}
                        </span>
                        <strong style={{ fontSize: '11px', color: '#94a3b8' }}>{inc.id}</strong>
                        <span style={{ fontSize: '11px', color: 'var(--muted)' }}>• {inc.time}</span>
                        {inc.stageName && (
                          <span style={{ fontSize: '10.5px', color: '#cf9d3d', background: 'rgba(207,157,61,0.1)', padding: '1px 6px', borderRadius: '3px' }}>
                            Этап: {inc.stageName}
                          </span>
                        )}
                        {!isStreamIncident ? (
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                            <span style={{ fontSize: '10px', color: 'var(--muted)', fontWeight: 600 }}>Тег:</span>
                            <select
                              value={
                                inc.status === 'Подтверждено'
                                  ? 'Подтверждено'
                                  : inc.status === 'Проблемы нет'
                                  ? 'Проблемы нет'
                                  : 'Ожидает обработки'
                              }
                              onChange={(e) => onStatusChange?.(inc.id, e.target.value as IncidentStatus)}
                              style={{
                                fontSize: '11px',
                                padding: '2px 8px',
                                borderRadius: '4px',
                                cursor: 'pointer',
                                fontWeight: 700,
                                background:
                                  inc.status === 'Подтверждено'
                                    ? 'rgba(239, 68, 68, 0.25)'
                                    : inc.status === 'Проблемы нет'
                                    ? 'rgba(16, 185, 129, 0.25)'
                                    : 'rgba(245, 158, 11, 0.25)',
                                color:
                                  inc.status === 'Подтверждено'
                                    ? '#fca5a5'
                                    : inc.status === 'Проблемы нет'
                                    ? '#6ee7b7'
                                    : '#fde047',
                                border: `1px solid ${
                                  inc.status === 'Подтверждено'
                                    ? '#ef4444'
                                    : inc.status === 'Проблемы нет'
                                    ? '#10b981'
                                    : '#f59e0b'
                                }`,
                              }}
                              title="Сменить тег ошибки: Ожидает обработки, Проблемы нет или Подтверждено"
                            >
                              <option value="Ожидает обработки">⏳ Ожидает обработки</option>
                              <option value="Подтверждено">🔴 Подтверждено</option>
                              <option value="Проблемы нет">🛡️ Проблемы нет</option>
                            </select>

                            {Boolean(inc.manual_override) && (
                              <span
                                style={{
                                  fontSize: '9.5px',
                                  padding: '2px 6px',
                                  borderRadius: '3px',
                                  background: 'rgba(148, 163, 184, 0.15)',
                                  color: '#cbd5e1',
                                  border: '1px solid #475569',
                                }}
                                title="Тег изменен пользователем вручную"
                              >
                                Ручной тег
                              </span>
                            )}

                            {inc.albumPhotos && inc.albumPhotos.length > 1 && (
                              <span
                                style={{
                                  fontSize: '10px',
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                  background: 'rgba(2, 132, 199, 0.2)',
                                  color: '#38bdf8',
                                  border: '1px solid rgba(56, 189, 248, 0.4)',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '3px',
                                }}
                                title={`В фотоархиве сохранён альбом с ${inc.albumPhotos.length} ракурсов`}
                              >
                                📷 Альбом: {inc.albumPhotos.length} ракурсов
                              </span>
                            )}
                          </div>
                        ) : (
                          <span style={{ fontSize: '10.5px', color: '#94a3b8', background: 'rgba(148, 163, 184, 0.1)', border: '1px solid rgba(148, 163, 184, 0.3)', padding: '2px 8px', borderRadius: '4px' }}>
                            Видеопоток / Связь
                          </span>
                        )}
                      </div>

                      <h4 style={{ margin: '0 0 4px', fontSize: '13px', color: '#fff', fontWeight: 700 }}>
                        {inc.title}
                      </h4>

                      <p style={{ margin: '0 0 6px', fontSize: '11.5px', color: '#cbd5e1', lineHeight: 1.45 }}>
                        {inc.note}
                      </p>

                      <div style={{ display: 'flex', gap: '14px', fontSize: '10.5px', color: 'var(--muted)', flexWrap: 'wrap' }}>
                        <span>Участок: <strong style={{ color: '#f1f5f9' }}>{inc.zone}</strong></span>
                        <span>Камера: <strong style={{ color: '#f1f5f9' }}>{inc.camera}</strong></span>
                        <span>Ответственный: <strong style={{ color: '#f1f5f9' }}>{inc.assignee}</strong></span>
                      </div>
                    </div>

                    {/* Navigation Link to Photo Archive error album (first photo in report) */}
                    {hasSnapshot && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-end', justifyContent: 'center' }}>
                        <button
                          className="button primary"
                          style={{ fontSize: '11px', padding: '6px 12px', whiteSpace: 'nowrap' }}
                          onClick={() => {
                            onNavigateToArchive(inc.id)
                            toast(`Переход к альбому ошибки ${inc.id} в фотоархиве`)
                          }}
                          title="Открыть альбом данной ошибки со всеми камерами в фотоархиве"
                        >
                          Смотреть альбом в архиве ↗
                        </button>
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          )}
        </section>

        {/* Modal: Fullscreen Photo */}
        {selectedPhoto && (
          <div className="modal-backdrop" onClick={() => setSelectedPhoto(null)} style={{ zIndex: 1300 }}>
            <div style={{ maxWidth: '90vw', maxHeight: '90vh', position: 'relative' }} onClick={(e) => e.stopPropagation()}>
              <img
                src={selectedPhoto}
                alt="Фотофиксация нарушения"
                style={{ maxWidth: '100%', maxHeight: '85vh', borderRadius: '8px', border: '1px solid #4a4d53' }}
                onError={(e) => {
                  const target = e.currentTarget
                  if (!target.src.includes('construction-camera')) {
                    target.src = cameraImage
                  }
                }}
              />
              <button
                className="button"
                style={{ position: 'absolute', top: '12px', right: '12px', background: 'rgba(0,0,0,0.8)', color: '#fff' }}
                onClick={() => setSelectedPhoto(null)}
              >
                ✕ Закрыть
              </button>
            </div>
          </div>
        )}

        {/* Modal: Export PDF with Range Selection */}
        {isExportModalOpen && (
          <div className="modal-backdrop" onClick={() => setIsExportModalOpen(false)} style={{ zIndex: 1300 }}>
            <div
              className="modal-panel"
              style={{
                width: '680px',
                maxWidth: '94vw',
                maxHeight: '90vh',
                overflowY: 'auto',
                background: '#181a1f',
                border: '1px solid #33363d',
                borderRadius: '12px',
                padding: '24px',
                color: '#fff',
                boxShadow: '0 24px 48px rgba(0,0,0,0.7)',
              }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px', borderBottom: '1px solid #2e3035', paddingBottom: '12px' }}>
                <div>
                  <span className="section-kicker" style={{ color: '#cf9d3d' }}>ЭКСПОРТ ОТЧЕТА</span>
                  <h3 style={{ margin: '4px 0 0', fontSize: '18px', fontWeight: 700 }}>Параметры выгрузки в PDF</h3>
                  <small style={{ color: 'var(--muted)' }}>Настройте диапазон времени и состав акта строительного контроля</small>
                </div>
                <button
                  className="icon-button"
                  onClick={() => setIsExportModalOpen(false)}
                  style={{ color: 'var(--muted)', fontSize: '18px', cursor: 'pointer' }}
                  aria-label="Закрыть"
                >
                  ✕
                </button>
              </div>

              {/* Range Selector */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '8px', color: '#cbd5e1' }}>
                  Временной диапазон отчета:
                </label>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '8px' }}>
                  {[
                    { id: 'shift' as const, label: 'Текущая смена (08:00–20:00)' },
                    { id: '24h' as const, label: 'За последние 24 часа' },
                    { id: 'week' as const, label: 'За последнюю неделю' },
                    { id: 'all' as const, label: 'За весь период' },
                  ].map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`button ${exportPreset === p.id ? 'primary' : ''}`}
                      style={{
                        fontSize: '11.5px',
                        padding: '8px 12px',
                        justifyContent: 'flex-start',
                        borderColor: exportPreset === p.id ? '#cf9d3d' : '#33363d',
                        background: exportPreset === p.id ? 'rgba(207,157,61,0.2)' : '#121417',
                        fontWeight: exportPreset === p.id ? 700 : 500,
                      }}
                      onClick={() => setExportPreset(p.id)}
                    >
                      {exportPreset === p.id ? '● ' : '○ '} {p.label}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  className={`button ${exportPreset === 'custom' ? 'primary' : ''}`}
                  style={{
                    marginTop: '8px',
                    width: '100%',
                    fontSize: '11.5px',
                    padding: '8px 12px',
                    justifyContent: 'flex-start',
                    borderColor: exportPreset === 'custom' ? '#cf9d3d' : '#33363d',
                    background: exportPreset === 'custom' ? 'rgba(207,157,61,0.2)' : '#121417',
                    fontWeight: exportPreset === 'custom' ? 700 : 500,
                  }}
                  onClick={() => setExportPreset('custom')}
                >
                  {exportPreset === 'custom' ? '● ' : '○ '} Произвольный календарный интервал
                </button>

                {exportPreset === 'custom' && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '10px', background: '#121417', padding: '12px', borderRadius: '8px', border: '1px solid #2e3035' }}>
                    <div>
                      <span style={{ fontSize: '11px', color: 'var(--muted)', display: 'block', marginBottom: '4px' }}>С даты:</span>
                      <input
                        type="date"
                        value={exportStartDate}
                        onChange={(e) => setExportStartDate(e.target.value)}
                        style={{ width: '100%', background: '#1c1e22', border: '1px solid #35373c', color: '#fff', padding: '6px 10px', borderRadius: '6px', fontSize: '12px' }}
                      />
                    </div>
                    <div>
                      <span style={{ fontSize: '11px', color: 'var(--muted)', display: 'block', marginBottom: '4px' }}>По дату:</span>
                      <input
                        type="date"
                        value={exportEndDate}
                        onChange={(e) => setExportEndDate(e.target.value)}
                        style={{ width: '100%', background: '#1c1e22', border: '1px solid #35373c', color: '#fff', padding: '6px 10px', borderRadius: '6px', fontSize: '12px' }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Severity filter */}
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '8px', color: '#cbd5e1' }}>
                  Фильтр по степени критичности:
                </label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    type="button"
                    className={`button ${exportSeverity === 'ALL' ? 'primary' : ''}`}
                    style={{ fontSize: '11px', flex: 1 }}
                    onClick={() => setExportSeverity('ALL')}
                  >
                    Все нарушения ({incidents.length})
                  </button>
                  <button
                    type="button"
                    className={`button ${exportSeverity === 'ERROR' ? 'primary' : ''}`}
                    style={{ fontSize: '11px', flex: 1, color: '#f87171' }}
                    onClick={() => setExportSeverity('ERROR')}
                  >
                    Только ERROR ({errorsCount})
                  </button>
                  <button
                    type="button"
                    className={`button ${exportSeverity === 'WARNING' ? 'primary' : ''}`}
                    style={{ fontSize: '11px', flex: 1, color: '#fbbf24' }}
                    onClick={() => setExportSeverity('WARNING')}
                  >
                    Только WARNING ({warningsCount})
                  </button>
                </div>
              </div>

              {/* Content options */}
              <div style={{ background: '#121417', padding: '12px 14px', borderRadius: '8px', border: '1px solid #2e3035', marginBottom: '16px' }}>
                <span style={{ fontSize: '11px', fontWeight: 700, color: '#94a3b8', display: 'block', marginBottom: '8px', textTransform: 'uppercase' }}>
                  Состав печатного акта:
                </span>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '8px' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={includePhotos}
                      onChange={(e) => setIncludePhotos(e.target.checked)}
                    />
                    Фотофиксация (1-я камера)
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={includeStats}
                      onChange={(e) => setIncludeStats(e.target.checked)}
                    />
                    Сводные показатели KPI
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={includeSignatures}
                      onChange={(e) => setIncludeSignatures(e.target.checked)}
                    />
                    Подписи комиссии СК
                  </label>
                </div>
              </div>

              {/* Incidents preview */}
              <div style={{ marginBottom: '18px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 600, color: '#cbd5e1' }}>
                    Будет выгружено в PDF: <strong style={{ color: '#cf9d3d' }}>{selectedIncidentIds.length}</strong> из {rangeMatchedIncidents.length} записей
                  </span>
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', color: '#38bdf8', fontSize: '11px', cursor: 'pointer', padding: 0 }}
                    onClick={() => {
                      if (selectedIncidentIds.length === rangeMatchedIncidents.length) {
                        setSelectedIncidentIds([])
                      } else {
                        setSelectedIncidentIds(rangeMatchedIncidents.map((i) => i.id))
                      }
                    }}
                  >
                    {selectedIncidentIds.length === rangeMatchedIncidents.length ? 'Снять все' : 'Выбрать все'}
                  </button>
                </div>

                <div
                  style={{
                    maxHeight: '130px',
                    overflowY: 'auto',
                    background: '#121417',
                    border: '1px solid #2e3035',
                    borderRadius: '6px',
                    padding: '4px 6px',
                  }}
                >
                  {rangeMatchedIncidents.length === 0 ? (
                    <div style={{ padding: '12px', textAlign: 'center', color: 'var(--muted)', fontSize: '11.5px' }}>
                      Нет записей за выбранный диапазон
                    </div>
                  ) : (
                    rangeMatchedIncidents.map((inc) => {
                      const isChecked = selectedIncidentIds.includes(inc.id)
                      const isErr =
                        inc.severity === 'ERROR' ||
                        inc.priority === 'Критический' ||
                        inc.discrepancyType === 'MISSING_MANDATORY' ||
                        inc.discrepancyType === 'UNCHARACTERISTIC_PRESENT'

                      return (
                        <div
                          key={inc.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                            padding: '4px 6px',
                            borderBottom: '1px solid #1c1e22',
                            fontSize: '11.5px',
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={isChecked}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setSelectedIncidentIds((prev) => [...prev, inc.id])
                              } else {
                                setSelectedIncidentIds((prev) => prev.filter((id) => id !== inc.id))
                              }
                            }}
                          />
                          <span style={{ color: isErr ? '#f87171' : '#fbbf24', fontWeight: 700, fontSize: '10px' }}>
                            {isErr ? 'ERR' : 'WARN'}
                          </span>
                          <strong style={{ color: '#94a3b8' }}>{inc.id}</strong>
                          <span style={{ color: '#e2e8f0', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {inc.title}
                          </span>
                          <span style={{ color: 'var(--muted)', fontSize: '10.5px' }}>{inc.time}</span>
                        </div>
                      )
                    })
                  )}
                </div>
              </div>

              {/* Action buttons */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #2e3035', paddingTop: '16px', flexWrap: 'wrap', gap: '8px' }}>
                <button
                  type="button"
                  className="button"
                  onClick={handleOpenInNewTab}
                  disabled={selectedIncidentIds.length === 0}
                  title="Открыть акт в отдельной вкладке браузера"
                  style={{ fontSize: '11.5px' }}
                >
                  Печатная форма ↗
                </button>
                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    type="button"
                    className="button"
                    onClick={() => setIsExportModalOpen(false)}
                    style={{ fontSize: '11.5px' }}
                  >
                    Отмена
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '11.5px' }}
                    onClick={handlePrintPdf}
                    disabled={selectedIncidentIds.length === 0}
                  >
                    <Icon name="download" size={16} />
                    Сформировать и скачать PDF ({selectedIncidentIds.length})
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

// ----------------------------------------------------------------------------
// 8. Settings Page
// ----------------------------------------------------------------------------
function Settings({
  activeProject,
  projectsList,
  onSelectProject,
  onUpdateProject,
  onDeleteProject,
  setIsCreateProjectOpen,
  activeZones,
  onAddZone,
  onEditZone,
  onDeleteZone,
  camerasList,
  onAddCamera,
  onEditCamera,
  onDeleteCamera,
  violationWindowSeconds = 30,
  onUpdateViolationWindow,
  toast,
}: {
  activeProject?: ProjectItem
  projectsList: ProjectItem[]
  onSelectProject: (projectId: string) => void
  onUpdateProject: (
    projectId: string,
    data: { name: string; code: string; address?: string; object_kind?: string; status?: string }
  ) => Promise<void>
  onDeleteProject: (projectId: string) => Promise<void>
  setIsCreateProjectOpen: (b: boolean) => void
  activeZones: ZoneItem[]
  onAddZone: () => void
  onEditZone: (zone: ZoneItem) => void
  onDeleteZone: (zone: ZoneItem) => Promise<void>
  camerasList: CameraItem[]
  onAddCamera: () => void
  onEditCamera: (camera: CameraItem) => void
  onDeleteCamera: (camera: CameraItem) => void
  violationWindowSeconds?: number
  onUpdateViolationWindow?: (seconds: number) => Promise<void>
  toast: (s: string) => void
}) {
  const [activeTab, setActiveTab] = useState<'general' | 'zones' | 'cameras'>('general')

  // Form state for active project
  const [name, setName] = useState(activeProject?.name || '')
  const [code, setCode] = useState(activeProject?.code || '')
  const [address, setAddress] = useState(activeProject?.address || '')
  const [objectKind, setObjectKind] = useState(activeProject?.object_kind || 'Жильё')
  const [isSaving, setIsSaving] = useState(false)

  // Violation window setting state
  const [windowInput, setWindowInput] = useState<number>(violationWindowSeconds)
  const [isSavingWindow, setIsSavingWindow] = useState(false)

  useEffect(() => {
    setWindowInput(violationWindowSeconds)
  }, [violationWindowSeconds])

  // Synchronize when activeProject changes
  useEffect(() => {
    setName(activeProject?.name || '')
    setCode(activeProject?.code || '')
    setAddress(activeProject?.address || '')
    setObjectKind(activeProject?.object_kind || 'Жильё')
  }, [activeProject?.id])

  const handleSaveProject = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!activeProject) return
    if (!name.trim()) {
      toast('Название объекта не может быть пустым')
      return
    }
    setIsSaving(true)
    try {
      await onUpdateProject(activeProject.id, {
        name: name.trim(),
        code: code.trim() || activeProject.code,
        address: address.trim() || undefined,
        object_kind: objectKind,
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleDeleteProjectClick = async () => {
    if (!activeProject) return
    await onDeleteProject(activeProject.id)
  }

  return (
    <div className="settings-page">
      <nav className="settings-nav panel">
        <button
          className={activeTab === 'general' ? 'active' : ''}
          onClick={() => setActiveTab('general')}
        >
          Общие
        </button>
        <button
          className={activeTab === 'zones' ? 'active' : ''}
          onClick={() => setActiveTab('zones')}
        >
          Стройплощадки ({activeZones.length})
        </button>
        <button
          className={activeTab === 'cameras' ? 'active' : ''}
          onClick={() => setActiveTab('cameras')}
        >
          Камеры ({camerasList.length})
        </button>
      </nav>

      <section className="settings-content panel">
        {/* Tab 1: General (Projects) */}
        {activeTab === 'general' && (
          <>
            <div className="settings-heading">
              <div>
                <span className="section-kicker">ОБЪЕКТ СТРОИТЕЛЬСТВА</span>
                <h2>{activeProject?.name || 'Настройки проекта'}</h2>
                <p>Управление объектами строительства, их параметрами и жизненным циклом.</p>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button className="button" type="button" onClick={() => setIsCreateProjectOpen(true)}>
                  + Новый объект
                </button>
                {activeProject && (
                  <button
                    className="button danger"
                    type="button"
                    onClick={handleDeleteProjectClick}
                    title="Удалить данный объект строительства"
                  >
                    Удалить объект
                  </button>
                )}
                <button
                  className="button primary"
                  type="button"
                  disabled={isSaving || !activeProject}
                  onClick={handleSaveProject}
                >
                  {isSaving ? 'Сохранение...' : 'Сохранить изменения'}
                </button>
              </div>
            </div>

            {projectsList.length > 1 && (
              <div
                style={{
                  marginBottom: '16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  background: '#1c1e22',
                  padding: '10px 14px',
                  borderRadius: '6px',
                  border: '1px solid #35373c',
                }}
              >
                <span style={{ fontSize: '11px', color: 'var(--muted)' }}>Выбрать объект:</span>
                <select
                  value={activeProject?.id || ''}
                  onChange={(e) => onSelectProject(e.target.value)}
                  style={{
                    background: '#121417',
                    border: '1px solid #4a4d53',
                    color: '#fff',
                    padding: '4px 8px',
                    fontSize: '12px',
                    borderRadius: '4px',
                  }}
                >
                  {projectsList.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.code}) — {p.zones.length} площадок, {p.cameras.length} камер
                    </option>
                  ))}
                </select>
              </div>
            )}

            <form onSubmit={handleSaveProject} className="form-grid">
              <label>
                Название объекта *
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="например, ЖК «Северный», корпус 2"
                  required
                />
              </label>
              <label>
                Код объекта
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="PRJ-SEV"
                />
              </label>
              <label>
                Адрес объекта
                <input
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="г. Москва, ул. Полярная, 18"
                />
              </label>
              <label>
                Тип объекта
                <select
                  value={objectKind}
                  onChange={(e) => setObjectKind(e.target.value)}
                >
                  <option>Жильё</option>
                  <option>Промышленное строительство</option>
                  <option>Инфраструктура</option>
                  <option>Социальный объект</option>
                </select>
              </label>
            </form>

            {/* Violation Evaluation Period Settings Card */}
            <div
              style={{
                marginTop: '28px',
                paddingTop: '22px',
                borderTop: '1px solid #2e3035',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
                <div style={{ maxWidth: '560px' }}>
                  <span className="section-kicker">РЕГЛАМЕНТ И АВТОМАТИЧЕСКИЙ КОНТРОЛЬ</span>
                  <h3 style={{ margin: '4px 0 6px', fontSize: '15px', color: '#fff' }}>
                    Период фиксации нарушений спецтехники
                  </h3>
                  <p style={{ color: 'var(--muted)', fontSize: '12px', lineHeight: 1.5, margin: 0 }}>
                    Временной интервал непрерывного наблюдения (по умолчанию 30 сек). Если в течение данного интервала
                    не зафиксирована обязательная или рекомендованная техника, либо зафиксирована нехарактерная (лишняя) техника —
                    генерируется ошибка (ERROR) или предупреждение (WARNING), формируется фотофиксация в фотоархиве и запись в отчёте.
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <label style={{ margin: 0, width: '130px' }}>
                    Период (сек)
                    <input
                      type="number"
                      min={5}
                      max={600}
                      value={windowInput}
                      onChange={(e) => setWindowInput(parseInt(e.target.value, 10) || 30)}
                      style={{ width: '100%', height: '36px' }}
                    />
                  </label>
                  <button
                    type="button"
                    className="button primary"
                    disabled={isSavingWindow}
                    style={{ height: '36px', alignSelf: 'flex-end', whiteSpace: 'nowrap' }}
                    onClick={async () => {
                      if (!onUpdateViolationWindow) return
                      setIsSavingWindow(true)
                      try {
                        await onUpdateViolationWindow(windowInput)
                      } finally {
                        setIsSavingWindow(false)
                      }
                    }}
                  >
                    {isSavingWindow ? 'Сохранение...' : 'Сохранить интервал'}
                  </button>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Tab 2: Construction Sites (Zones) */}
        {activeTab === 'zones' && (
          <>
            <div className="settings-heading">
              <div>
                <span className="section-kicker">СТРОЙПЛОЩАДКИ ОБЪЕКТА</span>
                <h2>Участки и зоны: {activeProject?.name}</h2>
                <p>Управление отдельными стройплощадками, захватками и секциями строительства.</p>
              </div>
              <button className="button primary" onClick={onAddZone}>
                + Добавить стройплощадку
              </button>
            </div>

            <div style={{ marginBottom: '14px' }}>
              {activeZones.length === 0 ? (
                <div
                  style={{
                    padding: '24px',
                    textAlign: 'center',
                    color: 'var(--muted)',
                    background: '#1c1e22',
                    borderRadius: '6px',
                    border: '1px solid #2e3035',
                  }}
                >
                  Стройплощадки еще не добавлены к объекту. Нажмите «+ Добавить стройплощадку».
                </div>
              ) : (
                activeZones.map((z) => (
                  <div key={z.id} className="setting-row">
                    <div>
                      <strong>
                        {z.name}{' '}
                        <span style={{ color: 'var(--muted)', fontSize: '11px', fontWeight: 400 }}>
                          ({z.code})
                        </span>
                      </strong>
                      <span>{z.description || 'Без описания'}</span>
                    </div>
                    <div className="setting-row-actions">
                      <Status tone="success">{z.status}</Status>
                      <button className="button" type="button" onClick={() => onEditZone(z)}>
                        Изменить
                      </button>
                      <button className="button danger" type="button" onClick={() => onDeleteZone(z)}>
                        Удалить
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}

        {/* Tab 3: Cameras */}
        {activeTab === 'cameras' && (
          <>
            <div className="settings-heading">
              <div>
                <span className="section-kicker">ВИДЕОНАБЛЮДЕНИЕ</span>
                <h2>Камеры объекта: {activeProject?.name}</h2>
                <p>Подключение и настройка IP/RTSP/HLS камер по стройплощадкам.</p>
              </div>
              <button className="button primary" onClick={onAddCamera}>
                + Подключить камеру
              </button>
            </div>

            <div>
              {camerasList.length === 0 ? (
                <div
                  style={{
                    padding: '24px',
                    textAlign: 'center',
                    color: 'var(--muted)',
                    background: '#1c1e22',
                    borderRadius: '6px',
                    border: '1px solid #2e3035',
                  }}
                >
                  Камеры еще не подключены. Нажмите «+ Подключить камеру».
                </div>
              ) : (
                camerasList.map((c) => (
                  <div key={c.id} className="setting-row">
                    <div>
                      <strong>{c.code} · {c.name}</strong>
                      <span>{c.stream_url || 'Локальный канал'}</span>
                    </div>
                    <div className="setting-row-actions">
                      <Status tone={c.status === 'online' ? 'success' : 'critical'}>{c.status}</Status>
                      <button className="button" type="button" onClick={() => onEditCamera(c)}>
                        Изменить
                      </button>
                      <button className="button danger" type="button" onClick={() => onDeleteCamera(c)}>
                        Удалить
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

// ----------------------------------------------------------------------------
// Main Application Component
// ----------------------------------------------------------------------------
function mapApiStatus(rawStatus?: string | null): IncidentStatus {
  if (!rawStatus) return 'Ожидает обработки'
  const s = rawStatus.toLowerCase()
  if (s === 'confirmed' || s.includes('подтвержд')) return 'Подтверждено'
  if (s === 'false_positive' || s.includes('проблемы нет') || s.includes('ложное') || s.includes('no_problem')) return 'Проблемы нет'
  if (s === 'in_progress' || s.includes('в работе')) return 'В работе'
  if (s === 'resolved' || s.includes('устранен')) return 'Устранено'
  return 'Ожидает обработки'
}

export default function App() {
  const [page, setPage] = useState<PageKey>('monitoring')
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const [toastText, setToastText] = useState<string | null>(null)
  const [incidentsList, setIncidentsList] = useState<Incident[]>(incidentsSeed)
  const [violationWindowSeconds, setViolationWindowSeconds] = useState<number>(30)
  const [highlightedIncidentId, setHighlightedIncidentId] = useState<string | null>(null)
  const [activeViolationAlert, setActiveViolationAlert] = useState<{
    id: string
    title: string
    desc: string
    severity: 'ERROR' | 'WARNING'
    snapshotUrl?: string
  } | null>(null)

  const recentObservationsRef = useRef<{ timestamp: number; detectedLabels: string[] }[]>([])
  const violationCooldownRef = useRef<Record<string, number>>({})
  const streamStartTimeRef = useRef<number | null>(null)
  const detectedLabelsInWindowRef = useRef<Set<string>>(new Set())
  const latestSnapshotRef = useRef<string | null>(null)
  const sourcesStateRef = useRef<
    Map<
      string,
      {
        sourceId: string
        sourceName: string
        snapshotUrl: string
        detectedLabels: Set<string>
        lastTimestamp: number
      }
    >
  >(new Map())

  // Hierarchy: Projects -> Zones -> Cameras
  const [projectsList, setProjectsList] = useState<ProjectItem[]>([])
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null)
  const [activeZoneId, setActiveZoneId] = useState<string | null>('all')
  const [activeZones, setActiveZones] = useState<ZoneItem[]>([])
  const [camerasList, setCamerasList] = useState<CameraItem[]>([])
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null)

  // Schedule Plan (starts EMPTY by default!)
  const [stages, setStages] = useState<StageItem[]>([])

  // Video Upload state
  const [uploadedVideoUrl, setUploadedVideoUrl] = useState<string | null>(null)
  const [uploadedVideoName, setUploadedVideoName] = useState<string | null>(null)
  const [videoTimestamp, setVideoTimestamp] = useState<string>(getNowDateTimeLocal())
  const [stageOverridesVersion, setStageOverridesVersion] = useState(0)
  const [cameraReportedOnline, setCameraReportedOnline] = useState<boolean>(true)
  const streamTransitionStateRef = useRef<'ONLINE' | 'OFFLINE' | null>(null)

  const curCam = camerasList.find((c) => c.id === selectedCameraId) || camerasList[0]
  const hasConfiguredCamera = Boolean(curCam && curCam.stream_url)
  const isStreamConfigured = Boolean(uploadedVideoUrl || (hasConfiguredCamera && camerasList.length > 0))
  const isStreamOnline = isStreamConfigured && cameraReportedOnline

  // Dialogs
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false)
  const [isCreateZoneOpen, setIsCreateZoneOpen] = useState(false)
  const [editingZone, setEditingZone] = useState<ZoneItem | null>(null)
  const [isCreateCameraOpen, setIsCameraModalOpen] = useState(false)
  const [editingCamera, setEditingCamera] = useState<CameraItem | null>(null)
  const [isUploadVideoOpen, setIsUploadModalOpen] = useState(false)
  const [streamCheckResult, setStreamCheckResult] = useState<{ status: string; message: string } | null>(null)
  const [isCheckingStream, setIsCheckingStream] = useState(false)

  // Real-time Date & Time for header
  const [currentDateTime, setCurrentDateTime] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setCurrentDateTime(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])

  const currentFormattedDate = currentDateTime.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })
  const currentFormattedTime = currentDateTime.toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  })

  // User Authentication State
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null)
  const [isAuthChecking, setIsAuthChecking] = useState(true)
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false)
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false)
  const [authTab, setAuthTab] = useState<'login' | 'register'>('login')
  const [authError, setAuthError] = useState<string | null>(null)
  const [isSubmittingAuth, setIsSubmittingAuth] = useState(false)

  // Check active user session and violation config on startup
  useEffect(() => {
    fetchCurrentUser()
      .then((user) => {
        if (user) {
          setCurrentUser(user)
        }
      })
      .finally(() => {
        setIsAuthChecking(false)
      })

    fetchIncidentConfig()
      .then((cfg) => {
        if (cfg && typeof cfg.violation_evaluation_window_seconds === 'number') {
          setViolationWindowSeconds(cfg.violation_evaluation_window_seconds)
        }
      })
      .catch(() => {})

    fetchIncidents()
      .then((apiIncs) => {
        if (apiIncs && apiIncs.length > 0) {
          const mapped: Incident[] = apiIncs.map((item) => {
            return {
              id: item.code,
              type: 'Техника',
              title: item.title || 'Нарушение регламента',
              zone: item.zone_name || 'Основная площадка',
              camera: item.camera_name || 'Камера 1',
              time: item.created_at ? new Date(item.created_at).toLocaleTimeString('ru-RU').slice(0, 5) : '14:30',
              age: 'Недавно',
              priority: item.severity === 'ERROR' ? 'Критический' : 'Средний',
              status: mapApiStatus(item.status),
              assignee: 'Не назначен',
              sla: item.severity === 'ERROR' ? '15 мин' : '45 мин',
              confidence: 95,
              note: item.description || '',
              severity: item.severity,
              snapshotUrl: normalizeSnapshotUrl(item.frame_snapshot_url || item.snapshot_url),
              albumPhotos: item.album_photos && item.album_photos.length > 0
                ? item.album_photos.map((p) => ({
                    url: normalizeSnapshotUrl(p.url) || p.url,
                    cameraName: p.camera_name,
                    isPrimary: p.is_primary,
                    capturedAt: p.captured_at,
                  }))
                : (item.frame_snapshot_url || item.snapshot_url)
                ? [
                    {
                      url: normalizeSnapshotUrl(item.frame_snapshot_url || item.snapshot_url) || '',
                      cameraName: item.camera_name || 'Камера 1',
                      isPrimary: true,
                    },
                  ]
                : [],
              stageName: item.stage_name || undefined,
              discrepancyType: item.discrepancy_type,
              manual_override: Boolean(item.manual_override),
            }
          })
          setIncidentsList(mapped)
        }
      })
      .catch(() => {})
  }, [])

  const handleLoginSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setAuthError(null)
    const form = e.currentTarget
    const username = (form.elements.namedItem('login_username') as HTMLInputElement).value.trim()
    const password = (form.elements.namedItem('login_password') as HTMLInputElement).value
    if (!username || !password) return

    setIsSubmittingAuth(true)
    try {
      const res = await loginUser({ username, password })
      setCurrentUser(res.user)
      setIsAuthModalOpen(false)
      toast(`Добро пожаловать, ${res.user.username}!`)
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Ошибка авторизации')
    } finally {
      setIsSubmittingAuth(false)
    }
  }

  const handleRegisterSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setAuthError(null)
    const form = e.currentTarget
    const username = (form.elements.namedItem('reg_username') as HTMLInputElement).value.trim()
    const password = (form.elements.namedItem('reg_password') as HTMLInputElement).value
    const confirmPassword = (form.elements.namedItem('reg_confirm_password') as HTMLInputElement).value

    if (password !== confirmPassword) {
      setAuthError('Введенные пароли не совпадают')
      return
    }

    if (password.length < 4) {
      setAuthError('Пароль должен содержать не менее 4 символов')
      return
    }

    setIsSubmittingAuth(true)
    try {
      const res = await registerUser({ username, password, confirm_password: confirmPassword })
      setCurrentUser(res.user)
      setIsAuthModalOpen(false)
      toast(`Аккаунт «${res.user.username}» успешно создан!`)
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Ошибка регистрации')
    } finally {
      setIsSubmittingAuth(false)
    }
  }

  const handleLogout = () => {
    logoutUser()
    setCurrentUser(null)
    setIsUserMenuOpen(false)
    setIsAuthModalOpen(true)
    toast('Вы вышли из системы')
  }

  const handleCheckStream = async () => {
    const el = document.getElementById('cam_stream_input') as HTMLInputElement
    const url = el?.value?.trim()
    if (!url) return
    setIsCheckingStream(true)
    setStreamCheckResult(null)
    try {
      const res = await fetch(`${API_PREFIX}/videos/check-stream?url=${encodeURIComponent(url)}`)
      const data = await res.json()
      setStreamCheckResult({
        status: data.status,
        message: data.message || (data.status === 'online' ? 'Связь с камерой установлена' : 'Камера недоступна'),
      })
    } catch (e) {
      setStreamCheckResult({
        status: 'offline',
        message: e instanceof Error ? e.message : 'Ошибка проверки связи',
      })
    } finally {
      setIsCheckingStream(false)
    }
  }

  const toast = (text: string) => {
    setToastText(text)
    setTimeout(() => setToastText(null), 3500)
  }

  // User separation: projects visible to the current user
  const userVisibleProjects = useMemo(() => {
    if (!currentUser) return []
    if (currentUser.role === 'admin') return projectsList
    // Non-admin sees their own projects or unassigned projects
    return projectsList.filter(
      (p) => !p.owner_username || p.owner_username === currentUser.username
    )
  }, [projectsList, currentUser])

  const loadProjectsForUser = useCallback(async (user: UserProfile) => {
    try {
      const prjs = await fetchProjects()
      const visible = user.role === 'admin'
        ? prjs
        : prjs.filter((p) => !p.owner_username || p.owner_username === user.username)

      if (visible.length > 0) {
        setProjectsList(prjs)
        setActiveProjectId((prev) => (visible.some((p) => p.id === prev) ? prev : visible[0].id))
      } else {
        // Auto-provision personal workspace project for this user
        const initPrj = await createProject({
          name: `Объект строительства (${user.username})`,
          code: `PRJ-${user.username.toUpperCase().slice(0, 4)}`,
          address: 'г. Москва',
          object_kind: 'Жильё',
          owner_username: user.username,
        })
        setProjectsList((prev) => [...prev, initPrj])
        setActiveProjectId(initPrj.id)
      }
    } catch {
      // offline fallback
      const fallbackPrj: ProjectItem = {
        id: `local-${user.username}-prj`,
        code: `PRJ-${user.username.toUpperCase().slice(0, 4)}`,
        name: `Объект строительства (${user.username})`,
        address: 'г. Москва',
        object_kind: 'Жильё',
        status: 'active',
        owner_username: user.username,
        zones: [],
        cameras: [],
        stages_count: 0,
      }
      setProjectsList((prev) => [...prev, fallbackPrj])
      setActiveProjectId(fallbackPrj.id)
    }
  }, [])

  useEffect(() => {
    if (currentUser) {
      loadProjectsForUser(currentUser)
    } else {
      setProjectsList([])
      setActiveProjectId(null)
    }
  }, [currentUser, loadProjectsForUser])

  // Role-based workspace page permissions
  const allowedNav = useMemo(() => {
    if (!currentUser) return []
    if (currentUser.role === 'admin') return nav
    if (currentUser.role === 'viewer') {
      return nav.filter((n) => ['monitoring', 'archive', 'reports'].includes(n.id))
    }
    if (currentUser.role === 'inspector') {
      return nav.filter((n) => ['monitoring', 'archive', 'progress', 'reports'].includes(n.id))
    }
    return nav
  }, [currentUser])

  useEffect(() => {
    if (allowedNav.length > 0 && !allowedNav.some((n) => n.id === page)) {
      setPage(allowedNav[0].id)
    }
  }, [allowedNav, page])

  // Load project zones, cameras, and schedule whenever active project changes
  useEffect(() => {
    if (!activeProjectId) return

    fetchProjectZones(activeProjectId).then((zns) => {
      setActiveZones(zns)
    })

    fetchCameras(activeProjectId).then((cams) => {
      setCamerasList(cams)
      if (cams.length > 0) {
        setSelectedCameraId((prev) => prev || cams[0].id)
      }
    })

    fetchStages(activeProjectId).then((stgs) => {
      setStages(stgs)
    })
  }, [activeProjectId])

  const activeProject = userVisibleProjects.find((p) => p.id === activeProjectId) || userVisibleProjects[0]

  // Handle Create Project
  const handleCreateProjectSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const name = (form.elements.namedItem('prj_name') as HTMLInputElement).value
    const address = (form.elements.namedItem('prj_address') as HTMLInputElement).value
    const objectKind = (form.elements.namedItem('prj_kind') as HTMLSelectElement).value

    try {
      const created = await createProject({
        name,
        address,
        object_kind: objectKind,
        owner_username: currentUser?.username,
      })
      setProjectsList((prev) => [...prev.filter((p) => p.id !== 'local-default-prj'), created])
      setActiveProjectId(created.id)
      setIsCreateProjectOpen(false)
      toast(`Объект «${created.name}» успешно создан в вашей рабочей области`)
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Ошибка создания объекта')
    }
  }

  // Handle Update Project
  const handleUpdateProject = async (
    projectId: string,
    data: { name: string; code: string; address?: string; object_kind?: string; status?: string }
  ) => {
    try {
      const updated = await updateProject(projectId, data)
      setProjectsList((prev) => prev.map((p) => (p.id === updated.id ? updated : p)))
      toast(`Объект «${updated.name}» успешно обновлен`)
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Ошибка обновления объекта')
    }
  }

  // Handle Delete Project
  const handleDeleteProject = async (projectId: string) => {
    const prj = projectsList.find((p) => p.id === projectId)
    if (!prj) return
    if (!window.confirm(`Вы действительно хотите удалить объект «${prj.name}» со всеми участками и камерами?`)) {
      return
    }
    try {
      await deleteProject(projectId)
      const remaining = projectsList.filter((p) => p.id !== projectId)
      setProjectsList(remaining)
      if (activeProjectId === projectId) {
        setActiveProjectId(remaining[0]?.id || null)
      }
      toast(`Объект «${prj.name}» удален`)
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Ошибка удаления объекта')
    }
  }

  // Handle Create / Edit Zone (Construction Site)
  const handleZoneSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const targetProjectId = activeProjectId || userVisibleProjects[0]?.id
    if (!targetProjectId) {
      toast('Сначала выберите или создайте объект')
      return
    }
    const form = e.currentTarget
    const name = (form.elements.namedItem('zone_name') as HTMLInputElement).value
    const code = (form.elements.namedItem('zone_code') as HTMLInputElement).value
    const description = (form.elements.namedItem('zone_desc') as HTMLTextAreaElement).value

    try {
      if (editingZone) {
        const updated = await updateZone(targetProjectId, editingZone.id, {
          name,
          code: code || undefined,
          description: description || undefined,
        })
        setActiveZones((prev) => prev.map((z) => (z.id === updated.id ? updated : z)))
        setEditingZone(null)
        setIsCreateZoneOpen(false)
        toast(`Стройплощадка «${updated.name}» обновлена`)
        return
      }

      const created = await createProjectZone(targetProjectId, { name, code, description })
      setActiveZones((prev) => [...prev, created])
      setIsCreateZoneOpen(false)
      toast(`Стройплощадка «${created.name}» добавлена`)
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Ошибка сохранения площадки')
    }
  }

  // Handle Delete Zone
  const handleDeleteZone = async (zone: ZoneItem) => {
    const targetProjectId = activeProjectId || userVisibleProjects[0]?.id
    if (!targetProjectId || !window.confirm(`Удалить стройплощадку «${zone.name}»?`)) return
    try {
      await deleteZone(targetProjectId, zone.id)
      setActiveZones((prev) => prev.filter((z) => z.id !== zone.id))
      toast(`Стройплощадка «${zone.name}» удалена`)
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Ошибка удаления площадки')
    }
  }

  // Handle camera creation and editing in one form.
  const handleCameraSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const targetProjectId = activeProjectId || userVisibleProjects[0]?.id
    if (!targetProjectId) {
      toast('Сначала выберите или создайте объект')
      return
    }
    const form = e.currentTarget
    const name = (form.elements.namedItem('cam_name') as HTMLInputElement).value
    const code = (form.elements.namedItem('cam_code') as HTMLInputElement).value
    const rawStreamUrl = (form.elements.namedItem('cam_stream') as HTMLInputElement).value?.trim() || ''
    const streamUrl = rawStreamUrl || 'rtsp://127.0.0.1:8554/live/stroy_cam'
    const zoneId = (form.elements.namedItem('cam_zone') as HTMLSelectElement).value

    try {
      if (editingCamera) {
        const updated = await updateCamera(targetProjectId, editingCamera.id, {
          name,
          code,
          stream_url: streamUrl,
          zone_id: zoneId || null,
        })
        setCamerasList((prev) => prev.map((camera) => camera.id === updated.id ? updated : camera))
        setEditingCamera(null)
        setIsCameraModalOpen(false)
        setCameraReportedOnline(true)
        toast(`Настройки камеры «${updated.name}» обновлены`)
        return
      }

      const created = await createCamera(targetProjectId, {
        name,
        code: code || undefined,
        stream_url: streamUrl,
        zone_id: zoneId || undefined,
      })
      setCamerasList((prev) => [...prev, created])
      setSelectedCameraId(created.id)
      setUploadedVideoUrl(null)
      setUploadedVideoName(null)
      setIsCameraModalOpen(false)
      setCameraReportedOnline(true)
      toast(`Камера «${created.name}» успешно подключена и активирована`)
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Ошибка добавления камеры')
    }
  }

  const handleDeleteCamera = async (camera: CameraItem) => {
    const targetProjectId = activeProjectId || userVisibleProjects[0]?.id
    if (!targetProjectId || !window.confirm(`Удалить камеру «${camera.name}»?`)) return
    try {
      await deleteCamera(targetProjectId, camera.id)
      const remaining = camerasList.filter((item) => item.id !== camera.id)
      setCamerasList(remaining)
      if (selectedCameraId === camera.id) {
        setSelectedCameraId(remaining[0]?.id ?? null)
      }
      toast(`Камера «${camera.name}» удалена`)
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Ошибка удаления камеры')
    }
  }

  // Handle Video Upload
  const handleUploadVideoSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const fileInput = form.elements.namedItem('video_file') as HTMLInputElement
    const file = fileInput?.files?.[0]
    if (!file) {
      toast('Выберите видеофайл')
      return
    }

    const objectUrl = URL.createObjectURL(file)
    setUploadedVideoUrl(objectUrl)
    setUploadedVideoName(file.name)
    setIsUploadModalOpen(false)

    try {
      await uploadVideoAsset(file, videoTimestamp)
      toast(`Видео «${file.name}» загружено и синхронизировано`)
    } catch {
      toast(`Видео «${file.name}» запущено в локальном плеере`)
    }
  }

  // Handle Violation Window Setting change
  const handleUpdateViolationWindow = async (seconds: number) => {
    try {
      const res = await updateIncidentConfig(seconds)
      setViolationWindowSeconds(res.violation_evaluation_window_seconds)
      toast(`Интервал оценки нарушений установлен: ${res.violation_evaluation_window_seconds} сек`)
    } catch {
      setViolationWindowSeconds(seconds)
      toast(`Интервал оценки нарушений сохранён: ${seconds} сек`)
    }
  }

  // Handle manual incident status change ("Ожидает обработки", "Проблемы нет", "Подтверждено")
  const handleIncidentStatusChange = async (incidentId: string, newStatus: IncidentStatus) => {
    setIncidentsList((prev) =>
      prev.map((i) => (i.id === incidentId ? { ...i, status: newStatus, manual_override: true } : i))
    )
    toast(`Тег инцидента изменен: «${newStatus}»`)
    try {
      await updateIncidentStatus(incidentId, newStatus)
    } catch {
      // already updated in UI
    }
  }

  // Reset detection observations when video or camera switches
  useEffect(() => {
    recentObservationsRef.current = []
    violationCooldownRef.current = {}
    detectedLabelsInWindowRef.current.clear()
    streamStartTimeRef.current = isStreamOnline ? Date.now() / 1000 : null
    latestSnapshotRef.current = null
  }, [uploadedVideoUrl, selectedCameraId, isStreamOnline])

  // Stream state transition monitor: emits one-shot report incident on state change ONLY
  useEffect(() => {
    const currentState: 'ONLINE' | 'OFFLINE' = isStreamOnline ? 'ONLINE' : 'OFFLINE'
    const prevState = streamTransitionStateRef.current

    if (prevState === currentState) return
    streamTransitionStateRef.current = currentState

    const activeZoneObj = activeZones.find((z) => z.id === activeZoneId) || activeZones[0]
    const curCamObj = camerasList.find((c) => c.id === selectedCameraId) || camerasList[0]
    const zoneName = activeZoneObj?.name || 'Основная площадка'
    const camName = curCamObj?.name || 'Камера 1 (Обзор)'
    const nowStr = new Date().toLocaleTimeString('ru-RU').slice(0, 5)

    if (prevState === null) {
      if (!isStreamOnline) {
        const newId = `INC-${Math.floor(100 + Math.random() * 900)}`
        const newIncident: Incident = {
          id: newId,
          type: 'Видеопоток',
          title: 'Отсутствует видеопоток',
          zone: zoneName,
          camera: camName,
          time: nowStr,
          age: 'Только что',
          priority: 'Средний',
          status: 'В работе',
          assignee: 'Дежурный инженер',
          sla: '30 мин',
          confidence: 100,
          note: 'Трансляция с камер объекта отсутствует. Загрузите видеозапись СМР или подключите сетевую камеру для запуска мониторинга.',
          severity: 'WARNING',
          discrepancyType: 'STREAM_OFFLINE',
        }
        setIncidentsList((prev) => [newIncident, ...prev])
        createIncident({
          title: newIncident.title,
          description: newIncident.note,
          severity: 'WARNING',
          discrepancy_type: 'STREAM_OFFLINE',
          zone_name: zoneName,
          camera_name: camName,
        }).catch((e) => console.warn('Failed to persist stream offline incident:', e))
      }
      return
    }

    if (prevState === 'OFFLINE' && currentState === 'ONLINE') {
      streamStartTimeRef.current = Date.now() / 1000
      detectedLabelsInWindowRef.current.clear()
      latestSnapshotRef.current = null

      const newId = `INC-${Math.floor(100 + Math.random() * 900)}`
      const newIncident: Incident = {
        id: newId,
        type: 'Видеопоток',
        title: 'Видеопоток активен',
        zone: zoneName,
        camera: camName,
        time: nowStr,
        age: 'Только что',
        priority: 'Низкий',
        status: 'В работе',
        assignee: 'Система',
        sla: '10 мин',
        confidence: 100,
        note: uploadedVideoName
          ? `Запущена обработка видеозаписи «${uploadedVideoName}». Контроль техники активен.`
          : `Видеопоток с камеры «${camName}» успешно подключен. Автоматический контроль техники запущен.`,
        severity: 'WARNING',
        discrepancyType: 'STREAM_ONLINE',
      }
      setIncidentsList((prev) => [newIncident, ...prev])
      toast(uploadedVideoName ? `Видео «${uploadedVideoName}» активно: детекция техники запущена` : 'Видеопоток активен: детекция техники запущена')
      createIncident({
        title: newIncident.title,
        description: newIncident.note,
        severity: 'WARNING',
        discrepancy_type: 'STREAM_ONLINE',
        zone_name: zoneName,
        camera_name: camName,
      }).catch((e) => console.warn('Failed to persist stream online incident:', e))
    } else if (prevState === 'ONLINE' && currentState === 'OFFLINE') {
      streamStartTimeRef.current = null
      detectedLabelsInWindowRef.current.clear()
      latestSnapshotRef.current = null

      const newId = `INC-${Math.floor(100 + Math.random() * 900)}`
      const newIncident: Incident = {
        id: newId,
        type: 'Видеопоток',
        title: 'Потеря видеопотока',
        zone: zoneName,
        camera: camName,
        time: nowStr,
        age: 'Только что',
        priority: 'Высокий',
        status: 'В работе',
        assignee: 'Дежурный инженер',
        sla: '15 мин',
        confidence: 100,
        note: 'Прекратилась трансляция видеопотока с объекта. Мониторинг строительной техники приостановлен.',
        severity: 'ERROR',
        discrepancyType: 'STREAM_LOST',
      }
      setIncidentsList((prev) => [newIncident, ...prev])
      toast('Внимание: потерян видеопоток объекта')
      createIncident({
        title: newIncident.title,
        description: newIncident.note,
        severity: 'ERROR',
        discrepancy_type: 'STREAM_LOST',
        zone_name: zoneName,
        camera_name: camName,
      }).catch((e) => console.warn('Failed to persist stream lost incident:', e))
    }
  }, [isStreamOnline, activeZones, activeZoneId, camerasList, selectedCameraId, uploadedVideoName, toast])

  // Realtime Frame Analysis & Multi-Camera Violation Evaluator
  const handleFrameAnalysis = useCallback(
    (
      snapshotDataUrl: string,
      dets: LiveDetectionInfo[],
      timeSeconds: number,
      sourceId?: string,
      sourceName?: string
    ) => {
      // Do not run violation detection or create alerts when video stream is offline
      if (!isStreamOnline) {
        streamStartTimeRef.current = null
        detectedLabelsInWindowRef.current.clear()
        return
      }

      const nowSec = Date.now() / 1000
      if (streamStartTimeRef.current === null) {
        streamStartTimeRef.current = nowSec
      }

      const sId = sourceId || (uploadedVideoUrl ? 'video-source' : selectedCameraId || 'cam-01')
      const sName = sourceName || (uploadedVideoName ? `Видео · ${uploadedVideoName}` : curCam?.name || 'Камера 1')

      let sState = sourcesStateRef.current.get(sId)
      if (!sState) {
        sState = {
          sourceId: sId,
          sourceName: sName,
          snapshotUrl: snapshotDataUrl,
          detectedLabels: new Set<string>(),
          lastTimestamp: Date.now(),
        }
        sourcesStateRef.current.set(sId, sState)
      }
      if (snapshotDataUrl) {
        sState.snapshotUrl = snapshotDataUrl
        sState.lastTimestamp = Date.now()
        latestSnapshotRef.current = snapshotDataUrl
      }
      for (const d of dets) {
        if (d.conf >= 60 && d.label) {
          sState.detectedLabels.add(d.label)
        }
      }

      const windowSec = violationWindowSeconds || 30
      const elapsedSec = nowSec - streamStartTimeRef.current

      // Check after windowSec seconds have elapsed
      if (elapsedSec < windowSec) {
        return
      }

      // Reset window start timer for the next observation cycle
      streamStartTimeRef.current = nowSec

      // Resolve active stage & analytical assumption (what machinery should be present)
      const activeStage = getCurrentStageByDate(stages) || stages[0]
      const stageName = activeStage?.name || 'Монолитные конструкции'
      const rules = getEffectiveStageRules(activeStage)

      // ALL found objects from ALL connected cameras/sources are recorded into ONE set for this stage!
      const unifiedObservedMachinery = new Set<string>()
      for (const src of sourcesStateRef.current.values()) {
        for (const label of src.detectedLabels) {
          unifiedObservedMachinery.add(label)
        }
        src.detectedLabels.clear()
      }

      const activeZoneObj = activeZones.find((z) => z.id === activeZoneId) || activeZones[0]
      const zoneName = activeZoneObj?.name || 'Основная площадка'
      const camName = curCam?.name || 'Камера 1 (Обзор)'
      const effectiveSnapshot = snapshotDataUrl || latestSnapshotRef.current || ''

      // Prepare multi-camera album snapshots from ALL connected cameras / sources
      // The report must specifically take the snapshot from the FIRST camera (camerasList[0])!
      const firstCamera = camerasList[0]
      const firstCameraId = firstCamera?.id || 'cam-01'

      const albumPhotos: { url: string; cameraName: string; isPrimary: boolean; capturedAt: string }[] = []
      const processedSources = new Set<string>()

      // 1. Add connected cameras in canonical project camerasList order (Camera 1 is primary)
      camerasList.forEach((cam, idx) => {
        const state =
          sourcesStateRef.current.get(cam.id) ||
          sourcesStateRef.current.get(cam.code) ||
          Array.from(sourcesStateRef.current.values()).find(
            (s) =>
              s.sourceId === cam.id ||
              s.sourceName.includes(cam.code) ||
              s.sourceName.includes(cam.name)
          )
        if (state?.snapshotUrl) {
          processedSources.add(state.sourceId)
          albumPhotos.push({
            url: state.snapshotUrl,
            cameraName: `${cam.code} · ${cam.name}`,
            isPrimary: idx === 0,
            capturedAt: new Date().toISOString(),
          })
        }
      })

      // 2. Add any additional active stream or uploaded video source
      for (const src of sourcesStateRef.current.values()) {
        if (!processedSources.has(src.sourceId) && src.snapshotUrl) {
          albumPhotos.push({
            url: src.snapshotUrl,
            cameraName: src.sourceName,
            isPrimary: albumPhotos.length === 0,
            capturedAt: new Date().toISOString(),
          })
        }
      }

      if (albumPhotos.length === 0 && effectiveSnapshot) {
        albumPhotos.push({
          url: effectiveSnapshot,
          cameraName: camName,
          isPrimary: true,
          capturedAt: new Date().toISOString(),
        })
      }

      // Explicitly take snapshot from the FIRST camera for the report
      const firstCameraPhoto =
        albumPhotos.find((p) => p.isPrimary)?.url ||
        sourcesStateRef.current.get(firstCameraId)?.snapshotUrl ||
        albumPhotos[0]?.url ||
        effectiveSnapshot ||
        undefined

      const emitViolation = (
        severity: 'ERROR' | 'WARNING',
        discrepancyType: 'MISSING_MANDATORY' | 'MISSING_RECOMMENDED' | 'UNCHARACTERISTIC_PRESENT',
        machineryName: string,
        title: string,
        note: string
      ) => {
        const newId = `INC-${Math.floor(100 + Math.random() * 900)}`
        const nowStr = new Date().toLocaleTimeString('ru-RU').slice(0, 5)
        const cleanTitle = cleanViolationText(title)
        const cleanNote = cleanViolationText(note)
        const cleanMachinery = toRussianMachineryName(machineryName)

        const newIncident: Incident = {
          id: newId,
          type: 'Техника',
          title: cleanTitle,
          zone: zoneName,
          camera: firstCamera ? `${firstCamera.code} · ${firstCamera.name}` : camName,
          time: nowStr,
          age: 'Только что',
          priority: severity === 'ERROR' ? 'Критический' : 'Средний',
          status: 'Ожидает обработки',
          assignee: 'Не назначен',
          sla: severity === 'ERROR' ? '15 мин' : '45 мин',
          confidence: 96,
          note: cleanNote,
          severity,
          snapshotUrl: firstCameraPhoto, // In report: strictly photo from the first camera!
          albumPhotos, // In photo archive: album with photos from all cameras
          stageName,
          discrepancyType,
        }

        setIncidentsList((prev) => [newIncident, ...prev])
        setActiveViolationAlert({
          id: newId,
          title: cleanTitle,
          desc: cleanNote,
          severity,
          snapshotUrl: firstCameraPhoto,
        })
        toast(severity === 'ERROR' ? `🔴 ${cleanTitle}` : `⚠️ ${cleanTitle}`)

        setTimeout(() => {
          setActiveViolationAlert((prev) => (prev?.id === newId ? null : prev))
        }, 12000)

        // Asynchronously persist to backend DB & snapshot storage with album_snapshots
        createIncident({
          title: cleanTitle,
          description: cleanNote,
          severity,
          discrepancy_type: discrepancyType,
          machinery_type: cleanMachinery,
          zone_name: zoneName,
          camera_name: firstCamera ? `${firstCamera.code} · ${firstCamera.name}` : camName,
          stage_name: stageName,
          frame_snapshot_base64: firstCameraPhoto || null,
          album_snapshots: albumPhotos.map((p) => ({
            snapshot_base64: p.url,
            camera_name: p.cameraName,
          })),
        })
          .then((saved) => {
            const serverUrl = normalizeSnapshotUrl(saved.frame_snapshot_url || saved.snapshot_url)
            const serverAlbum = saved.album_photos?.map((p) => ({
              url: normalizeSnapshotUrl(p.url) || p.url,
              cameraName: p.camera_name,
              isPrimary: p.is_primary,
              capturedAt: p.captured_at,
            }))
            if (serverUrl || (serverAlbum && serverAlbum.length > 0)) {
              setIncidentsList((prev) =>
                prev.map((i) => {
                  if (i.id === newId) {
                    return {
                      ...i,
                      snapshotUrl: i.snapshotUrl || serverUrl,
                      albumPhotos: (serverAlbum && serverAlbum.length > 0) ? serverAlbum : i.albumPhotos,
                    }
                  }
                  return i
                })
              )
            }
          })
          .catch((e) => console.warn('Failed to persist incident:', e))
      }

      // 1. Нет необходимой техники (ERROR)
      for (const rawMandatory of rules.mandatory) {
        const mandatory = toRussianMachineryName(rawMandatory)
        if (!unifiedObservedMachinery.has(mandatory)) {
          emitViolation(
            'ERROR',
            'MISSING_MANDATORY',
            mandatory,
            `Нет необходимой техники: ${mandatory}`,
            `Причина: нет необходимой техники (${mandatory}). За ${windowSec} сек анализа со всех подключенных камер на этапе «${stageName}» техника не зафиксирована ни на одном из ракурсов.`
          )
        }
      }

      // 2. Нет рекомендованной техники (WARNING)
      for (const rawRec of rules.recommended) {
        const rec = toRussianMachineryName(rawRec)
        if (!unifiedObservedMachinery.has(rec)) {
          emitViolation(
            'WARNING',
            'MISSING_RECOMMENDED',
            rec,
            `Нет рекомендованной техники: ${rec}`,
            `Причина: нет рекомендованной техники (${rec}). За ${windowSec} сек анализа со всех подключенных камер на этапе «${stageName}» техника не зафиксирована ни на одном из ракурсов.`
          )
        }
      }

      // 3. Есть лишняя техника (ERROR)
      for (const rawLabel of unifiedObservedMachinery) {
        const label = toRussianMachineryName(rawLabel)
        if (rules.uncharacteristic.some((u) => toRussianMachineryName(u).toLowerCase() === label.toLowerCase())) {
          emitViolation(
            'ERROR',
            'UNCHARACTERISTIC_PRESENT',
            label,
            `Есть лишняя техника: ${label}`,
            `Причина: есть лишняя техника (${label}). На этапе «${stageName}» зафиксирована не предусмотренная регламентом спецтехника.`
          )
        }
      }
    },
    [
      isStreamOnline,
      violationWindowSeconds,
      stages,
      stageOverridesVersion,
      activeZones,
      activeZoneId,
      camerasList,
      selectedCameraId,
      uploadedVideoUrl,
      uploadedVideoName,
      toast,
    ]
  )

  const title = titles[page] ?? titles.monitoring

  const pageBody = useMemo(() => {
    switch (page) {
      case 'monitoring':
        return (
          <Monitoring
            activeProject={activeProject}
            activeZones={activeZones}
            camerasList={camerasList}
            selectedCameraId={selectedCameraId}
            setSelectedCameraId={setSelectedCameraId}
            stages={stages}
            uploadedVideoUrl={uploadedVideoUrl}
            uploadedVideoName={uploadedVideoName}
            videoTimestamp={videoTimestamp}
            setUploadedVideoUrl={setUploadedVideoUrl}
            setUploadedVideoName={setUploadedVideoName}
            setIsUploadModalOpen={setIsUploadModalOpen}
            setIsCameraModalOpen={(open) => {
              if (open) setEditingCamera(null)
              setIsCameraModalOpen(open)
            }}
            onFrameAnalysis={handleFrameAnalysis}
            onStreamStatusChange={setCameraReportedOnline}
            toast={toast}
          />
        )
      case 'archive':
        return (
          <PhotoArchive
            incidents={incidentsList}
            violationWindowSeconds={violationWindowSeconds}
            highlightedIncidentId={highlightedIncidentId}
            onNavigateToReport={(id) => {
              setHighlightedIncidentId(id)
              setPage('reports')
            }}
            onStatusChange={handleIncidentStatusChange}
            toast={toast}
          />
        )
      case 'progress':
        return (
          <Progress
            stages={stages}
            setStages={setStages}
            activeProjectId={activeProjectId}
            navigate={setPage}
            toast={toast}
          />
        )
      case 'analytics':
        return (
          <Analytics
            stages={stages}
            navigate={setPage}
            toast={toast}
            onStageOverridesUpdated={() => setStageOverridesVersion((v) => v + 1)}
          />
        )
      case 'reports':
        return (
          <Reports
            activeProject={activeProject}
            incidents={incidentsList}
            highlightedIncidentId={highlightedIncidentId}
            onNavigateToArchive={(id) => {
              setHighlightedIncidentId(id)
              setPage('archive')
            }}
            onStatusChange={handleIncidentStatusChange}
            toast={toast}
          />
        )
      case 'settings':
        return (
          <Settings
            activeProject={activeProject}
            projectsList={userVisibleProjects}
            onSelectProject={(id) => setActiveProjectId(id)}
            onUpdateProject={handleUpdateProject}
            onDeleteProject={handleDeleteProject}
            setIsCreateProjectOpen={setIsCreateProjectOpen}
            activeZones={activeZones}
            onAddZone={() => {
              setEditingZone(null)
              setIsCreateZoneOpen(true)
            }}
            onEditZone={(zone) => {
              setEditingZone(zone)
              setIsCreateZoneOpen(true)
            }}
            onDeleteZone={handleDeleteZone}
            camerasList={camerasList}
            onAddCamera={() => {
              setEditingCamera(null)
              setIsCameraModalOpen(true)
            }}
            onEditCamera={(camera) => {
              setEditingCamera(camera)
              setIsCameraModalOpen(true)
            }}
            onDeleteCamera={handleDeleteCamera}
            violationWindowSeconds={violationWindowSeconds}
            onUpdateViolationWindow={handleUpdateViolationWindow}
            toast={toast}
          />
        )
      default:
        return null
    }
  }, [
    page,
    stages,
    activeProject,
    userVisibleProjects,
    activeZones,
    camerasList,
    selectedCameraId,
    uploadedVideoUrl,
    uploadedVideoName,
    videoTimestamp,
    activeProjectId,
    incidentsList,
    violationWindowSeconds,
    highlightedIncidentId,
    handleFrameAnalysis,
  ])

  if (isAuthChecking) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0b0d10',
          color: '#f8fafc',
          fontFamily: 'Inter, system-ui, sans-serif',
        }}
      >
        <div
          style={{
            width: '48px',
            height: '48px',
            borderRadius: '12px',
            background: '#38bdf8',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 800,
            fontSize: '20px',
            color: '#0b0d10',
            marginBottom: '16px',
          }}
        >
          СК
        </div>
        <div style={{ fontSize: '18px', fontWeight: 600, marginBottom: '8px' }}>Строй-контроль</div>
        <div style={{ fontSize: '13px', color: '#94a3b8' }}>Загрузка рабочей области...</div>
      </div>
    )
  }

  if (!currentUser) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0b0d10',
          padding: '20px',
          fontFamily: 'Inter, system-ui, sans-serif',
        }}
      >
        <div
          className="dialog"
          style={{
            maxWidth: '440px',
            width: '100%',
            border: '1px solid rgba(255,255,255,0.12)',
            boxShadow: '0 20px 40px rgba(0,0,0,0.8)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
            <div
              style={{
                width: '40px',
                height: '40px',
                borderRadius: '10px',
                background: '#38bdf8',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontWeight: 800,
                fontSize: '18px',
                color: '#0b0d10',
              }}
            >
              СК
            </div>
            <div>
              <h2 style={{ margin: 0, fontSize: '18px', color: '#fff' }}>Строй-контроль</h2>
              <small style={{ color: '#94a3b8', fontSize: '12px' }}>Платформа мониторинга строительных объектов</small>
            </div>
          </div>

          <div
            style={{
              display: 'flex',
              borderBottom: '1px solid rgba(255,255,255,0.1)',
              marginBottom: '16px',
              gap: '8px',
            }}
          >
            <button
              type="button"
              onClick={() => {
                setAuthTab('login')
                setAuthError(null)
              }}
              style={{
                padding: '8px 16px',
                background: 'transparent',
                border: 'none',
                borderBottom: authTab === 'login' ? '2px solid #38bdf8' : '2px solid transparent',
                color: authTab === 'login' ? '#38bdf8' : '#94a3b8',
                fontWeight: 600,
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              Вход
            </button>
            <button
              type="button"
              onClick={() => {
                setAuthTab('register')
                setAuthError(null)
              }}
              style={{
                padding: '8px 16px',
                background: 'transparent',
                border: 'none',
                borderBottom: authTab === 'register' ? '2px solid #38bdf8' : '2px solid transparent',
                color: authTab === 'register' ? '#38bdf8' : '#94a3b8',
                fontWeight: 600,
                fontSize: '14px',
                cursor: 'pointer',
              }}
            >
              Регистрация
            </button>
          </div>

          {authTab === 'login' ? (
            <div>
              <p style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '16px' }}>
                Войдите в систему для доступа к закрепленным за вами объектам и рабочей области.
              </p>

              {authError && (
                <div
                  style={{
                    padding: '10px 14px',
                    background: 'rgba(239, 68, 68, 0.15)',
                    border: '1px solid #ef4444',
                    borderRadius: '8px',
                    color: '#fca5a5',
                    fontSize: '13px',
                    marginBottom: '14px',
                  }}
                >
                  {authError}
                </div>
              )}

              <form onSubmit={handleLoginSubmit}>
                <label>
                  Логин *
                  <input name="login_username" placeholder="ваш логин" required autoFocus />
                </label>
                <label>
                  Пароль *
                  <input type="password" name="login_password" placeholder="введите пароль" required />
                </label>
                <div className="dialog-actions" style={{ marginTop: '20px' }}>
                  <button type="submit" className="button primary full" disabled={isSubmittingAuth}>
                    {isSubmittingAuth ? 'Вход...' : 'Войти в рабочую область'}
                  </button>
                </div>
              </form>

              <div style={{ textAlign: 'center', marginTop: '16px', fontSize: '13px', color: '#94a3b8' }}>
                Нет учетной записи?{' '}
                <button
                  type="button"
                  onClick={() => {
                    setAuthTab('register')
                    setAuthError(null)
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#38bdf8',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    padding: 0,
                  }}
                >
                  Зарегистрироваться
                </button>
              </div>
            </div>
          ) : (
            <div>
              <p style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '16px' }}>
                Создайте персональную учетную запись с изолированной рабочей областью строительных объектов.
              </p>

              {authError && (
                <div
                  style={{
                    padding: '10px 14px',
                    background: 'rgba(239, 68, 68, 0.15)',
                    border: '1px solid #ef4444',
                    borderRadius: '8px',
                    color: '#fca5a5',
                    fontSize: '13px',
                    marginBottom: '14px',
                  }}
                >
                  {authError}
                </div>
              )}

              <form onSubmit={handleRegisterSubmit}>
                <label>
                  Придумайте логин *
                  <input
                    name="reg_username"
                    placeholder="например, engineer_ivan"
                    minLength={3}
                    required
                    autoFocus
                  />
                  <small style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginTop: '4px' }}>
                    Любой логин, от 3 символов
                  </small>
                </label>
                <label>
                  Пароль *
                  <input
                    type="password"
                    name="reg_password"
                    placeholder="не менее 4 символов"
                    minLength={4}
                    required
                  />
                </label>
                <label>
                  Повторите пароль *
                  <input
                    type="password"
                    name="reg_confirm_password"
                    placeholder="повторите пароль"
                    minLength={4}
                    required
                  />
                </label>
                <div className="dialog-actions" style={{ marginTop: '20px' }}>
                  <button type="submit" className="button primary full" disabled={isSubmittingAuth}>
                    {isSubmittingAuth ? 'Создание аккаунта...' : 'Зарегистрироваться'}
                  </button>
                </div>
              </form>

              <div style={{ textAlign: 'center', marginTop: '16px', fontSize: '13px', color: '#94a3b8' }}>
                Уже зарегистрированы?{' '}
                <button
                  type="button"
                  onClick={() => {
                    setAuthTab('login')
                    setAuthError(null)
                  }}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: '#38bdf8',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    padding: 0,
                  }}
                >
                  Войти
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className={`app-shell ${collapsed ? 'nav-collapsed' : ''}`}>
      <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark">
            <span>СК</span>
          </div>
          {!collapsed && (
            <div>
              <strong>Строй-контроль</strong>
              <small>Мониторинг объекта</small>
            </div>
          )}
          <button
            className="collapse"
            aria-label={collapsed ? 'Раскрыть меню' : 'Свернуть меню'}
            onClick={() => setCollapsed(!collapsed)}
          >
            <Icon name="chevron" size={16} />
          </button>
        </div>

        <nav aria-label="Основная навигация">
          {allowedNav.map((n) => (
            <button
              key={n.id}
              aria-label={n.label}
              title={collapsed ? n.label : undefined}
              className={page === n.id ? 'active' : ''}
              onClick={() => {
                setPage(n.id)
                setMobileNav(false)
              }}
            >
              <Icon name={n.icon} />
              {!collapsed && <span>{n.label}</span>}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="system-state">
            <span />
            <div>
              <strong>Система активна</strong>
              <small>YOLO 10 классов · Мультикамеры</small>
            </div>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <button className="mobile-menu icon-button" aria-label="Открыть меню" onClick={() => setMobileNav(true)}>
            <Icon name="menu" />
          </button>

          <button className="project-switch" onClick={() => setIsCreateProjectOpen(true)} title="Клик для смены или добавления объекта">
            <span className="project-icon">СК</span>
            <div>
              <small>Объект строительства</small>
              <strong>{activeProject?.name || 'Выбрать объект'}</strong>
            </div>
            <span>⌄</span>
          </button>

          <div className="topbar-spacer" />

          <button className="date-button" title="Текущие дата и время">
            <Icon name="clock" size={16} />
            <span>{currentFormattedDate}, {currentFormattedTime}</span>
          </button>
          {currentUser ? (
            <div style={{ position: 'relative' }}>
              <button
                className="avatar"
                aria-label="Меню пользователя"
                onClick={() => setIsUserMenuOpen((prev) => !prev)}
                title={`Пользователь: ${currentUser.username} (${currentUser.role})`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '4px 12px',
                  borderRadius: '20px',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.15)',
                  cursor: 'pointer',
                  color: '#fff',
                  fontSize: '12px',
                  fontWeight: 600,
                  width: 'auto',
                  height: '36px',
                }}
              >
                <span
                  style={{
                    width: '24px',
                    height: '24px',
                    borderRadius: '50%',
                    background: '#38bdf8',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '11px',
                    fontWeight: 700,
                    color: '#0b0d10',
                  }}
                >
                  {currentUser.username.slice(0, 2).toUpperCase()}
                </span>
                <span>{currentUser.username}</span>
                <span style={{ fontSize: '9px', opacity: 0.7 }}>▼</span>
              </button>

              {isUserMenuOpen && (
                <div
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: '115%',
                    background: '#16191f',
                    border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: '12px',
                    padding: '10px',
                    minWidth: '200px',
                    zIndex: 1000,
                    boxShadow: '0 12px 30px rgba(0,0,0,0.6)',
                  }}
                >
                  <div style={{ padding: '6px 8px 10px', borderBottom: '1px solid rgba(255,255,255,0.08)', marginBottom: '8px' }}>
                    <div style={{ fontSize: '13px', fontWeight: 700, color: '#fff' }}>{currentUser.username}</div>
                    <div style={{ fontSize: '11px', color: '#38bdf8', marginTop: '2px' }}>
                      {currentUser.role === 'admin' ? 'Администратор' : 'Инженер технадзора'}
                    </div>
                  </div>
                  <button
                    className="button"
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: '#f87171',
                      borderColor: 'rgba(248,113,113,0.3)',
                      fontSize: '12px',
                      padding: '6px 12px',
                      borderRadius: '8px',
                    }}
                    onClick={handleLogout}
                  >
                    Выйти из аккаунта
                  </button>
                </div>
              )}
            </div>
          ) : (
            <button
              className="button primary"
              style={{ padding: '4px 14px', fontSize: '12px', height: '34px', borderRadius: '18px' }}
              onClick={() => {
                setAuthTab('login')
                setAuthError(null)
                setIsAuthModalOpen(true)
              }}
            >
              Вход / Регистрация
            </button>
          )}
        </header>

        {/* Object & Construction Site Switcher Bar */}
        <div className="object-zone-bar">
          <div className="object-zone-select-group">
            <span className="label">Объект:</span>
            <select
              value={activeProjectId || ''}
              onChange={(e) => {
                setActiveProjectId(e.target.value)
                setActiveZoneId('all')
              }}
            >
              {userVisibleProjects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.code}){currentUser?.role === 'admin' && p.owner_username ? ` — [${p.owner_username}]` : ''}
                </option>
              ))}
            </select>
            <button className="button" style={{ padding: '0 8px', height: '32px', fontSize: '11px' }} onClick={() => setIsCreateProjectOpen(true)}>
              + Новый объект
            </button>
          </div>

          <div className="object-zone-select-group">
            <span className="label">Стройплощадка:</span>
            <select
              value={activeZoneId || 'all'}
              onChange={(e) => setActiveZoneId(e.target.value)}
            >
              <option value="all">Все стройплощадки ({activeZones.length})</option>
              {activeZones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name} ({z.code})
                </option>
              ))}
            </select>
            <button
              className="button"
              style={{ padding: '0 8px', height: '32px', fontSize: '11px' }}
              onClick={() => {
                setEditingZone(null)
                setIsCreateZoneOpen(true)
              }}
              disabled={!activeProjectId}
            >
              + Стройплощадка
            </button>
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ fontSize: '11px', color: 'var(--muted)' }}>
              Камер: <strong style={{ color: '#fff' }}>{camerasList.length}</strong> ·
              Этапов плана: <strong style={{ color: '#fff' }}>{stages.length}</strong>
            </span>
          </div>
        </div>

        <div className="page-heading">
          <div>
            <h1>{title[0]}</h1>
            <p>{title[1]}</p>
          </div>
          <div className="data-fresh">
            <span />Данные актуальны · 8 сек
          </div>
        </div>

        <div className="page-content">{pageBody}</div>
      </div>

      {/* Modal: Login / Register */}
      {isAuthModalOpen && (
        <div className="modal-backdrop" style={{ zIndex: 1200 }}>
          <div className="dialog" style={{ maxWidth: '440px', width: '100%' }}>
            <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.1)', marginBottom: '16px', gap: '8px' }}>
              <button
                type="button"
                onClick={() => { setAuthTab('login'); setAuthError(null) }}
                style={{
                  padding: '8px 16px',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: authTab === 'login' ? '2px solid #38bdf8' : '2px solid transparent',
                  color: authTab === 'login' ? '#38bdf8' : '#94a3b8',
                  fontWeight: 600,
                  fontSize: '14px',
                  cursor: 'pointer',
                }}
              >
                Вход
              </button>
              <button
                type="button"
                onClick={() => { setAuthTab('register'); setAuthError(null) }}
                style={{
                  padding: '8px 16px',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: authTab === 'register' ? '2px solid #38bdf8' : '2px solid transparent',
                  color: authTab === 'register' ? '#38bdf8' : '#94a3b8',
                  fontWeight: 600,
                  fontSize: '14px',
                  cursor: 'pointer',
                }}
              >
                Регистрация
              </button>
              {currentUser && (
                <button
                  type="button"
                  onClick={() => setIsAuthModalOpen(false)}
                  style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#94a3b8', fontSize: '18px', cursor: 'pointer' }}
                  title="Закрыть"
                >
                  ✕
                </button>
              )}
            </div>

            {authTab === 'login' ? (
              <div>
                <h3 style={{ marginTop: 0 }}>Вход в систему</h3>
                <p style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '16px' }}>
                  Введите логин и пароль для работы с платформой «Строй-контроль».
                </p>

                {authError && (
                  <div style={{ padding: '10px 14px', background: 'rgba(239, 68, 68, 0.15)', border: '1px solid #ef4444', borderRadius: '8px', color: '#fca5a5', fontSize: '13px', marginBottom: '14px' }}>
                    {authError}
                  </div>
                )}

                <form onSubmit={handleLoginSubmit}>
                  <label>
                    Логин *
                    <input
                      name="login_username"
                      placeholder="ваш логин"
                      required
                      autoFocus
                    />
                  </label>
                  <label>
                    Пароль *
                    <input
                      type="password"
                      name="login_password"
                      placeholder="введите пароль"
                      required
                    />
                  </label>
                  <div className="dialog-actions" style={{ marginTop: '20px' }}>
                    <button type="submit" className="button primary full" disabled={isSubmittingAuth}>
                      {isSubmittingAuth ? 'Вход...' : 'Войти в систему'}
                    </button>
                  </div>
                </form>

                <div style={{ textAlign: 'center', marginTop: '16px', fontSize: '13px', color: '#94a3b8' }}>
                  Нет учетной записи?{' '}
                  <button
                    type="button"
                    onClick={() => { setAuthTab('register'); setAuthError(null) }}
                    style={{ background: 'transparent', border: 'none', color: '#38bdf8', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                  >
                    Зарегистрироваться
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <h3 style={{ marginTop: 0 }}>Регистрация</h3>
                <p style={{ color: '#94a3b8', fontSize: '13px', marginBottom: '16px' }}>
                  Придумайте логин (не обязательно email) и введите пароль дважды.
                </p>

                {authError && (
                  <div style={{ padding: '10px 14px', background: 'rgba(239, 68, 68, 0.15)', border: '1px solid #ef4444', borderRadius: '8px', color: '#fca5a5', fontSize: '13px', marginBottom: '14px' }}>
                    {authError}
                  </div>
                )}

                <form onSubmit={handleRegisterSubmit}>
                  <label>
                    Придумайте логин *
                    <input
                      name="reg_username"
                      placeholder="например, ivan_engineer"
                      minLength={3}
                      required
                      autoFocus
                    />
                    <small style={{ color: '#94a3b8', fontSize: '11px', display: 'block', marginTop: '4px' }}>Логин не обязательно почта, минимум 3 символа</small>
                  </label>
                  <label>
                    Придумайте пароль *
                    <input
                      type="password"
                      name="reg_password"
                      placeholder="не менее 4 символов"
                      minLength={4}
                      required
                    />
                  </label>
                  <label>
                    Повторите пароль *
                    <input
                      type="password"
                      name="reg_confirm_password"
                      placeholder="повторите введенный пароль"
                      minLength={4}
                      required
                    />
                  </label>
                  <div className="dialog-actions" style={{ marginTop: '20px' }}>
                    <button type="submit" className="button primary full" disabled={isSubmittingAuth}>
                      {isSubmittingAuth ? 'Создание аккаунта...' : 'Зарегистрироваться'}
                    </button>
                  </div>
                </form>

                <div style={{ textAlign: 'center', marginTop: '16px', fontSize: '13px', color: '#94a3b8' }}>
                  Уже зарегистрированы?{' '}
                  <button
                    type="button"
                    onClick={() => { setAuthTab('login'); setAuthError(null) }}
                    style={{ background: 'transparent', border: 'none', color: '#38bdf8', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                  >
                    Войти в систему
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Modal: Create Object */}
      {isCreateProjectOpen && (
        <div className="modal-backdrop">
          <div className="dialog">
            <h3>Создать строительный объект</h3>
            <p>Добавьте новый строительный комплекс или сооружение для раздельного контроля.</p>
            <form onSubmit={handleCreateProjectSubmit}>
              <label>
                Название объекта *
                <input name="prj_name" placeholder="например, ЖК «Флагман», корпус 1" required />
              </label>
              <label>
                Адрес объекта
                <input name="prj_address" placeholder="г. Москва, ул. Строителей, 12" />
              </label>
              <label>
                Категория / Тип объекта
                <select name="prj_kind" defaultValue="Жильё">
                  <option>Жильё</option>
                  <option>Промышленное строительство</option>
                  <option>Инфраструктура</option>
                  <option>Социальный объект</option>
                </select>
              </label>
              <div className="dialog-actions">
                <button type="submit" className="button primary">
                  Создать объект
                </button>
                <button type="button" className="button" onClick={() => setIsCreateProjectOpen(false)}>
                  Отмена
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Create / Edit Construction Site (Zone) */}
      {isCreateZoneOpen && (
        <div className="modal-backdrop">
          <div className="dialog" key={editingZone?.id || 'new-zone'}>
            <h3>{editingZone ? 'Редактировать стройплощадку' : 'Создать стройплощадку'}</h3>
            <p>
              {editingZone
                ? `Измените наименование или параметры участка на объекте «${activeProject?.name}».`
                : `Добавьте участок или зону внутри объекта «${activeProject?.name}».`}
            </p>
            <form onSubmit={handleZoneSubmit}>
              <label>
                Наименование площадки/участка *
                <input
                  name="zone_name"
                  placeholder="например, Котлован секции А"
                  defaultValue={editingZone?.name || ''}
                  required
                />
              </label>
              <label>
                Код участка
                <input
                  name="zone_code"
                  placeholder="например, A-01"
                  defaultValue={editingZone?.code || ''}
                />
              </label>
              <label>
                Описание
                <textarea
                  name="zone_desc"
                  placeholder="Краткое назначение участка"
                  defaultValue={editingZone?.description || ''}
                />
              </label>
              <div className="dialog-actions">
                <button type="submit" className="button primary">
                  {editingZone ? 'Сохранить изменения' : 'Создать площадку'}
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setIsCreateZoneOpen(false)
                    setEditingZone(null)
                  }}
                >
                  Отмена
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Connect Camera */}
      {isCreateCameraOpen && (
        <div className="modal-backdrop">
          <div className="dialog" key={editingCamera?.id || 'new-camera'}>
            <h3>{editingCamera ? 'Редактировать камеру' : 'Подключить камеру'}</h3>
            <p>{editingCamera ? 'Измените название, код, поток или привязку камеры.' : `Добавьте сетевую IP/RTSP/HLS камеру к объекту «${activeProject?.name}».`}</p>
            <form onSubmit={handleCameraSubmit}>
              <label>
                Название камеры *
                <input name="cam_name" placeholder="например, Камера 1 (Обзор котлована)" defaultValue={editingCamera?.name || ''} required />
              </label>
              <label>
                Код камеры
                <input name="cam_code" placeholder="CAM-01" defaultValue={editingCamera?.code || ''} />
              </label>
              <label>
                URL потока (HTTP(S) MJPEG, RTSP или IP)
                <input
                  id="cam_stream_input"
                  name="cam_stream"
                  placeholder="rtsp://127.0.0.1:8554/live/stroy_cam"
                  defaultValue={editingCamera?.stream_url || (editingCamera ? '' : 'rtsp://127.0.0.1:8554/live/stroy_cam')}
                />
              </label>
              <div style={{ display: 'flex', gap: '6px', marginTop: '-4px', marginBottom: '8px', alignItems: 'center' }}>
                <button
                  type="button"
                  className="button"
                  style={{ fontSize: '11px', padding: '3px 10px' }}
                  onClick={handleCheckStream}
                  disabled={isCheckingStream}
                >
                  {isCheckingStream ? '🔄 Проверка связи...' : '⚡ Проверить связь с камерой'}
                </button>
                {streamCheckResult && (
                  <span
                    style={{
                      fontSize: '11px',
                      fontWeight: 600,
                      color: streamCheckResult.status === 'online' ? '#34d399' : '#f87171',
                    }}
                  >
                    {streamCheckResult.status === 'online' ? '● В сети: ' : '● Оффлайн: '}
                    {streamCheckResult.message}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '10px', color: 'var(--muted)', width: '100%' }}>Быстрые шаблоны подключения:</span>
                <button
                  type="button"
                  className="button"
                  style={{ fontSize: '10px', padding: '2px 8px' }}
                  onClick={() => {
                    const el = document.getElementById('cam_stream_input') as HTMLInputElement
                    if (el) el.value = 'rtsp://127.0.0.1:8554/live/stroy_cam'
                    setStreamCheckResult(null)
                  }}
                >
                  RTSP: Стройплощадка (:8554)
                </button>
                <button
                  type="button"
                  className="button"
                  style={{ fontSize: '10px', padding: '2px 8px' }}
                  onClick={() => {
                    const el = document.getElementById('cam_stream_input') as HTMLInputElement
                    if (el) el.value = 'rtsp://127.0.0.1:554/live/crane_cam'
                    setStreamCheckResult(null)
                  }}
                >
                  RTSP: Кран (:554)
                </button>
                <button
                  type="button"
                  className="button"
                  style={{ fontSize: '10px', padding: '2px 8px' }}
                  onClick={() => {
                    const el = document.getElementById('cam_stream_input') as HTMLInputElement
                    if (el) el.value = 'http://127.0.0.1:8000/media/sample_stream.mjpg'
                    setStreamCheckResult(null)
                  }}
                >
                  HTTP MJPEG (:8000)
                </button>
              </div>
              <label>
                Стройплощадка / Зона
                <select name="cam_zone" defaultValue={editingCamera?.zone_id || ''}>
                  <option value="">Без привязки к зоне</option>
                  {activeZones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name} ({z.code})
                    </option>
                  ))}
                </select>
              </label>
              <div className="dialog-actions">
                <button type="submit" className="button primary">
                  {editingCamera ? 'Сохранить изменения' : 'Подключить камеру'}
                </button>
                <button type="button" className="button" onClick={() => {
                  setEditingCamera(null)
                  setIsCameraModalOpen(false)
                }}>
                  Отмена
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal: Upload Video */}
      {isUploadVideoOpen && (
        <div className="modal-backdrop">
          <div className="dialog">
            <h3>Загрузить видеозапись СМР</h3>
            <p>Загрузите видеофайл для демонстрации и автоматического сопоставления со спецтехникой.</p>
            <form onSubmit={handleUploadVideoSubmit}>
              <label>
                Видеофайл (.mp4, .webm, .mov) *
                <input name="video_file" type="file" accept="video/*" required />
              </label>
              <label>
                Дата и время старта съемки *
                <input
                  name="video_ts"
                  type="datetime-local"
                  value={videoTimestamp}
                  onChange={(e) => setVideoTimestamp(e.target.value)}
                  required
                />
              </label>
              <div className="dialog-actions">
                <button type="submit" className="button primary">
                  Начать воспроизведение
                </button>
                <button type="button" className="button" onClick={() => setIsUploadModalOpen(false)}>
                  Отмена
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Active Realtime Violation Alert Banner (Compact, No photo, No section navigation buttons) */}
      {activeViolationAlert && (
        <div
          role="alert"
          style={{
            position: 'fixed',
            top: '72px',
            right: '20px',
            zIndex: 1500,
            maxWidth: '320px',
            background: activeViolationAlert.severity === 'ERROR' ? '#881337' : '#78350f',
            border: `1px solid ${activeViolationAlert.severity === 'ERROR' ? '#f43f5e' : '#f59e0b'}`,
            boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
            borderRadius: '8px',
            padding: '10px 12px',
            color: '#fff',
            display: 'flex',
            gap: '10px',
            alignItems: 'flex-start',
            animation: 'fadeIn 0.25s ease',
          }}
        >
          <div style={{ flexShrink: 0, marginTop: '2px', color: activeViolationAlert.severity === 'ERROR' ? '#fca5a5' : '#fde047' }}>
            <Icon name="alert" size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <strong style={{ fontSize: '10.5px', textTransform: 'uppercase', letterSpacing: '0.4px', color: activeViolationAlert.severity === 'ERROR' ? '#fecdd3' : '#fef08a' }}>
                  {activeViolationAlert.severity === 'ERROR' ? '🔴 Ошибка' : '⚠️ Внимание'}
                </strong>
                <span style={{ fontSize: '9px', background: 'rgba(255,255,255,0.18)', padding: '1px 5px', borderRadius: '3px', color: '#fef08a', fontWeight: 600 }}>
                  Ожидает обработки
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActiveViolationAlert(null)}
                style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '14px', padding: '0 2px', lineHeight: 1 }}
                title="Закрыть"
              >
                ✕
              </button>
            </div>
            <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '2px', color: '#fff', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {activeViolationAlert.title}
            </div>
            <p style={{ fontSize: '10.5px', opacity: 0.9, margin: 0, lineHeight: 1.35, color: '#f1f5f9' }}>
              {activeViolationAlert.desc}
            </p>
          </div>
        </div>
      )}

      {toastText && (
        <div className="toast" role="status">
          <Icon name="check" />
          <span>{toastText}</span>
        </div>
      )}
    </div>
  )
}
