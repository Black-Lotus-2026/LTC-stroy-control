import { useEffect, useMemo, useState, useRef, useCallback } from 'react'
import {
  archiveResults,
  incidentsSeed,
  mockApi,
  type Incident,
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
  MachineryProbabilityItem,
  detectFrameImage,
  getCurrentStageByDate,
  API_PREFIX,
  UserProfile,
  fetchCurrentUser,
  loginUser,
  registerUser,
  logoutUser,
} from './api/stroyControlApi'

const nav: { id: PageKey; label: string; icon: string }[] = [
  { id: 'monitoring', label: 'Наблюдение', icon: 'video' },
  { id: 'archive', label: 'Видеоархив', icon: 'archive' },
  { id: 'progress', label: 'Прогресс', icon: 'progress' },
  { id: 'analytics', label: 'Аналитика', icon: 'chart' },
  { id: 'reports', label: 'Отчёты', icon: 'file' },
  { id: 'settings', label: 'Настройки', icon: 'settings' },
]

const titles: Record<PageKey, [string, string]> = {
  monitoring: ['Наблюдение', 'Камеры, видеозаписи и детекция строительной техники'],
  archive: ['Видеоархив', 'Поиск событий по камерам и времени'],
  progress: ['Прогресс', 'Календарный график СМР и контроль сроков (Гант)'],
  analytics: ['Аналитика', 'Вероятностные профили спецтехники по этапам СМР'],
  reports: ['Отчёты', 'Проверяемая сводка за смену'],
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

  const effectiveStreamUrl = streamUrl || (videoUrl?.toLowerCase().startsWith('rtsp://') ? videoUrl : null)
  const isRtsp = Boolean(effectiveStreamUrl && effectiveStreamUrl.toLowerCase().startsWith('rtsp://'))
  const isHttpStream = Boolean(effectiveStreamUrl && /^https?:\/\//i.test(effectiveStreamUrl))
  const proxiedStreamUrl = isHttpStream && effectiveStreamUrl
    ? getCameraStreamProxyUrl(effectiveStreamUrl)
    : null
  const isFileVideo = Boolean(videoUrl && !isRtsp && (videoUrl.startsWith('http') || videoUrl.startsWith('blob:') || videoUrl.endsWith('.mp4') || videoUrl.endsWith('.webm') || videoUrl.endsWith('.mov')))

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
    if (detectionInFlightRef.current) return
    try {
      let canvas: HTMLCanvasElement | null = null
      if (isFileVideo && videoRef.current && videoRef.current.readyState >= 2) {
        const video = videoRef.current
        canvas = document.createElement('canvas')
        canvas.width = video.videoWidth || 640
        canvas.height = video.videoHeight || 360
        const ctx = canvas.getContext('2d')
        ctx?.drawImage(video, 0, 0, canvas.width, canvas.height)
      } else if (imgRef.current && imgRef.current.complete) {
        const img = imgRef.current
        canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth || 640
        canvas.height = img.naturalHeight || 360
        const ctx = canvas.getContext('2d')
        ctx?.drawImage(img, 0, 0, canvas.width, canvas.height)
      }

      if (!canvas) return
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
          setRealDetections(mapped)
          onDetectionsUpdate?.(mapped.filter((d) => d.conf >= 60))
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
  }, [activeStageName, currentTime, isFileVideo, onDetectionsUpdate])

  // Periodic / seek trigger when video is playing
  useEffect(() => {
    if (isFileVideo) {
      if (Math.abs(currentTime - lastDetectTimeRef.current) >= 1.8) {
        lastDetectTimeRef.current = currentTime
        triggerDetection()
      }
    } else if (isHttpStream) {
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
  }, [currentTime, isFileVideo, isHttpStream, triggerDetection])

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
        <img
          ref={imgRef}
          src={cameraImage}
          alt="Кадр с камеры: площадка, техника"
          style={{ objectFit: 'contain', background: '#090b0e' }}
          onLoad={() => {
            updateDetectionViewport()
            triggerDetection()
          }}
        />
      )}

      {/* Manual & Auto Frame Detection Trigger Button */}
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
  toast: (s: string) => void
}) {
  const [mode, setMode] = useState('Техника')
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
            />

            <div className="analysis-tabs" role="tablist">
              {['Техника', 'Люди', 'СИЗ', 'Опасные зоны', 'Прогресс'].map((m) => (
                <button
                  role="tab"
                  aria-selected={mode === m}
                  className={mode === m ? 'active' : ''}
                  key={m}
                  onClick={() => setMode(m)}
                >
                  {m}
                </button>
              ))}
            </div>
            <Timeline />
          </section>
        )}

        {/* Detected Objects List (YOLO 10 classes) */}
        {(camerasList.length > 0 || uploadedVideoUrl) && (
          <section className="panel detections">
            <div className="panel-head">
              <div>
                <span className="section-kicker">YOLO ДЕТЕКЦИЯ ТЕХНИКИ В КАДРЕ</span>
                <h2>Распознанная спецтехника ({liveDetections.length} ед.) · {mode}</h2>
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

function Timeline() {
  const [playing, setPlaying] = useState(true)
  return (
    <div className="timeline-panel">
      <div className="timeline-toolbar">
        <button className="icon-button" onClick={() => setPlaying(!playing)} aria-label={playing ? 'Пауза' : 'Воспроизведение'}>
          {playing ? '⏸' : '▶'}
        </button>
        <span className="time-display">Синхронизация с графиком работ</span>
        <div className="timeline-legend">
          <span><i className="mark-work" />Смена</span>
          <span><i className="mark-idle" />Отклонение</span>
        </div>
      </div>
      <div className="timeline-track">
        <div className="track-fill" style={{ width: '68%' }} />
        <button style={{ left: '68%' }} aria-label="Ползунок времени" />
        <span className="event-mark" style={{ left: '22%' }} title="Смена техники" />
        <span className="event-mark warning" style={{ left: '54%' }} title="Простой техники" />
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------------
// 4. Archive Page
// ----------------------------------------------------------------------------
function Archive({
  toast,
}: {
  toast: (s: string) => void
}) {
  const [query, setQuery] = useState('Покажи простои спецтехники дольше 20 минут')
  const [searched, setSearched] = useState(true)

  const search = async () => {
    await mockApi.runArchiveSearch(query)
    setSearched(true)
  }

  return (
    <div className="archive-page">
      <section className="archive-search">
        <span className="eyebrow">ПОИСК ПО ВИДЕОАРХИВУ</span>
        <h1>Найдите событие без ручной перемотки</h1>
        <div className="archive-searchbar">
          <Icon name="search" size={20} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
            aria-label="Запрос для поиска по видео"
          />
          <button className="button primary" onClick={search}>
            Найти
          </button>
        </div>
      </section>

      {searched && (
        <>
          <div className="parsed-filters">
            <span>Применённые фильтры:</span>
            <Status>Техника: спецтехника СМР</Status>
            <Status>Длительность: от 20 минут</Status>
            <Status>Период: 7 дней</Status>
          </div>
          <section className="archive-results panel">
            <div className="panel-head">
              <div>
                <span className="section-kicker">РЕЗУЛЬТАТЫ</span>
                <h2>Найдено {archiveResults.length} фрагмента</h2>
              </div>
            </div>
            <div className="video-results">
              {archiveResults.map((r, idx) => (
                <article key={idx}>
                  <div className="video-preview">
                    <img src={cameraImage} alt="Кадр архива" />
                    <button aria-label="Воспроизвести фрагмент" onClick={() => toast(`Воспроизведение фрагмента ${r.time}`)}>▶</button>
                    <time>{r.duration}</time>
                  </div>
                  <div className="video-copy">
                    <div className="meta-row">
                      <span className="zone-code">{r.zone}</span>
                      <time>{r.time}</time>
                      <Status tone="neutral">Камера {r.camera}</Status>
                    </div>
                    <h3>{r.title}</h3>
                    <p>Нейросеть зафиксировала неподвижность техники. Положение рабочих органов не менялось.</p>
                    <button className="text-button" onClick={() => toast('Событие привязано к отчету')}>
                      Привязать к отчёту
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </>
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
  toast,
}: {
  stages: StageItem[]
  setStages: React.Dispatch<React.SetStateAction<StageItem[]>>
  activeProjectId?: string | null
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
    const currentEnd = new Date(stage.planned_end)
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

  // Calculate timeline bounds
  const startTimes = stages.map((s) => new Date(s.planned_start).getTime()).filter(Boolean)
  const endTimes = stages.map((s) => new Date(s.planned_end).getTime()).filter(Boolean)
  const minTime = startTimes.length > 0 ? Math.min(...startTimes) : Date.now()
  const maxTime = endTimes.length > 0 ? Math.max(...endTimes) : minTime + 30 * 24 * 3600 * 1000
  const totalMs = Math.max(maxTime - minTime, 1)

  // Current stage on reference date (2026-09-24)
  const todayActiveStage = getCurrentStageByDate(stages)

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
            Загрузить демо-план
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
              <button className="button" onClick={handleLoadDemo}>
                Загрузить эталонный демо-план
              </button>
            </div>
          </div>
        ) : (
          <div style={{ marginTop: '16px' }}>
            {/* Gantt Timeline View */}
            <div className="gantt-container" style={{ background: '#171a1e', border: '1px solid #35373c', padding: '14px', overflowX: 'auto', position: 'relative' }}>
              <div style={{ minWidth: '760px', position: 'relative' }}>
                {stages.map((stg) => {
                  const sTime = new Date(stg.planned_start).getTime()
                  const eTime = new Date(stg.planned_end).getTime()
                  const leftPct = Math.max(0, Math.min(100, ((sTime - minTime) / totalMs) * 100))
                  const widthPct = Math.max(3, Math.min(100 - leftPct, ((eTime - sTime) / totalMs) * 100))
                  const isSelected = selectedStageId === stg.id
                  const isTodayActive = todayActiveStage?.id === stg.id

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
                        background: isSelected ? 'rgba(207,157,61,.12)' : isTodayActive ? 'rgba(234,179,8,.06)' : 'transparent',
                        cursor: 'pointer',
                      }}
                    >
                      <div>
                        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px' }}>
                          <strong style={{ fontSize: '11px', color: '#fff' }}>
                            {stg.order_index}. {stg.name}
                          </strong>
                          {isTodayActive && (
                            <span style={{ background: '#cf9d3d', color: '#0b0d10', fontSize: '9px', fontWeight: 800, padding: '1px 5px', borderRadius: '3px' }}>
                              СЕГОДНЯ
                            </span>
                          )}
                        </div>
                        <span style={{ fontSize: '9px', color: 'var(--muted)' }}>
                          {stg.duration_days} дн. ({stg.planned_start.slice(0, 10)} – {stg.planned_end.slice(0, 10)})
                        </span>
                      </div>

                      <div style={{ position: 'relative', height: '24px', background: '#1c1e22', borderRadius: '2px', overflow: 'hidden' }}>
                        <div
                          style={{
                            position: 'absolute',
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                            top: '2px',
                            bottom: '2px',
                            background: isSelected ? '#f59e0b' : isTodayActive ? '#eab308' : '#cf9d3d',
                            border: isTodayActive ? '1px solid #ffffff' : undefined,
                            boxShadow: isTodayActive ? '0 0 8px rgba(234,179,8,0.6)' : undefined,
                            borderRadius: '2px',
                            display: 'flex',
                            alignItems: 'center',
                            padding: '0 6px',
                            fontSize: '9px',
                            color: '#000',
                            fontWeight: 700,
                            overflow: 'hidden',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {stg.duration_days} дн {isTodayActive ? '• Активен' : ''}
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
}: {
  stages: StageItem[]
  navigate: (p: PageKey) => void
  toast?: (s: string) => void
}) {
  const [selectedStageId, setSelectedStageId] = useState<string>('')
  const [probItems, setProbItems] = useState<MachineryProbabilityItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [hasCustomOverride, setHasCustomOverride] = useState(false)

  // Automatically select the active stage on today's date (2026-09-24)
  useEffect(() => {
    if (stages.length > 0 && !selectedStageId) {
      const current = getCurrentStageByDate(stages)
      setSelectedStageId(current ? current.id : stages[0].id)
    }
  }, [stages, selectedStageId])

  useEffect(() => {
    if (!selectedStageId) return
    setIsLoading(true)
    fetchStageProbabilities(selectedStageId)
      .then((res) => {
        setProbItems(res.probabilities || [])
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
      await updateStageProbabilities(selectedStageId, { [machineryCode]: validStatus })
      toast?.(`Статус техники обновлён: «${meta.level}»`)
    } catch {
      toast?.(`Статус обновлён локально`)
    }
  }

  // Reset manual overrides to AI calculation
  const handleResetProbabilities = async () => {
    setIsLoading(true)
    try {
      const res = await resetStageProbabilities(selectedStageId)
      setProbItems(res.probabilities || [])
      setHasCustomOverride(false)
      toast?.('Профиль сброшен к автоматическому расчёту AI/ГЭСН')
    } catch {
      const res = await fetchStageProbabilities(selectedStageId)
      setProbItems(res.probabilities || [])
      setHasCustomOverride(false)
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
                  {hasCustomOverride && (
                    <span style={{ background: '#1e3a8a', color: '#93c5fd', fontSize: '9px', fontWeight: 700, padding: '1px 6px', borderRadius: '3px', border: '1px solid #3b82f6' }}>
                      Ручная настройка
                    </span>
                  )}
                </div>
                <h2>Вероятностное распределение строительной техники (10 классов)</h2>
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
                  onChange={(e) => setSelectedStageId(e.target.value)}
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
                          style={{ width: `${Math.round(item.probability * 100)}%` }}
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
                                ? '#60a5fa'
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
                          <option value="MANDATORY">🟢 Обязательная</option>
                          <option value="RECOMMENDED">🔵 Рекомендованная</option>
                          <option value="NEUTRAL">⚪ Допустимая</option>
                          <option value="UNCHARACTERISTIC">🔴 Не допускается</option>
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
                    return (
                      <g key={idx}>
                        <circle cx={p.x} cy={p.y} r="3.5" fill="#cf9d3d" stroke="#0b0d10" strokeWidth="1" />
                        <text
                          x={lx}
                          y={ly}
                          textAnchor={textAnchor}
                          dominantBaseline="central"
                          fill="#9ca3af"
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
                    <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#60a5fa' }} /> 60-80% Рекомендованная
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
// 7. Reports Page
// ----------------------------------------------------------------------------
function Reports({
  activeProject,
  incidents,
  toast,
}: {
  activeProject?: ProjectItem
  incidents: Incident[]
  toast: (s: string) => void
}) {
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
        <button className="button full" onClick={() => toast('Ссылка на отчёт скопирована')}>
          <Icon name="link" />Копировать ссылку
        </button>
        <button className="button primary full" onClick={() => toast('Отчёт подготовлен к экспорту в PDF')}>
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
              <strong>{incidents.filter((i) => i.status === 'Устранено').length}</strong>
              <span>устранено</span>
            </div>
            <div>
              <strong>{incidents.filter((i) => i.status === 'В работе').length}</strong>
              <span>в работе</span>
            </div>
            <div>
              <strong>{incidents.filter((i) => i.status === 'Требует проверки').length}</strong>
              <span>на проверке</span>
            </div>
            <div>
              <strong>18 мин</strong>
              <span>медиана реакции</span>
            </div>
          </div>
        </section>
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
  toast: (s: string) => void
}) {
  const [activeTab, setActiveTab] = useState<'general' | 'zones' | 'cameras'>('general')

  // Form state for active project
  const [name, setName] = useState(activeProject?.name || '')
  const [code, setCode] = useState(activeProject?.code || '')
  const [address, setAddress] = useState(activeProject?.address || '')
  const [objectKind, setObjectKind] = useState(activeProject?.object_kind || 'Жильё')
  const [isSaving, setIsSaving] = useState(false)

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
export default function App() {
  const [page, setPage] = useState<PageKey>('monitoring')
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const [globalSearch, setGlobalSearch] = useState('')
  const [toastText, setToastText] = useState<string | null>(null)
  const [incidents] = useState<Incident[]>(incidentsSeed)

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

  // Dialogs
  const [isCreateProjectOpen, setIsCreateProjectOpen] = useState(false)
  const [isCreateZoneOpen, setIsCreateZoneOpen] = useState(false)
  const [editingZone, setEditingZone] = useState<ZoneItem | null>(null)
  const [isCreateCameraOpen, setIsCameraModalOpen] = useState(false)
  const [editingCamera, setEditingCamera] = useState<CameraItem | null>(null)
  const [isUploadVideoOpen, setIsUploadModalOpen] = useState(false)
  const [streamCheckResult, setStreamCheckResult] = useState<{ status: string; message: string } | null>(null)
  const [isCheckingStream, setIsCheckingStream] = useState(false)

  // User Authentication State
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null)
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false)
  const [isUserMenuOpen, setIsUserMenuOpen] = useState(false)
  const [authTab, setAuthTab] = useState<'login' | 'register'>('login')
  const [authError, setAuthError] = useState<string | null>(null)
  const [isSubmittingAuth, setIsSubmittingAuth] = useState(false)

  // Check active user session on startup
  useEffect(() => {
    fetchCurrentUser().then((user) => {
      if (user) {
        setCurrentUser(user)
      } else {
        setIsAuthModalOpen(true)
      }
    })
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

  // Load projects on startup
  useEffect(() => {
    fetchProjects().then(async (prjs) => {
      if (prjs.length > 0) {
        setProjectsList(prjs)
        setActiveProjectId((prev) => prev || prjs[0].id)
      } else {
        // Create initial default project if empty
        try {
          const initPrj = await createProject({
            name: 'ЖК «Северный», корпус 2',
            code: 'PRJ-SEV',
            address: 'г. Москва, ул. Полярная, 18',
            object_kind: 'Жильё',
          })
          setProjectsList([initPrj])
          setActiveProjectId(initPrj.id)
        } catch {
          // offline local fallback so controls are never disabled
          const fallbackPrj: ProjectItem = {
            id: 'local-default-prj',
            code: 'PRJ-SEV',
            name: 'ЖК «Северный», корпус 2',
            address: 'г. Москва, ул. Полярная, 18',
            object_kind: 'Жильё',
            status: 'active',
            zones: [],
            cameras: [],
            stages_count: 0,
          }
          setProjectsList([fallbackPrj])
          setActiveProjectId(fallbackPrj.id)
        }
      }
    })
  }, [])

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

  const activeProject = projectsList.find((p) => p.id === activeProjectId) || projectsList[0]

  // Handle Create Project
  const handleCreateProjectSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const name = (form.elements.namedItem('prj_name') as HTMLInputElement).value
    const address = (form.elements.namedItem('prj_address') as HTMLInputElement).value
    const objectKind = (form.elements.namedItem('prj_kind') as HTMLSelectElement).value

    try {
      const created = await createProject({ name, address, object_kind: objectKind })
      setProjectsList((prev) => [...prev.filter((p) => p.id !== 'local-default-prj'), created])
      setActiveProjectId(created.id)
      setIsCreateProjectOpen(false)
      toast(`Объект «${created.name}» успешно создан`)
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
    const targetProjectId = activeProjectId || projectsList[0]?.id
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
    const targetProjectId = activeProjectId || projectsList[0]?.id
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
    const targetProjectId = activeProjectId || projectsList[0]?.id
    if (!targetProjectId) {
      toast('Сначала выберите или создайте объект')
      return
    }
    const form = e.currentTarget
    const name = (form.elements.namedItem('cam_name') as HTMLInputElement).value
    const code = (form.elements.namedItem('cam_code') as HTMLInputElement).value
    const streamUrl = (form.elements.namedItem('cam_stream') as HTMLInputElement).value
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
        toast(`Настройки камеры «${updated.name}» обновлены`)
        return
      }

      const created = await createCamera(targetProjectId, {
        name,
        code: code || undefined,
        stream_url: streamUrl || undefined,
        zone_id: zoneId || undefined,
      })
      setCamerasList((prev) => [...prev, created])
      setSelectedCameraId(created.id)
      setUploadedVideoUrl(null)
      setUploadedVideoName(null)
      setIsCameraModalOpen(false)
      toast(`Камера «${created.name}» успешно подключена и активирована`)
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : 'Ошибка добавления камеры')
    }
  }

  const handleDeleteCamera = async (camera: CameraItem) => {
    const targetProjectId = activeProjectId || projectsList[0]?.id
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
            toast={toast}
          />
        )
      case 'archive':
        return <Archive toast={toast} />
      case 'progress':
        return (
          <Progress
            stages={stages}
            setStages={setStages}
            activeProjectId={activeProjectId}
            toast={toast}
          />
        )
      case 'analytics':
        return <Analytics stages={stages} navigate={setPage} />
      case 'reports':
        return <Reports activeProject={activeProject} incidents={incidents} toast={toast} />
      case 'settings':
        return (
          <Settings
            activeProject={activeProject}
            projectsList={projectsList}
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
            toast={toast}
          />
        )
      default:
        return null
    }
  }, [page, stages, activeProject, projectsList, activeZones, camerasList, selectedCameraId, uploadedVideoUrl, uploadedVideoName, videoTimestamp, activeProjectId])

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
          {nav.map((n) => (
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
              <small>YOLO 10 классов · VLM</small>
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

          <label className="global-search">
            <Icon name="search" size={17} />
            <input
              value={globalSearch}
              onChange={(e) => setGlobalSearch(e.target.value)}
              placeholder="Поиск по графику, технике, камерам"
              aria-label="Глобальный поиск"
            />
            <kbd>⌘ K</kbd>
          </label>

          <button className="date-button">
            <Icon name="clock" size={16} />Сегодня, {new Date().toLocaleTimeString().slice(0, 5)}
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
              {projectsList.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.code})
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
                URL потока (HTTP(S) MJPEG, RTSP, HLS или IP)
                <input id="cam_stream_input" name="cam_stream" placeholder="https://192.168.1.106:8080/video" defaultValue={editingCamera?.stream_url || ''} />
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
                    if (el) el.value = 'rtsp://192.168.1.106:8554/video'
                    setStreamCheckResult(null)
                  }}
                >
                  VLC RTSP (:8554/video)
                </button>
                <button
                  type="button"
                  className="button"
                  style={{ fontSize: '10px', padding: '2px 8px' }}
                  onClick={() => {
                    const el = document.getElementById('cam_stream_input') as HTMLInputElement
                    if (el) el.value = 'https://192.168.1.106:8080/video'
                    setStreamCheckResult(null)
                  }}
                >
                  HTTP MJPEG (:8080/video)
                </button>
                <button
                  type="button"
                  className="button"
                  style={{ fontSize: '10px', padding: '2px 8px' }}
                  onClick={() => {
                    const el = document.getElementById('cam_stream_input') as HTMLInputElement
                    if (el) el.value = 'rtsp://192.168.1.120:554/live/crane_cam'
                    setStreamCheckResult(null)
                  }}
                >
                  RTSP: Кран (Секция 1)
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

      {toastText && (
        <div className="toast" role="status">
          <Icon name="check" />
          <span>{toastText}</span>
        </div>
      )}
    </div>
  )
}
