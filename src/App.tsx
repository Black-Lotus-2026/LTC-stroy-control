import productLogo from './assets/stroy-control-logo.png'
import { observationScope, upsertIncident } from './domain/observationScope'
import { canChangeIncident } from './domain/incidentWorkflow'
import { filterIncidents } from './domain/incidentPresentation'
import { Icon, Status } from './components/ui/Primitives'
import { getEffectiveStageRules } from './domain/stageRules'
import { Progress, Analytics } from './components/planning/Planning'
import { PhotoArchive, Reports } from './components/cases/CasePages'
import { CaseCostsPanel, IncidentCostDialog } from './components/management/IncidentCost'
import { useEffect, useMemo, useState, useRef, useCallback } from 'react'
import {
  incidentsSeed,
  type Incident,
  type IncidentStatus,
  type PageKey,
} from './data'
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
  uploadVideoAsset,
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
  fetchStageProbabilities,
  type IncidentAlertItem,
  type AlertNotificationItem,
  type AdminRecipient,
  fetchAlerts,
  markAlertRead,
  fetchAdminRecipients,
  updateProjectAlertSettings,
  updateMyEmail,
} from './api/stroyControlApi'
import { AlertCenter } from './components/AlertCenter'
import { WeatherForecast } from './components/WeatherForecast'

const nav: { id: PageKey; label: string; icon: string }[] = [
  { id: 'management', label: 'Отклонения', icon: 'alert' },
  { id: 'monitoring', label: 'Камеры', icon: 'video' },
  { id: 'archive', label: 'Фотоархив', icon: 'camera' },
  { id: 'progress', label: 'График', icon: 'progress' },
  { id: 'analytics', label: 'Правила контроля', icon: 'chart' },
  { id: 'reports', label: 'Отчёты', icon: 'file' },
  { id: 'alerts', label: 'Задачи', icon: 'bell' },
  { id: 'settings', label: 'Настройки', icon: 'settings' },
]

const titles: Record<PageKey, [string, string]> = {
  management: ['Отклонения', ''],
  monitoring: ['Камеры', 'Камеры, видеозаписи и детекция строительной техники'],
  archive: ['Фотоархив', 'Фотофиксация нарушений и событий стройплощадки с привязкой к отчётам'],
  progress: ['График', 'Календарный график СМР и контроль сроков (Гант)'],
  analytics: ['Правила контроля', 'Вероятностные профили спецтехники по этапам СМР'],
  reports: ['Отчёты', 'Сводка нарушений за смену и контроль регламентов'],
  alerts: ['Задачи', 'Задачи ответственным, сроки проверки и эскалации'],
  settings: ['Настройки', 'Объекты, стройплощадки, камеры и правила'],
}

function getNowDateTimeLocal(): string {
  const d = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
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

function CameraFrame({
  boxes = true,
  compact = false,
  streamName = 'Камера',
  timestamp = '',
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
  const [loadedSource, setLoadedSource] = useState<string | null>(null)
  const [streamLoadError, setStreamLoadError] = useState(false)
  const [detectorNotice, setDetectorNotice] = useState<string | null>(null)
  const [streamRetryKey, setStreamRetryKey] = useState(0)
  const [detectionViewport, setDetectionViewport] = useState({ left: 0, top: 0, width: 0, height: 0 })
  const frameRef = useRef<HTMLDivElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const lastDetectTimeRef = useRef<number>(-999)
  const detectionInFlightRef = useRef(false)
  const sourceGenerationRef = useRef(0)

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

  const sourceKey = videoUrl || effectiveStreamUrl || ''
  useEffect(() => {
    sourceGenerationRef.current += 1
    return () => { sourceGenerationRef.current += 1 }
  }, [sourceKey])
  const isStreamActive = Boolean(loadedSource === sourceKey && sourceKey && (isFileVideo || isHttpStream) && !streamLoadError)

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

  const triggerDetection = useCallback(async () => {
    if (!isStreamActive) return
    if (detectionInFlightRef.current) return
    const generation = sourceGenerationRef.current
    try {
      const media = isFileVideo ? videoRef.current : imgRef.current
      if (!media) return
      const width = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth
      const height = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight
      if (!width || !height) return
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) return
      context.drawImage(media, 0, 0, width, height)
      let snapshotDataUrl = ''
      try {
        snapshotDataUrl = canvas.toDataURL('image/jpeg', 0.85)
      } catch (err) {
        console.warn('Canvas toDataURL failed (possibly tainted):', err)
      }
      detectionInFlightRef.current = true
      setIsDetecting(true)

      canvas.toBlob(async (blob) => {
        if (generation !== sourceGenerationRef.current) return
        if (!blob) {
          detectionInFlightRef.current = false
          setIsDetecting(false)
          return
        }
        try {
          const res = await detectFrameImage(blob, activeStageName)
          if (generation !== sourceGenerationRef.current) return
          setDetectorNotice(res.model_ready ? res.message ?? null : res.message || 'Модель YOLO не готова')
          const mapped: LiveDetectionInfo[] = res.detections.map((d) => ({
            label: d.label_ru,
            conf: Math.round(d.confidence * 100),
            time: isFileVideo ? `Таймкод: ${currentTime.toFixed(1)} с` : new Date(res.timestamp).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
            top: d.top,
            left: d.left,
            width: d.width,
            height: d.height,
          }))
          const validDets = mapped.filter((d) => d.conf >= 60)
          setRealDetections(mapped)
          onDetectionsUpdate?.(validDets)
          if (snapshotDataUrl && res.model_ready) {
            onFrameAnalysis?.(snapshotDataUrl, validDets, currentTime, streamName, streamName)
          }
        } catch (err) {
          if (generation !== sourceGenerationRef.current) return
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
              <span>Проверьте адрес потока и подключение камеры.</span>
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
              key={`${sourceKey}:${streamRetryKey}`}
              ref={imgRef}
              crossOrigin="anonymous"
              src={proxiedStreamUrl ?? undefined}
              alt={`Видеопоток ${streamName}`}
              onLoad={() => {
                setStreamLoadError(false)
                setLoadedSource(sourceKey)
                updateDetectionViewport()
                triggerDetection()
              }}
              onError={() => setStreamLoadError(true)}
            />
          )}
          <div className="stream-telemetry">
            <strong>{isStreamActive ? 'Изображение доступно' : 'Подключение камеры'}</strong>
          </div>
        </div>
      ) : isRtsp ? (
        <div className="camera-empty-state">
          <Icon name="video" size={28} />
          <strong>Для RTSP нужен видеошлюз</strong>
          <p>Добавьте HTTP/MJPEG-адрес потока в настройках камеры.</p>
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
          onLoadedData={() => { setLoadedSource(sourceKey); setStreamLoadError(false) }}
          onError={() => { setStreamLoadError(true); setLoadedSource(null) }}
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
        <div className="camera-empty-state">
          <Icon name="video" size={28} />
          <strong>Нет изображения</strong>
          <p>Выберите другой источник или добавьте видеозапись.</p>
        </div>
      )}

      {detectorNotice && (
        <div className="detector-notice" role="status">
          {detectorNotice}
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
        <span>{isDetecting ? 'Анализ кадра…' : isStreamActive ? `В кадре: ${displayedDetections.length}` : 'Нет изображения для анализа'}</span>
        <span>{isFileVideo ? `Позиция записи: ${currentTime.toFixed(1)} с` : timestamp}</span>
      </div>
    </div>
  )
}



// ----------------------------------------------------------------------------
// 1. Monitoring Page (Video / RTSP + High-Contrast AI Detection Bounding Boxes)
// ----------------------------------------------------------------------------
function Monitoring({ activeProject, activeZones, camerasList, selectedCameraId, setSelectedCameraId, stages,
  uploadedVideoUrl, uploadedVideoName, videoTimestamp, setUploadedVideoUrl, setUploadedVideoName,
  setIsUploadModalOpen, setIsCameraModalOpen, onFrameAnalysis, onStreamStatusChange, toast, canManage, confirmedRuleStageIds, rulesLoading, onRetryRules,
}: {
  rulesLoading: boolean; onRetryRules: () => void; confirmedRuleStageIds: string[]; canManage: boolean; activeProject?: ProjectItem; activeZones: ZoneItem[]; camerasList: CameraItem[]
  selectedCameraId: string | null; setSelectedCameraId: (id: string | null) => void; stages: StageItem[]
  uploadedVideoUrl: string | null; uploadedVideoName: string | null; videoTimestamp: string
  setUploadedVideoUrl: (url: string | null) => void; setUploadedVideoName: (name: string | null) => void
  setIsUploadModalOpen: (open: boolean) => void; setIsCameraModalOpen: (open: boolean) => void
  onFrameAnalysis?: (snapshot: string, dets: LiveDetectionInfo[], time: number, sourceId?: string, sourceName?: string) => void
  onStreamStatusChange?: (online: boolean) => void; toast: (message: string) => void
}) {
  const [boxes, setBoxes] = useState(true)
  const [online, setOnline] = useState(false)
  const [activeEquipment, setActiveEquipment] = useState<string | null>(null)
  const [liveDetections, setLiveDetections] = useState<LiveDetectionInfo[]>([])
  const viewer = useRef<HTMLElement>(null)
  const currentCamera = camerasList.find(camera => camera.id === selectedCameraId) || camerasList[0]
  const sourceKey = uploadedVideoUrl || currentCamera?.id || 'empty'
  const activeStage = getCurrentStageByDate(stages, uploadedVideoUrl ? new Date(videoTimestamp) : new Date())
  const rules = activeStage && confirmedRuleStageIds.includes(activeStage.id) ? getEffectiveStageRules(activeStage) : null
  const onSourceStatus = useCallback((ready: boolean) => {
    setOnline(ready)
    onStreamStatusChange?.(ready)
  }, [onStreamStatusChange])
  const saveFrame = () => {
    const media = viewer.current?.querySelector<HTMLVideoElement | HTMLImageElement>('.camera-frame:not(.compact-frame) video, .camera-frame:not(.compact-frame) img')
    if (!media || !online) { toast('Изображение пока недоступно'); return }
    const width = media instanceof HTMLVideoElement ? media.videoWidth : media.naturalWidth
    const height = media instanceof HTMLVideoElement ? media.videoHeight : media.naturalHeight
    if (!width || !height) { toast('Кадр ещё не загружен'); return }
    try {
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      canvas.getContext('2d')?.drawImage(media, 0, 0, width, height)
      const link = document.createElement('a')
      link.download = `camera-frame-${Date.now()}.jpg`
      link.href = canvas.toDataURL('image/jpeg', .9)
      link.click()
    } catch { toast('Не удалось скачать кадр') }
  }
  return <div className="monitor-workspace">
    <aside className="monitor-camera-list">
      <div className="monitor-camera-list-heading"><strong>Камеры</strong><span>{camerasList.length}</span></div>
      {camerasList.length === 0 && <p className="monitor-camera-empty">Камеры не добавлены</p>}
      {camerasList.map(camera => <button type="button" key={camera.id} className={!uploadedVideoUrl && camera.id === currentCamera?.id ? 'active' : ''}
        onClick={() => { setOnline(false); setLiveDetections([]); setSelectedCameraId(camera.id); setUploadedVideoName(null); setUploadedVideoUrl(null) }}>
        <Icon name="video" size={17} /><span><strong>{camera.name}</strong><small>{camera.stream_url?.startsWith('rtsp:') ? 'Нужен видеошлюз' : !camera.stream_url ? 'Нет потока' : camera.id === currentCamera?.id && online && !uploadedVideoUrl ? 'Есть изображение' : 'Подключена'}</small></span>
      </button>)}
      {canManage && <details className="monitor-source-actions"><summary>Добавить источник</summary><div>
        <button type="button" className="button" onClick={() => setIsUploadModalOpen(true)}>Загрузить видео</button>
        <button type="button" className="button" onClick={() => setIsCameraModalOpen(true)}>Добавить камеру</button>
      </div></details>}
    </aside>
    <main className="monitor-main" ref={viewer}>
      {!currentCamera && !uploadedVideoUrl ? <section className="panel camera-empty-state">
        <Icon name="video" size={32}/><h2>{canManage ? 'Добавьте камеру или видеозапись' : 'Камеры пока не добавлены'}</h2><p>{activeProject?.name}</p>
        {canManage && <button className="button primary" onClick={() => setIsUploadModalOpen(true)}>Загрузить видео</button>}
      </section> : <section className="panel viewer">
        <header className="monitor-viewer-heading"><div><h2>{uploadedVideoName || currentCamera?.name || 'Видеозапись'}</h2><span className={`monitor-live-status${online ? ' online' : ''}`}>{uploadedVideoUrl ? 'Видеозапись' : currentCamera?.stream_url?.startsWith('rtsp:') ? 'Требуется шлюз' : online ? 'Есть изображение' : 'Нет изображения'}</span></div>
          <details className="monitor-view-options"><summary aria-label="Параметры просмотра">⋯</summary><div>
            <label><input type="checkbox" checked={boxes} onChange={event => setBoxes(event.target.checked)}/> Рамки техники</label>
            <button className="button" disabled={!online} onClick={saveFrame}>Скачать кадр</button>
            {uploadedVideoUrl && <button className="button" onClick={() => { setOnline(false); setUploadedVideoUrl(null); setUploadedVideoName(null) }}>Закрыть видеозапись</button>}
          </div></details>
        </header>
        <CameraFrame key={sourceKey} boxes={boxes} videoUrl={uploadedVideoUrl} streamUrl={!uploadedVideoUrl ? currentCamera?.stream_url : null}
          streamName={uploadedVideoName || currentCamera?.name || 'Камера'} timestamp={uploadedVideoUrl ? `Запись от ${new Date(videoTimestamp).toLocaleString('ru-RU')}` : ''}
          activeClass={activeEquipment} activeStageName={activeStage?.name}
          onSelectClass={equipment => setActiveEquipment(previous => previous === equipment ? null : equipment)} onDetectionsUpdate={setLiveDetections}
          onFrameAnalysis={(snapshot, detections, time) => onFrameAnalysis?.(snapshot, detections, time, uploadedVideoUrl ? 'video-source' : currentCamera?.id, uploadedVideoName || currentCamera?.name)}
          onStreamStatusChange={onSourceStatus}/>
        <div hidden aria-hidden="true">{camerasList.filter(camera => camera.id !== currentCamera?.id && camera.stream_url && !camera.stream_url.startsWith('rtsp:')).map(camera => <CameraFrame key={camera.id} compact boxes={false} streamUrl={camera.stream_url} streamName={camera.name} activeStageName={activeStage?.name}
          onFrameAnalysis={(snapshot, detections, time) => onFrameAnalysis?.(snapshot, detections, time, camera.id, camera.name)}/>)}</div>
      </section>}
      {online && <section className="monitor-detections"><h3>В кадре <span>{liveDetections.length}</span></h3>{liveDetections.length ? <div>{liveDetections.map(detection => <button key={detection.label} className={activeEquipment === detection.label ? 'active' : ''} onClick={() => setActiveEquipment(previous => previous === detection.label ? null : detection.label)}>{detection.label}<span>{detection.conf}%</span></button>)}</div> : <p>Техника пока не обнаружена</p>}</section>}
      {activeStage && !rules && <p className="monitor-rules-notice" role="status">{rulesLoading ? 'Загружаем правила контроля…' : <>Правила недоступны. Оценка отклонений приостановлена.<button className="button" onClick={onRetryRules}>Повторить</button></>}</p>}
      <details className="monitor-context"><summary>План и правила контроля</summary><div>
        <p className="monitor-stage-label">Этап плана{uploadedVideoUrl ? ' на дату записи' : ''}</p><strong>{activeStage?.name || 'Нет этапа на выбранную дату'}</strong>
        {activeStage && <p>{activeStage.planned_start.slice(0,10)} — {activeStage.planned_end.slice(0,10)}</p>}
        {rules && <p>Обязательная техника: {rules.mandatory.join(', ') || 'Не задана'}</p>}
        {activeZones.length === 1 && <small>{activeZones[0].name}</small>}
      </div></details>
      {activeProject && <WeatherForecast projectId={activeProject.id} configured={activeProject.latitude != null && activeProject.longitude != null} />}
    </main>
  </div>
}

function Settings({
  activeProject,
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
  currentUser,
  adminRecipients,
  onSaveAlertSettings,
  onSaveEmail,
  toast,
}: {
  activeProject?: ProjectItem
  onUpdateProject: (
    projectId: string,
    data: { name: string; code: string; address?: string; object_kind?: string; status?: string; latitude?: number | null; longitude?: number | null }
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
  currentUser: UserProfile | null
  adminRecipients: AdminRecipient[]
  onSaveAlertSettings: (projectId: string, data: { owner_username: string | null; alert_error_deadline_minutes: number; alert_warning_deadline_minutes: number; escalation_user_id: string | null }) => Promise<void>
  onSaveEmail: (email: string | null) => Promise<void>
  toast: (s: string) => void
}) {
  const [activeTab, setActiveTab] = useState<'general' | 'zones' | 'cameras'>('general')

  // Form state for active project
  const [name, setName] = useState(activeProject?.name || '')
  const [code, setCode] = useState(activeProject?.code || '')
  const [address, setAddress] = useState(activeProject?.address || '')
  const [latitude, setLatitude] = useState(activeProject?.latitude?.toString() ?? '')
  const [longitude, setLongitude] = useState(activeProject?.longitude?.toString() ?? '')
  const [objectKind, setObjectKind] = useState(activeProject?.object_kind || 'Жильё')
  const [isSaving, setIsSaving] = useState(false)

  // Violation window setting state
  const [windowInput, setWindowInput] = useState<number>(violationWindowSeconds)
  const [isSavingWindow, setIsSavingWindow] = useState(false)
  const projectDirty = name !== (activeProject?.name || '') || code !== (activeProject?.code || '') || address !== (activeProject?.address || '') || objectKind !== (activeProject?.object_kind || 'Жильё') || latitude !== (activeProject?.latitude?.toString() ?? '') || longitude !== (activeProject?.longitude?.toString() ?? '')
  const [alertOwner, setAlertOwner] = useState(activeProject?.owner_username || '')
  const [alertChief, setAlertChief] = useState(activeProject?.escalation_user_id || '')
  const [errorMinutes, setErrorMinutes] = useState(activeProject?.alert_error_deadline_minutes || 120)
  const [warningMinutes, setWarningMinutes] = useState(activeProject?.alert_warning_deadline_minutes || 1440)
  const [emailInput, setEmailInput] = useState(currentUser?.email || '')
  const [isSavingAlerts, setIsSavingAlerts] = useState(false)
  const [isSavingEmail, setIsSavingEmail] = useState(false)
  const alertSettingsDirty = alertOwner !== (activeProject?.owner_username || '') || alertChief !== (activeProject?.escalation_user_id || '') || errorMinutes !== (activeProject?.alert_error_deadline_minutes || 120) || warningMinutes !== (activeProject?.alert_warning_deadline_minutes || 1440)

  useEffect(() => {
    setWindowInput(violationWindowSeconds)
  }, [violationWindowSeconds])

  useEffect(() => {
    setEmailInput(currentUser?.email || '')
  }, [currentUser?.email])

  // Synchronize when activeProject changes
  useEffect(() => {
    setName(activeProject?.name || '')
    setCode(activeProject?.code || '')
    setAddress(activeProject?.address || '')
    setLatitude(activeProject?.latitude?.toString() ?? '')
    setLongitude(activeProject?.longitude?.toString() ?? '')
    setObjectKind(activeProject?.object_kind || 'Жильё')
    setAlertOwner(activeProject?.owner_username || '')
    setAlertChief(activeProject?.escalation_user_id || '')
    setErrorMinutes(activeProject?.alert_error_deadline_minutes || 120)
    setWarningMinutes(activeProject?.alert_warning_deadline_minutes || 1440)
  }, [activeProject?.id, activeProject?.owner_username, activeProject?.escalation_user_id, activeProject?.alert_error_deadline_minutes, activeProject?.alert_warning_deadline_minutes, activeProject?.latitude, activeProject?.longitude])

  const handleSaveProject = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!activeProject) return
    if (!name.trim()) {
      toast('Название объекта не может быть пустым')
      return
    }
    if (Boolean(latitude.trim()) !== Boolean(longitude.trim())) {
      toast('Для прогноза укажите и широту, и долготу')
      return
    }
    setIsSaving(true)
    try {
      await onUpdateProject(activeProject.id, {
        name: name.trim(),
        code: code.trim() || activeProject.code,
        address: address.trim() || undefined,
        latitude: latitude.trim() ? Number(latitude) : null,
        longitude: longitude.trim() ? Number(longitude) : null,
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

                <h2>{activeProject?.name || 'Настройки проекта'}</h2>

              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button className="button" type="button" onClick={() => setIsCreateProjectOpen(true)}>
                  + Новый объект
                </button>
                {activeProject && <details className="settings-more"><summary aria-label="Действия с объектом">⋯</summary><div><button className="button danger" type="button" onClick={handleDeleteProjectClick}>Удалить объект</button></div></details>}
                <button
                  className="button primary"
                  type="button"
                  disabled={isSaving || !activeProject || !projectDirty}
                  onClick={handleSaveProject}
                >
                  {isSaving ? 'Сохранение...' : 'Сохранить изменения'}
                </button>
              </div>
            </div>

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
                Широта для прогноза погоды
                <input type="number" min="-90" max="90" step="any" value={latitude} onChange={e => setLatitude(e.target.value)} placeholder="55.7558" />
              </label>
              <label>
                Долгота для прогноза погоды
                <input type="number" min="-180" max="180" step="any" value={longitude} onChange={e => setLongitude(e.target.value)} placeholder="37.6173" />
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

                  <h3 style={{ margin: '4px 0 6px', fontSize: '15px', color: '#fff' }}>
                    Окно наблюдения
                  </h3>
                  <p style={{ color: 'var(--muted)', fontSize: '12px', lineHeight: 1.5, margin: 0 }}>
                    Сколько секунд наблюдать участок перед фиксацией отклонения.
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                  <label style={{ margin: 0, width: '130px' }}>
                    Период (сек)
                    <input
                      type="number"
                      min={5}
                      max={600}
                      disabled={currentUser?.role !== 'admin'}
                      value={windowInput}
                      onChange={(e) => setWindowInput(parseInt(e.target.value, 10) || 30)}
                      style={{ width: '100%', height: '36px' }}
                    />
                  </label>
                  <button
                    type="button"
                    className="button"
                    disabled={currentUser?.role !== 'admin' || isSavingWindow || windowInput === violationWindowSeconds || windowInput < 5 || windowInput > 600}
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

            <details className="alert-settings-card"><summary>Уведомления и сроки реакции</summary>
              <p>Ответственный получает задачу; после срока система запрашивает повторную проверку.</p>
              <div className="form-grid">
                <label>
                  Ответственный за объект
                  <input value={alertOwner} disabled={currentUser?.role !== 'admin'} onChange={(e) => setAlertOwner(e.target.value)} placeholder="Логин пользователя" />
                </label>
                <label>
                  Руководитель для эскалации
                  <select value={alertChief} disabled={currentUser?.role !== 'admin'} onChange={(e) => setAlertChief(e.target.value)}>
                    <option value="">Первый активный администратор</option>
                    {adminRecipients.map((admin) => <option key={admin.id} value={admin.id}>{admin.name} ({admin.username})</option>)}
                  </select>
                </label>
                <label>
                  Критическое отклонение, мин
                  <input type="number" min={1} max={10080} value={errorMinutes} onChange={(e) => setErrorMinutes(Number(e.target.value))} />
                </label>
                <label>
                  Предупреждение, мин
                  <input type="number" min={1} max={43200} value={warningMinutes} onChange={(e) => setWarningMinutes(Number(e.target.value))} />
                </label>
              </div>
              <button
                className="button primary"
                disabled={!activeProject || isSavingAlerts || !alertSettingsDirty || errorMinutes < 1 || errorMinutes > 10080 || warningMinutes < 1 || warningMinutes > 43200}
                onClick={async () => {
                  if (!activeProject) return
                  setIsSavingAlerts(true)
                  try {
                    await onSaveAlertSettings(activeProject.id, {
                      owner_username: alertOwner.trim() || null,
                      escalation_user_id: alertChief || null,
                      alert_error_deadline_minutes: errorMinutes,
                      alert_warning_deadline_minutes: warningMinutes,
                    })
                  } catch (error) {
                    toast(error instanceof Error ? error.message : 'Не удалось сохранить настройки алертов')
                  } finally {
                    setIsSavingAlerts(false)
                  }
                }}
              >
                {isSavingAlerts ? 'Сохранение…' : 'Сохранить сроки'}
              </button>
              <div className="alert-email-settings">
                <label>
                  Мой email для копии алертов
                  <input type="email" value={emailInput} onChange={(e) => setEmailInput(e.target.value)} placeholder="name@example.com" />
                </label>
                <button className="button" disabled={isSavingEmail || emailInput.trim() === (currentUser?.email || '')} onClick={async () => {
                  setIsSavingEmail(true)
                  try { await onSaveEmail(emailInput.trim() || null) }
                  catch (error) { toast(error instanceof Error ? error.message : 'Не удалось сохранить email') }
                  finally { setIsSavingEmail(false) }
                }}>Сохранить email</button>
                <small>Письма отправляются, если на сервере настроен SMTP. Уведомления доступны в разделе «Задачи».</small>
              </div>
            </details>
          </>
        )}

        {/* Tab 2: Construction Sites (Zones) */}
        {activeTab === 'zones' && (
          <>
            <div className="settings-heading">
              <div>

                <h2>Стройплощадки</h2>

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

                <h2>Камеры</h2>

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

function mapApiIncident(item: IncidentAlertItem): Incident {
  const snapshot = normalizeSnapshotUrl(item.frame_snapshot_url || item.snapshot_url)
  return {
    id: item.code,
    apiId: item.id,
    assignedUserId: item.assigned_user_id,
    uuid: item.id,
    projectId: item.project_id,
    type: item.discrepancy_type?.startsWith('STREAM_') ? 'Видеопоток' : 'Техника',
    title: item.title || 'Нарушение регламента',
    zoneId: item.zone_id,
    createdAt: item.first_seen_at || item.created_at,
    zone: item.zone_name || 'Без привязки к площадке',
    camera: item.camera_name || 'Камера не указана',
    time: item.first_seen_at || item.created_at ? new Date((item.first_seen_at || item.created_at)!).toLocaleTimeString('ru-RU', {hour:'2-digit',minute:'2-digit'}) : 'Время не указано',
    age: 'Недавно',
    priority: item.severity === 'ERROR' ? 'Критический' : 'Средний',
    status: mapApiStatus(item.status),
    assignee: item.assignee_name || 'Не назначен',
    sla: item.sla_deadline ? new Date(item.sla_deadline).toLocaleString('ru-RU') : '—',
    slaDeadline: item.sla_deadline,
    verificationStatus: item.verification_status,
    escalatedAt: item.escalated_at,
    confidence: Math.round((item.confidence || 0) * 100),
    note: item.description || '',
    severity: item.severity,
    snapshotUrl: snapshot,
    albumPhotos: item.album_photos?.map((p) => ({
      url: normalizeSnapshotUrl(p.url) || p.url,
      cameraName: p.camera_name,
      isPrimary: p.is_primary,
      capturedAt: p.captured_at,
    })) || [],
    stageName: item.stage_name || undefined,
    discrepancyType: item.discrepancy_type,
    manual_override: Boolean(item.manual_override),
  }
}

export default function App() {
  const [page, setPage] = useState<PageKey>('management')
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const [isSmallScreen, setIsSmallScreen] = useState(() => window.matchMedia('(max-width: 768px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 768px)')
    const update = () => setIsSmallScreen(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  useEffect(() => {
    if (!mobileNav) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setMobileNav(false); document.querySelector<HTMLButtonElement>('.mobile-menu')?.focus() } }
    document.addEventListener('keydown', close)
    return () => document.removeEventListener('keydown', close)
  }, [mobileNav])
  const [toastText, setToastText] = useState<string | null>(null)
  const [incidentsError, setIncidentsError] = useState('')
  const [incidentsLoading, setIncidentsLoading] = useState(true)
  const [incidentsRevision, setIncidentsRevision] = useState(0)
  const [projectsError, setProjectsError] = useState('')
  const [projectsLoading, setProjectsLoading] = useState(true)
  const [workspaceError, setWorkspaceError] = useState('')
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [workspaceRevision, setWorkspaceRevision] = useState(0)
  const projectsRequest = useRef(0)
  const [incidentsList, setIncidentsList] = useState<Incident[]>(incidentsSeed)
  const [violationWindowSeconds, setViolationWindowSeconds] = useState<number>(30)
  const [highlightedIncidentId, setHighlightedIncidentId] = useState<string | null>(null)
  const [costCase, setCostCase] = useState<{ incidentId?: string; clientId?: string; title: string } | null>(null)
  const closeCostCase = useCallback(() => setCostCase(null), [])
  const [activeViolationAlert, setActiveViolationAlert] = useState<{
    id: string
    incidentId?: string
    title: string
    desc: string
    severity: 'ERROR' | 'WARNING'
    snapshotUrl?: string
  } | null>(null)

  const recentObservationsRef = useRef<{ timestamp: number; detectedLabels: string[] }[]>([])
  const violationCooldownRef = useRef<Record<string, number>>({})
  const streamStartTimeRef = useRef<number | null>(null)
  const observationWindowsRef = useRef(new Map<string, number>())
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
        capturedAt: string
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
  const [confirmedRuleStageIds, setConfirmedRuleStageIds] = useState<string[]>([])
  const [rulesLoading, setRulesLoading] = useState(false)
  const [cameraReportedOnline, setCameraReportedOnline] = useState<boolean>(false)
  const streamTransitionStateRef = useRef<'ONLINE' | 'OFFLINE' | null>(null)

  const scopedCameras = useMemo(() => camerasList.filter(camera => activeZoneId === 'all' || !activeZoneId || camera.zone_id === activeZoneId), [camerasList, activeZoneId])
  const curCam = scopedCameras.find((c) => c.id === selectedCameraId) || scopedCameras[0]
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

  // User Authentication State
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null)
  const [alertsList, setAlertsList] = useState<AlertNotificationItem[]>([])
  const [alertsLoading, setAlertsLoading] = useState(false)
  const [alertsError, setAlertsError] = useState('')
  const incidentsRequest = useRef(0)
  const alertsRequest = useRef(0)
  const activeScope = useRef('')
  activeScope.current = `${currentUser?.id}:${activeProjectId}`
  const [adminRecipients, setAdminRecipients] = useState<AdminRecipient[]>([])
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

  }, [])

  const refreshIncidents = useCallback(async () => {
    if (!currentUser || !activeProjectId) return
    const scope = `${currentUser.id}:${activeProjectId}`
    const request = ++incidentsRequest.current
    try {
      const items = await fetchIncidents(activeProjectId)
      if (request === incidentsRequest.current && activeScope.current === scope) {
        setIncidentsList(items.map(mapApiIncident)); setIncidentsError('')
      }
    } catch (error) {
      if (request === incidentsRequest.current && activeScope.current === scope) setIncidentsError('Не удалось обновить события')
      throw error
    } finally {
      if (request === incidentsRequest.current && activeScope.current === scope) setIncidentsLoading(false)
    }
  }, [currentUser, activeProjectId])

  const refreshAlerts = useCallback(async () => {
    if (!currentUser) return
    const userId = currentUser.id
    const request = ++alertsRequest.current
    try {
      const items = await fetchAlerts()
      if (request === alertsRequest.current && activeScope.current.startsWith(`${userId}:`)) { setAlertsList(items); setAlertsError('') }
    } catch (error) {
      if (request === alertsRequest.current) setAlertsError('Не удалось загрузить уведомления')
      throw error
    } finally {
      if (request === alertsRequest.current) setAlertsLoading(false)
    }
  }, [currentUser])

  useEffect(() => {
    setIncidentsList([]); setIncidentsError('')
    if (!currentUser || !activeProjectId) { setIncidentsLoading(false); return }
    setIncidentsLoading(true)
    void refreshIncidents().catch(() => {})
    const timer = window.setInterval(() => { void refreshIncidents().catch(() => {}) }, 15000)
    return () => { incidentsRequest.current += 1; window.clearInterval(timer) }
  }, [currentUser, activeProjectId, refreshIncidents, incidentsRevision])

  useEffect(() => {
    setAlertsList([]); setAlertsError('')
    if (!currentUser) return
    setAlertsLoading(true)
    void refreshAlerts().catch(() => {})
    const timer = window.setInterval(() => { void refreshAlerts().catch(() => {}) }, 15000)
    return () => { alertsRequest.current += 1; window.clearInterval(timer) }
  }, [currentUser, refreshAlerts])

  useEffect(() => {
    let cancelled = false
    if (currentUser?.role === 'admin') {
      fetchAdminRecipients().then(items => { if (!cancelled) setAdminRecipients(items) }).catch(() => { if (!cancelled) setAdminRecipients([]) })
    } else setAdminRecipients([])
    return () => { cancelled = true }
  }, [currentUser])

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
      (p) => p.owner_username === currentUser.username
    )
  }, [projectsList, currentUser])

  const loadProjectsForUser = useCallback(async (user: UserProfile) => {
    const request = ++projectsRequest.current
    setProjectsLoading(true)
    setProjectsError('')
    try {
      const projects = await fetchProjects()
      if (request !== projectsRequest.current) return
      const visible = user.role === 'admin' ? projects : projects.filter(project => project.owner_username === user.username)
      setProjectsList(projects)
      setActiveProjectId(previous => visible.some(project => project.id === previous) ? previous : visible[0]?.id || null)
    } catch {
      if (request === projectsRequest.current) { setProjectsError('Не удалось загрузить объекты'); setProjectsList([]); setActiveProjectId(null) }
    } finally { if (request === projectsRequest.current) setProjectsLoading(false) }
  }, [])

  useEffect(() => {
    if (currentUser) void loadProjectsForUser(currentUser)
    else { projectsRequest.current += 1; setProjectsList([]); setActiveProjectId(null); setProjectsLoading(false) }
  }, [currentUser, loadProjectsForUser])

  // Role-based workspace page permissions
  const allowedNav = useMemo(() => {
    if (!currentUser) return []
    if (currentUser.role === 'admin') return nav
    if (currentUser.role === 'viewer') {
      return nav.filter((n) => ['management', 'monitoring', 'archive', 'reports', 'alerts'].includes(n.id))
    }
    if (currentUser.role === 'inspector') {
      return nav.filter((n) => ['management', 'monitoring', 'archive', 'progress', 'reports', 'alerts'].includes(n.id))
    }
    return nav
  }, [currentUser])

  useEffect(() => {
    if (allowedNav.length > 0 && !allowedNav.some((n) => n.id === page)) {
      setPage(allowedNav[0].id)
    }
  }, [allowedNav, page])

  // Cancel stale responses on scope changes; never show the previous object's data.
  useEffect(() => {
    let cancelled = false
    setActiveZones([]); setCamerasList([]); setStages([]); setSelectedCameraId(null)
    setActiveZoneId('all'); setCameraReportedOnline(false); setUploadedVideoUrl(null); setUploadedVideoName(null)
    streamTransitionStateRef.current = null
    setWorkspaceError('')
    if (!activeProjectId) { setWorkspaceLoading(false); return }
    setWorkspaceLoading(true)
    Promise.all([fetchProjectZones(activeProjectId), fetchCameras(activeProjectId), fetchStages(activeProjectId)])
      .then(([zones, cameras, tasks]) => {
        if (cancelled) return
        setActiveZones(zones); setCamerasList(cameras); setStages(tasks); setSelectedCameraId(cameras[0]?.id || null)
      })
      .catch(() => { if (!cancelled) setWorkspaceError('Не удалось загрузить данные объекта') })
      .finally(() => { if (!cancelled) setWorkspaceLoading(false) })
    return () => { cancelled = true }
  }, [activeProjectId, workspaceRevision])

  useEffect(() => {
    let cancelled = false
    setConfirmedRuleStageIds([])
    setRulesLoading(true)
    Promise.allSettled(stages.map(stage => fetchStageProbabilities(stage.id)))
      .then(results => { if (!cancelled) setConfirmedRuleStageIds(results.flatMap((result, index) => result.status === 'fulfilled' ? [stages[index].id] : [])); if (!cancelled) setRulesLoading(false) })
    return () => { cancelled = true }
  }, [stages, stageOverridesVersion])

  const activeProject = userVisibleProjects.find(project => project.id === activeProjectId)
  const scopedIncidents = useMemo(() => filterIncidents(incidentsList, activeProjectId || undefined, activeZoneId).map(incident => ({ ...incident, canUpdate: canChangeIncident(incident, currentUser, activeProject?.owner_username), canDismiss: currentUser?.role === 'admin' })), [incidentsList, activeProjectId, activeZoneId, currentUser, activeProject?.owner_username])

  // Handle Create Project
  const handleCreateProjectSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const name = (form.elements.namedItem('prj_name') as HTMLInputElement).value
    const address = (form.elements.namedItem('prj_address') as HTMLInputElement).value
    const latitude = (form.elements.namedItem('prj_latitude') as HTMLInputElement).value
    const longitude = (form.elements.namedItem('prj_longitude') as HTMLInputElement).value
    if (Boolean(latitude) !== Boolean(longitude)) { toast('Для прогноза укажите и широту, и долготу'); return }
    const objectKind = (form.elements.namedItem('prj_kind') as HTMLSelectElement).value

    try {
      const created = await createProject({
        name,
        address,
        latitude: latitude ? Number(latitude) : undefined,
        longitude: longitude ? Number(longitude) : undefined,
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
    data: { name: string; code: string; address?: string; object_kind?: string; status?: string; latitude?: number | null; longitude?: number | null }
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
    const streamUrl = rawStreamUrl
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
        setCameraReportedOnline(false)
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
      setCameraReportedOnline(false)
      toast(`Камера «${created.name}» добавлена`)
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
      toast('Не удалось сохранить интервал наблюдения')
    }
  }

  // Handle manual incident status change ("Ожидает обработки", "Проблемы нет", "Подтверждено")
  const handleIncidentStatusChange = async (incidentId: string, newStatus: IncidentStatus) => {
    const incident = incidentsList.find((item) => item.id === incidentId)
    if (!incident?.uuid) {
      toast('Инцидент ещё не сохранён на сервере')
      return
    }
    try {
      const result = await updateIncidentStatus(incident.uuid, newStatus)
      setIncidentsList((prev) => prev.map((item) => item.id === incidentId ? mapApiIncident(result) : item))
      toast(newStatus === 'Устранено' ? 'Повторная проверка запрошена' : `Статус: «${newStatus}»`)
      refreshAlerts().catch(() => {})
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Не удалось изменить статус')
    }
  }

  const handleAlertRead = (alert: AlertNotificationItem) => {
    if (alert.read_at) return
    markAlertRead(alert.id)
      .then(() => setAlertsList((prev) => prev.map((item) => item.id === alert.id ? { ...item, read_at: new Date().toISOString() } : item)))
      .catch(() => toast('Не удалось отметить алерт прочитанным'))
  }

  const handleAlertAction = async (alert: AlertNotificationItem, status: string) => {
    try {
      await updateIncidentStatus(alert.incident_id, status)
      await Promise.all([refreshAlerts(), refreshIncidents()])
      toast(status === 'resolved' ? 'Повторная проверка запрошена' : 'Статус инцидента обновлён')
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Не удалось обновить инцидент')
    }
  }

  const handleAlertSettingsSave = async (
    projectId: string,
    data: { owner_username: string | null; alert_error_deadline_minutes: number; alert_warning_deadline_minutes: number; escalation_user_id: string | null }
  ) => {
    const saved = await updateProjectAlertSettings(projectId, data)
    setProjectsList((prev) => prev.map((project) => project.id === projectId ? { ...project, ...saved } : project))
    toast('Настройки алертов сохранены')
  }

  const handleEmailSave = async (email: string | null) => {
    const user = await updateMyEmail(email)
    setCurrentUser(user)
    toast('Email для уведомлений сохранён')
  }

  // Reset detection observations when video or camera switches
  useEffect(() => {
    observationWindowsRef.current.clear()
    recentObservationsRef.current = []
    violationCooldownRef.current = {}
    detectedLabelsInWindowRef.current.clear()
    streamStartTimeRef.current = isStreamOnline ? Date.now() / 1000 : null
    latestSnapshotRef.current = null
    sourcesStateRef.current.clear()
  }, [uploadedVideoUrl, selectedCameraId, isStreamOnline, activeProjectId, activeZoneId])

  useEffect(() => {
    streamTransitionStateRef.current = null
    setCameraReportedOnline(false)
  }, [page])

  // A view remount is not evidence of a stream outage.
  useEffect(() => {
    if (page !== 'monitoring') { streamTransitionStateRef.current = null; return }

    const currentState: 'ONLINE' | 'OFFLINE' = isStreamOnline ? 'ONLINE' : 'OFFLINE'
    const prevState = streamTransitionStateRef.current

    if (prevState === currentState) return
    streamTransitionStateRef.current = currentState

    const { camera: curCamObj, zone: activeZoneObj } = observationScope(camerasList, activeZones, uploadedVideoUrl ? 'video-source' : curCam?.id, activeZoneId)
    const zoneName = activeZoneObj?.name || 'Без привязки к площадке'
    const camName = uploadedVideoName || curCamObj?.name || 'Видеозапись'
    const nowStr = new Date().toLocaleTimeString('ru-RU').slice(0, 5)

    if (prevState === null || !activeProjectId || !currentUser || currentUser.role === 'viewer') return

    if (prevState === 'OFFLINE' && currentState === 'ONLINE') {
      streamStartTimeRef.current = Date.now() / 1000
      detectedLabelsInWindowRef.current.clear()
      latestSnapshotRef.current = null

      const newId = `INC-${Math.floor(100 + Math.random() * 900)}`
      const newIncident: Incident = {
        id: newId,
        projectId: activeProjectId,
        zoneId: activeZoneObj?.id,
        createdAt: new Date().toISOString(),
        type: 'Видеопоток',
        title: 'Видеопоток активен',
        zone: zoneName,
        camera: camName,
        time: nowStr,
        age: 'Только что',
        priority: 'Низкий',
        status: 'В работе',
        assignee: 'Не назначен',
        sla: '10 мин',
        confidence: 100,
        note: uploadedVideoName
          ? `Запущена обработка видеозаписи «${uploadedVideoName}». Контроль техники активен.`
          : `Видеопоток с камеры «${camName}» успешно подключен. Автоматический контроль техники запущен.`,
        severity: 'WARNING',
        discrepancyType: 'STREAM_ONLINE',
      }
      toast(uploadedVideoName ? `Видео «${uploadedVideoName}» активно: детекция техники запущена` : 'Видеопоток активен: детекция техники запущена')
      createIncident({
        project_id: activeProjectId,
        zone_id: activeZoneObj?.id,
        camera_id: curCamObj?.id,
        captured_at: newIncident.createdAt,
        title: newIncident.title,
        description: newIncident.note,
        severity: 'WARNING',
        discrepancy_type: 'STREAM_ONLINE',
        zone_name: zoneName,
        camera_name: camName,
      }).then((saved) => setIncidentsList(prev => upsertIncident(prev, { ...newIncident, id: saved.code, uuid: saved.id, apiId: saved.id, assignedUserId: saved.assigned_user_id, slaDeadline: saved.sla_deadline, verificationStatus: saved.verification_status, escalatedAt: saved.escalated_at, projectId: saved.project_id, zoneId: saved.zone_id, createdAt: saved.first_seen_at || saved.created_at, status: mapApiStatus(saved.status), assignee: saved.assignee_name || 'Не назначен' }, newId))).catch(() => toast('Не удалось сохранить событие видеопотока'))
    } else if (prevState === 'ONLINE' && currentState === 'OFFLINE') {
      streamStartTimeRef.current = null
      detectedLabelsInWindowRef.current.clear()
      latestSnapshotRef.current = null

      const newId = `INC-${Math.floor(100 + Math.random() * 900)}`
      const newIncident: Incident = {
        id: newId,
        projectId: activeProjectId,
        zoneId: activeZoneObj?.id,
        createdAt: new Date().toISOString(),
        type: 'Видеопоток',
        title: 'Потеря видеопотока',
        zone: zoneName,
        camera: camName,
        time: nowStr,
        age: 'Только что',
        priority: 'Высокий',
        status: 'В работе',
        assignee: 'Не назначен',
        sla: '15 мин',
        confidence: 100,
        note: 'Прекратилась трансляция видеопотока с объекта. Мониторинг строительной техники приостановлен.',
        severity: 'ERROR',
        discrepancyType: 'STREAM_LOST',
      }
      toast('Внимание: потерян видеопоток объекта')
      createIncident({
        project_id: activeProjectId,
        zone_id: activeZoneObj?.id,
        camera_id: curCamObj?.id,
        captured_at: newIncident.createdAt,
        title: newIncident.title,
        description: newIncident.note,
        severity: 'ERROR',
        discrepancy_type: 'STREAM_LOST',
        zone_name: zoneName,
        camera_name: camName,
      }).then((saved) => setIncidentsList(prev => upsertIncident(prev, { ...newIncident, id: saved.code, uuid: saved.id, apiId: saved.id, assignedUserId: saved.assigned_user_id, slaDeadline: saved.sla_deadline, verificationStatus: saved.verification_status, escalatedAt: saved.escalated_at, projectId: saved.project_id, zoneId: saved.zone_id, createdAt: saved.first_seen_at || saved.created_at, status: mapApiStatus(saved.status), assignee: saved.assignee_name || 'Не назначен' }, newId))).catch(() => toast('Не удалось сохранить событие видеопотока'))
    }
  }, [page, isStreamOnline, activeZones, activeZoneId, camerasList, selectedCameraId, uploadedVideoName, toast])

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
      if (!isStreamOnline || !activeProjectId || !currentUser || currentUser.role === 'viewer') {
        streamStartTimeRef.current = null
        detectedLabelsInWindowRef.current.clear()
        return
      }

      const capturedAt = uploadedVideoUrl
        ? new Date(new Date(videoTimestamp).getTime() + timeSeconds * 1000)
        : new Date()
      if (!Number.isFinite(capturedAt.getTime())) return
      const nowSec = capturedAt.getTime() / 1000
      if (streamStartTimeRef.current === null || streamStartTimeRef.current > nowSec) {
        streamStartTimeRef.current = nowSec
      }

      const sId = sourceId || (uploadedVideoUrl ? 'video-source' : selectedCameraId || 'cam-01')
      const { camera: sourceCamera, zone: activeZoneObj } = observationScope(camerasList, activeZones, sId, activeZoneId)
      const scopeId = activeZoneObj?.id || sId
      const sName = sourceName || uploadedVideoName || sourceCamera?.name || 'Видеозапись'

      let sState = sourcesStateRef.current.get(sId)
      if (!sState) {
        sState = {
          sourceId: sId,
          sourceName: sName,
          snapshotUrl: snapshotDataUrl,
          detectedLabels: new Set<string>(),
          lastTimestamp: Date.now(),
          capturedAt: capturedAt.toISOString(),
        }
        sourcesStateRef.current.set(sId, sState)
      }
      if (snapshotDataUrl) {
        sState.snapshotUrl = snapshotDataUrl
        sState.lastTimestamp = Date.now()
        sState.capturedAt = capturedAt.toISOString()
        latestSnapshotRef.current = snapshotDataUrl
      }
      for (const d of dets) {
        if (d.conf >= 60 && d.label) {
          sState.detectedLabels.add(d.label)
        }
      }

      const windowSec = violationWindowSeconds || 30
      const windowStart = observationWindowsRef.current.get(scopeId)
      if (windowStart === undefined || windowStart > nowSec) { observationWindowsRef.current.set(scopeId, nowSec); return }
      const elapsedSec = nowSec - windowStart

      // Check after windowSec seconds have elapsed
      if (elapsedSec < windowSec) {
        return
      }

      // Reset window start timer for the next observation cycle
      observationWindowsRef.current.set(scopeId, nowSec)

      // Resolve active stage & analytical assumption (what machinery should be present)
      const activeStage = stages.find((stage) => new Date(stage.planned_start) <= capturedAt && capturedAt <= new Date(stage.planned_end))
      if (!activeStage || !confirmedRuleStageIds.includes(activeStage.id)) return
      const stageName = activeStage?.name || 'Монолитные конструкции'
      const rules = getEffectiveStageRules(activeStage)

      // Combine recent observations only within the source site.
      const scopeSources = [...sourcesStateRef.current.values()].filter(src => {
        if (Date.now() - src.lastTimestamp > windowSec * 1000) return false
        const sourceZone = observationScope(camerasList, activeZones, src.sourceId).zone
        return src.sourceId === sId || Boolean(activeZoneObj && sourceZone?.id === activeZoneObj.id)
      })
      const unifiedObservedMachinery = new Set<string>()
      for (const src of scopeSources) {
        for (const label of src.detectedLabels) {
          unifiedObservedMachinery.add(label)
        }
        src.detectedLabels.clear()
      }

      const zoneName = activeZoneObj?.name || 'Без привязки к площадке'
      const camName = sourceCamera?.name || sName
      const effectiveSnapshot = snapshotDataUrl || latestSnapshotRef.current || ''

      // Keep the album within the source site; prefer its actual capture.
      const siteCameras = camerasList.filter(camera => scopeSources.some(src => src.sourceId === camera.id))
      const firstCamera = sourceCamera || siteCameras[0]
      const firstCameraId = firstCamera?.id || 'cam-01'

      const albumPhotos: { url: string; cameraName: string; isPrimary: boolean; capturedAt: string }[] = []
      const processedSources = new Set<string>()

      // Add recent camera snapshots from this site.
      siteCameras.forEach((cam) => {
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
            isPrimary: cam.id === firstCamera?.id,
            capturedAt: state.capturedAt,
          })
        }
      })

      // 2. Add any additional active stream or uploaded video source
      for (const src of scopeSources) {
        if (!processedSources.has(src.sourceId) && src.snapshotUrl) {
          albumPhotos.push({
            url: src.snapshotUrl,
            cameraName: src.sourceName,
            isPrimary: albumPhotos.length === 0,
            capturedAt: src.capturedAt,
          })
        }
      }

      if (albumPhotos.length === 0 && effectiveSnapshot) {
        albumPhotos.push({
          url: effectiveSnapshot,
          cameraName: camName,
          isPrimary: true,
          capturedAt: capturedAt.toISOString(),
        })
      }

      // Use the source camera snapshot as primary.
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
          projectId: activeProjectId,
          zoneId: activeZoneObj?.id,
          createdAt: capturedAt.toISOString(),
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
          confidence: 0,
          note: cleanNote,
          severity,
          snapshotUrl: firstCameraPhoto,
          albumPhotos,
          stageName,
          discrepancyType,
        }

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
          project_id: activeProjectId,
          stage_id: activeStage.id,
          zone_id: activeZoneObj?.id,
          camera_id: sourceCamera?.id,
          captured_at: capturedAt.toISOString(),
          model_status: 'valid',
          rule_version: 'legacy-stage-profile-v1',
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
            is_primary: p.isPrimary,
          })),
        })
          .then((saved) => {
            setActiveViolationAlert(prev => prev?.id === newId ? { ...prev, incidentId: saved.id } : prev)
            setCostCase(prev => prev?.clientId === newId ? { ...prev, incidentId: saved.id } : prev)
            const serverUrl = normalizeSnapshotUrl(saved.frame_snapshot_url || saved.snapshot_url)
            const serverAlbum = saved.album_photos?.map((p) => ({
              url: normalizeSnapshotUrl(p.url) || p.url,
              cameraName: p.camera_name,
              isPrimary: p.is_primary,
              capturedAt: p.captured_at,
            }))
            setIncidentsList(prev => upsertIncident(prev, {
              ...newIncident, id: saved.code, uuid: saved.id, apiId: saved.id, assignedUserId: saved.assigned_user_id, slaDeadline: saved.sla_deadline, verificationStatus: saved.verification_status, escalatedAt: saved.escalated_at, projectId: saved.project_id,
              zoneId: saved.zone_id, createdAt: saved.first_seen_at || saved.created_at,
              status: mapApiStatus(saved.status), manual_override: Boolean(saved.manual_override),
              assignee: saved.assignee_name || 'Не назначен',
              snapshotUrl: serverUrl || newIncident.snapshotUrl,
              albumPhotos: serverAlbum?.length ? serverAlbum : newIncident.albumPhotos,
            }, newId))
            void refreshAlerts().catch(() => {})
          })
          .catch(() => { setActiveViolationAlert(previous => previous?.id === newId ? null : previous); toast('Не удалось сохранить отклонение. Проверьте подключение.') })
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
      refreshAlerts,
      stageOverridesVersion,
      confirmedRuleStageIds,
      currentUser,
      activeZones,
      activeZoneId,
      camerasList,
      selectedCameraId,
      uploadedVideoUrl,
      uploadedVideoName,
      activeProjectId,
      refreshAlerts,
      videoTimestamp,
      toast,
    ]
  )

  const openCostCase = useCallback((id: string) => {
    const incident = incidentsList.find(item => item.uuid === id || item.id === id)
    if (!incident) return
    if (incident.projectId) setActiveProjectId(incident.projectId)
    if (activeZoneId !== 'all' && incident.zoneId !== activeZoneId) setActiveZoneId('all')
    setHighlightedIncidentId(incident.id)
    setPage('reports')
    setCostCase(null)
    requestAnimationFrame(() => {
      const card = document.getElementById(`report-item-${incident.id}`)
      card?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      card?.focus({ preventScroll: true })
    })
  }, [incidentsList, activeZoneId])

  const title = titles[page] ?? titles.monitoring

  const pageBody = useMemo(() => {
    switch (page) {
      case 'management':
        return <CaseCostsPanel key={`${currentUser?.username}:${activeProject?.id}:${activeZoneId}`} incidents={scopedIncidents} projectId={activeProject?.id} zoneId={activeZoneId} onOpenCase={incident => openCostCase(incident.uuid || incident.id)} />
      case 'monitoring':
        return (
          <Monitoring
            rulesLoading={rulesLoading}
            onRetryRules={() => setStageOverridesVersion(version => version + 1)}
            confirmedRuleStageIds={confirmedRuleStageIds}
            canManage={allowedNav.some(item => item.id === 'settings')}
            activeProject={activeProject}
            activeZones={activeZones}
            camerasList={scopedCameras}
            selectedCameraId={selectedCameraId}
            setSelectedCameraId={id => { setCameraReportedOnline(false); streamTransitionStateRef.current = null; setSelectedCameraId(id) }}
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
            incidents={scopedIncidents}
            violationWindowSeconds={violationWindowSeconds}
            highlightedIncidentId={highlightedIncidentId}
            onNavigateToReport={openCostCase}
            onStatusChange={currentUser?.role === 'viewer' ? undefined : handleIncidentStatusChange}
            toast={toast}
          />
        )
      case 'progress':
        return (
          <Progress key={activeProjectId}
            stages={stages}
            setStages={setStages}
            activeProjectId={activeProjectId}
            navigate={allowedNav.some(item => item.id === 'analytics') ? setPage : undefined}
            toast={toast}
          />
        )
      case 'analytics':
        return (
          <Analytics key={activeProjectId}
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
            onOpenCase={openCostCase}
            incidents={scopedIncidents}
            highlightedIncidentId={highlightedIncidentId}
            onNavigateToArchive={(id) => {
              setHighlightedIncidentId(id)
              setPage('archive')
            }}
            onStatusChange={currentUser?.role === 'viewer' ? undefined : handleIncidentStatusChange}
            toast={toast}
          />
        )
      case 'alerts':
        return (
          <AlertCenter
            key={currentUser?.id}
            error={alertsError}
            onRetry={() => { setAlertsLoading(true); void refreshAlerts().catch(() => {}) }}
            canAct={currentUser?.role !== 'viewer'}
            canOpen={alert => userVisibleProjects.some(project => project.id === alert.project_id)}
            alerts={alertsList}
            loading={alertsLoading}
            onRead={handleAlertRead}
            onAction={handleAlertAction}
            onOpen={(alert) => {
              setActiveProjectId(alert.project_id)
              setActiveZoneId('all')
              setHighlightedIncidentId(alert.incident_code)
              setPage('reports')
            }}
          />
        )
      case 'settings':
        return (
          <Settings
            activeProject={activeProject}
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
            currentUser={currentUser}
            adminRecipients={adminRecipients}
            onSaveAlertSettings={handleAlertSettingsSave}
            onSaveEmail={handleEmailSave}
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
    alertsList,
    alertsLoading,
    alertsError,
    adminRecipients,
    currentUser,
    violationWindowSeconds,
    highlightedIncidentId,
    handleFrameAnalysis,
    openCostCase,
    activeZoneId,
    scopedCameras,
    scopedIncidents,
    confirmedRuleStageIds,
    rulesLoading,
    allowedNav,
    currentUser,
  ])

  if (isAuthChecking) return <div className="auth-loading"><img className="product-logo auth-logo" src={productLogo} alt="Строй-контроль"/><p>Загрузка рабочей области…</p></div>

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
          <div className="auth-brand"><img className="product-logo auth-logo" src={productLogo} alt="Строй-контроль"/></div>

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
    <div className={`app-shell product-shell ${collapsed ? 'nav-collapsed' : ''}`}>
      <aside id="product-navigation" inert={isSmallScreen && !mobileNav} className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}>
        <div className="brand"><span className="product-logo-wrap"><img className="product-logo" src={productLogo} alt="Строй-контроль"/></span>
          <button className="collapse" aria-label={collapsed ? 'Раскрыть меню' : 'Свернуть меню'} onClick={() => setCollapsed(!collapsed)}><Icon name="chevron" size={15}/></button>
        </div>
        <nav aria-label="Основная навигация">{allowedNav.filter(item => ['management','monitoring','progress','reports'].includes(item.id)).map(item =>
          <button key={item.id} aria-label={item.label} aria-current={page === item.id ? 'page' : undefined} title={collapsed ? item.label : undefined} className={page === item.id ? 'active' : ''}
            onClick={() => { setPage(item.id); setMobileNav(false) }}><Icon name={item.icon}/>{(!collapsed || mobileNav) && <span>{item.label}</span>}</button>)}</nav>
        <div className="sidebar-foot">
          <details className="shell-secondary"><summary aria-label="Дополнительно" title={collapsed ? 'Дополнительно' : undefined}><Icon name="layers" size={18}/>{(!collapsed || mobileNav) && <span>Дополнительно</span>}</summary>
            <nav aria-label="Дополнительные разделы">{allowedNav.filter(item => ['archive','analytics','alerts'].includes(item.id)).map(item => <button key={item.id} aria-label={item.label} className={page === item.id ? 'active' : ''}
              onClick={() => { setPage(item.id); setMobileNav(false) }}><Icon name={item.icon}/>{(!collapsed || mobileNav) && <span>{item.label}</span>}</button>)}</nav>
          </details>
          {allowedNav.some(item => item.id === 'settings') && <button className={`shell-settings${page === 'settings' ? ' active' : ''}`} aria-label="Настройки" onClick={() => { setPage('settings'); setMobileNav(false) }}><Icon name="settings"/>{(!collapsed || mobileNav) && <span>Настройки</span>}</button>}
        </div>
      </aside>
      {mobileNav && <button className="nav-backdrop" aria-label="Закрыть меню" onClick={() => setMobileNav(false)}/>}
      <div className="workspace">
        <header className="topbar">
          <button className="mobile-menu icon-button" aria-label="Открыть меню" aria-controls="product-navigation" aria-expanded={mobileNav} onClick={() => setMobileNav(true)}><Icon name="menu"/></button>
          <label className="shell-project-picker"><span className="sr-only">Объект</span><select aria-label="Объект" value={activeProjectId || ''} disabled={projectsLoading || !userVisibleProjects.length}
            onChange={event => { setActiveProjectId(event.target.value); setActiveZoneId('all'); setCostCase(null) }}>
            {!userVisibleProjects.length && <option value="">{projectsLoading ? 'Загрузка объектов…' : 'Нет объектов'}</option>}
            {userVisibleProjects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select></label>
          {activeZones.length > 0 && ['management','monitoring','archive','reports'].includes(page) && <label className="shell-zone-picker"><span className="sr-only">Площадка</span><select aria-label="Площадка" value={activeZoneId || 'all'}
            onChange={event => { setActiveZoneId(event.target.value); setSelectedCameraId(null); setCameraReportedOnline(false); streamTransitionStateRef.current = null; setCostCase(null) }}>
            <option value="all">Все площадки</option>{activeZones.map(zone => <option key={zone.id} value={zone.id}>{zone.name}</option>)}
          </select></label>}
          <div className="topbar-spacer"/>
          <button className="shell-alert-bell" aria-label={`Уведомления: ${alertsList.filter(item => !item.read_at).length} новых`} title="Задачи и уведомления" onClick={() => setPage('alerts')}><Icon name="bell" size={18}/>{alertsList.some(item => !item.read_at) && <span className="shell-alert-dot"/>}</button>
          <div className="shell-user"><button className="avatar shell-avatar" aria-label="Меню пользователя" aria-expanded={isUserMenuOpen} title={currentUser.username} onClick={() => setIsUserMenuOpen(value => !value)}>{currentUser.username.slice(0,2).toUpperCase()}</button>
            {isUserMenuOpen && <div className="shell-user-menu"><strong>{currentUser.name || currentUser.username}</strong><small>{{ admin:'Администратор', manager:'Руководитель', inspector:'Инспектор', viewer:'Наблюдатель' }[currentUser.role] || currentUser.role}</small><button className="button" onClick={handleLogout}>Выйти</button></div>}
          </div>
        </header>
        {page !== 'management' && <div className="page-heading"><h1>{title[0]}</h1></div>}
        <div className="page-content">
          {page === 'alerts' ? pageBody : projectsError ? <div className="workspace-state" role="alert"><h2>{projectsError}</h2><button className="button" onClick={() => void loadProjectsForUser(currentUser)}>Повторить</button></div>
            : projectsLoading ? <div className="workspace-state" role="status">Загрузка объектов…</div>
            : !activeProject ? <div className="workspace-state"><h2>Добавьте первый объект</h2>{allowedNav.some(item => item.id === 'settings') ? <button className="button primary" onClick={() => setIsCreateProjectOpen(true)}>Создать объект</button> : <p>Обратитесь к владельцу рабочей области.</p>}</div>
            : <>
              {workspaceError && <div className="workspace-error" role="alert">{workspaceError}<button className="button" onClick={() => setWorkspaceRevision(value => value + 1)}>Повторить</button></div>}
              {['management','archive','reports'].includes(page) && incidentsError ? <div className="workspace-state" role="alert"><h2>{incidentsError}</h2><button className="button" onClick={() => setIncidentsRevision(value => value + 1)}>Повторить</button></div>
                : ['management','archive','reports'].includes(page) && incidentsLoading ? <div className="workspace-state" role="status">Загрузка событий…</div>
                : workspaceLoading && ['monitoring','progress','analytics','settings'].includes(page) ? <div className="workspace-state" role="status">Загрузка данных объекта…</div> : pageBody}
            </>}
        </div>
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
              <label>Широта для прогноза<input name="prj_latitude" type="number" min="-90" max="90" step="any" placeholder="55.7558" /></label>
              <label>Долгота для прогноза<input name="prj_longitude" type="number" min="-180" max="180" step="any" placeholder="37.6173" /></label>
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

      {costCase && <IncidentCostDialog incidentId={costCase.incidentId} title={costCase.title} onClose={closeCostCase} onOpenCase={costCase.incidentId ? () => openCostCase(costCase.incidentId!) : undefined} />}

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
            <button type="button" className="case-cost-button" onClick={() => setCostCase({ incidentId: activeViolationAlert.incidentId, clientId: activeViolationAlert.id, title: activeViolationAlert.title })}>Цена бездействия</button>
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
