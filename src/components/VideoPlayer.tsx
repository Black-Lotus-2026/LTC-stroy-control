import React, { useEffect, useState } from 'react'
import {
  StageItem,
  VideoAsset,
  VideoSyncStatus,
  syncVideoPlayback,
  uploadVideoAsset,
} from '../api/stroyControlApi'

interface VideoPlayerProps {
  stages: StageItem[]
  activeStageId?: string | null
  onStageSynchronized?: (stageId: string | null) => void
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
  stages,
  onStageSynchronized,
}) => {
  const [selectedStream, setSelectedStream] = useState<string>('CAM-01')
  const [isPlaying, setIsPlaying] = useState<boolean>(true)
  const [playbackSeconds, setPlaybackSeconds] = useState<number>(0)
  const [isUploadModalOpen, setIsUploadModalOpen] = useState<boolean>(false)
  const [startTimestamp, setStartTimestamp] = useState<string>('2026-06-15 10:00:00')
  const [uploadedVideo, setUploadedVideo] = useState<VideoAsset | null>(null)
  const [syncStatus, setSyncStatus] = useState<VideoSyncStatus | null>(null)
  const [isUploading, setIsUploading] = useState<boolean>(false)

  // Simulation timer for playback offset
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined
    if (isPlaying) {
      interval = setInterval(() => {
        setPlaybackSeconds((prev) => (prev >= 300 ? 0 : prev + 1))
      }, 1000)
    }
    return () => clearInterval(interval)
  }, [isPlaying])

  // Sync with active stage whenever playback seconds change
  useEffect(() => {
    const videoId = uploadedVideo?.video_id || 'demo-video-asset'
    syncVideoPlayback(videoId, playbackSeconds).then((res) => {
      setSyncStatus(res)
      if (onStageSynchronized) {
        onStageSynchronized(res.active_stage_id || null)
      }
    })
  }, [playbackSeconds, uploadedVideo])

  const handleUploadSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const form = e.currentTarget
    const fileInput = form.elements.namedItem('video_file') as HTMLInputElement
    const file = fileInput?.files?.[0]
    if (!file) {
      alert('Пожалуйста, выберите видеофайл')
      return
    }

    setIsUploading(true)
    try {
      const res = await uploadVideoAsset(file, startTimestamp)
      setUploadedVideo(res)
      setSelectedStream('UPLOADED_DEMO')
      setPlaybackSeconds(0)
      setIsUploadModalOpen(false)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Ошибка загрузки видео'
      alert(errorMsg)
    } finally {
      setIsUploading(false)
    }
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 text-slate-100 shadow-2xl flex flex-col gap-4">
      {/* Stream Selector & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-3 w-3">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
            </span>
            <h3 className="font-bold text-sm text-white">Видеомониторинг стройплощадки</h3>
          </div>

          <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
            <button
              onClick={() => setSelectedStream('CAM-01')}
              className={`px-3 py-1 rounded-md transition-all ${
                selectedStream === 'CAM-01' ? 'bg-indigo-600 text-white font-semibold' : 'text-slate-400 hover:text-white'
              }`}
            >
              Камера 1 (Котлован / RTSP)
            </button>
            <button
              onClick={() => setSelectedStream('CAM-02')}
              className={`px-3 py-1 rounded-md transition-all ${
                selectedStream === 'CAM-02' ? 'bg-indigo-600 text-white font-semibold' : 'text-slate-400 hover:text-white'
              }`}
            >
              Камера 2 (Въезд / HLS)
            </button>
            {uploadedVideo && (
              <button
                onClick={() => setSelectedStream('UPLOADED_DEMO')}
                className={`px-3 py-1 rounded-md transition-all ${
                  selectedStream === 'UPLOADED_DEMO' ? 'bg-emerald-600 text-white font-semibold' : 'text-emerald-400 hover:text-white'
                }`}
              >
                📹 Загруженное демо-видео
              </button>
            )}
          </div>
        </div>

        <button
          onClick={() => setIsUploadModalOpen(true)}
          className="bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 shadow-sm"
        >
          <span>📤</span>
          <span>Загрузить видео с таймкодом</span>
        </button>
      </div>

      {/* Synchronized Stage Banner */}
      <div
        className={`px-4 py-2.5 rounded-lg text-xs border flex items-center justify-between transition-all ${
          syncStatus?.is_out_of_schedule
            ? 'bg-slate-950/80 border-slate-800 text-slate-400'
            : 'bg-emerald-950/30 border-emerald-500/40 text-emerald-300'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm">{syncStatus?.is_out_of_schedule ? '⏸' : '🏗️'}</span>
          <div>
            <span className="font-semibold text-slate-200">
              {syncStatus?.is_out_of_schedule
                ? 'Вне графика (межэтапный интервал):'
                : 'Синхронизированный этап СМР:'}
            </span>{' '}
            <span className="font-bold underline decoration-emerald-500/50">
              {syncStatus?.active_stage_name || 'Определение этапа...'}
            </span>
            {stages.length > 0 && syncStatus?.active_stage_id && (
              <span className="ml-2 text-[10px] text-slate-400">
                (из {stages.length} этапов плана)
              </span>
            )}
          </div>
        </div>

        <div className="text-[11px] font-mono text-slate-400">
          Время кадра: <span className="text-slate-200">{syncStatus?.current_timestamp.slice(0, 19).replace('T', ' ')}</span>
        </div>
      </div>

      {/* Video Viewport with High-Contrast Dark Canvas & Bounding Boxes */}
      <div className="relative aspect-video w-full bg-slate-950 rounded-xl overflow-hidden border border-slate-800 shadow-inner flex items-center justify-center group">
        {/* Mock/Live Video Content */}
        <div className="absolute inset-0 bg-gradient-to-br from-slate-950 via-slate-900 to-zinc-900 flex flex-col items-center justify-center p-6 text-center select-none">
          <div className="text-slate-600 mb-2 text-4xl">🎥</div>
          <div className="text-sm font-semibold text-slate-300 tracking-wide uppercase">
            {selectedStream === 'UPLOADED_DEMO'
              ? `Демо-запись: ${uploadedVideo?.filename}`
              : `Живой поток: ${selectedStream} (1080p @ 25 FPS)`}
          </div>
          <div className="text-xs text-slate-500 mt-1 font-mono">
            {selectedStream === 'CAM-01' && 'RTSP: rtsp://camera-crane-01.local/live'}
            {selectedStream === 'CAM-02' && 'HLS: https://camera-gate-02.local/stream.m3u8'}
            {selectedStream === 'UPLOADED_DEMO' && `Старт записи: ${uploadedVideo?.start_timestamp}`}
          </div>

          {/* Synthetic AI Detection Bounding Boxes Overlay */}
          <div className="absolute inset-0 pointer-events-none p-8 flex items-center justify-around">
            <div className="relative border-2 border-emerald-400 bg-emerald-500/10 rounded px-2 py-1 w-44 h-32 flex flex-col justify-between">
              <span className="bg-emerald-500 text-slate-950 text-[10px] font-bold px-1.5 py-0.5 rounded-sm self-start">
                Самосвал 94%
              </span>
              <span className="text-[9px] text-emerald-300 font-mono">ID: trk-04</span>
            </div>

            <div className="relative border-2 border-amber-400 bg-amber-500/10 rounded px-2 py-1 w-40 h-28 flex flex-col justify-between">
              <span className="bg-amber-500 text-slate-950 text-[10px] font-bold px-1.5 py-0.5 rounded-sm self-start">
                Погрузчик 88%
              </span>
              <span className="text-[9px] text-amber-300 font-mono">ID: trk-07</span>
            </div>
          </div>
        </div>

        {/* Video Controls Overlay */}
        <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent p-4 flex flex-col gap-2 opacity-90 group-hover:opacity-100 transition-opacity">
          {/* Timeline Scrubber */}
          <div className="flex items-center gap-3 text-xs font-mono">
            <span className="text-slate-300 w-12 text-right">
              {Math.floor(playbackSeconds / 60)}:{(playbackSeconds % 60).toString().padStart(2, '0')}
            </span>
            <input
              type="range"
              min={0}
              max={120}
              value={playbackSeconds}
              onChange={(e) => setPlaybackSeconds(Number(e.target.value))}
              className="w-full h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-indigo-500"
            />
            <span className="text-slate-400 w-12">02:00</span>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-300 pt-1">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setIsPlaying(!isPlaying)}
                className="bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1 rounded text-xs font-bold"
              >
                {isPlaying ? '⏸ Пауза' : '▶ Старт'}
              </button>
              <button
                onClick={() => setPlaybackSeconds(0)}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded text-xs"
              >
                ⏮ В начало
              </button>
            </div>

            <div className="flex items-center gap-3 text-[11px] font-mono text-slate-400">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full bg-emerald-400"></span>
                <span>Сэмплирование: 0.2 FPS (1 кадр / 5 сек)</span>
              </span>
              <span>Модель: YOLO 10-Class</span>
            </div>
          </div>
        </div>
      </div>

      {/* Upload Demo Video Modal */}
      {isUploadModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn">
          <form
            onSubmit={handleUploadSubmit}
            className="bg-slate-900 border border-slate-700 w-full max-w-md rounded-2xl p-6 shadow-2xl flex flex-col gap-4 text-slate-100"
          >
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="font-bold text-base text-white flex items-center gap-2">
                <span>📹</span>
                <span>Загрузка демонстрационного видео</span>
              </h3>
              <button
                type="button"
                onClick={() => setIsUploadModalOpen(false)}
                className="text-slate-400 hover:text-white text-lg"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              Укажите видеофайл и точную дату/время старта съёмки. Это позволит платформе синхронизировать
              воспроизведение с календарным графиком СМР и проверять требуемую спецтехнику.
            </p>

            <div className="flex flex-col gap-3 my-1">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">
                  Файл видеозаписи (.mp4, .mkv, .avi):
                </label>
                <input
                  type="file"
                  name="video_file"
                  accept="video/*"
                  required
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg p-2 text-xs text-slate-200 file:mr-3 file:py-1 file:px-2.5 file:rounded file:border-0 file:text-xs file:bg-slate-800 file:text-slate-200 hover:file:bg-slate-700"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">
                  Дата и время старта съёмки (YYYY-MM-DD HH:MM:SS):
                </label>
                <input
                  type="text"
                  value={startTimestamp}
                  onChange={(e) => setStartTimestamp(e.target.value)}
                  placeholder="2026-06-15 10:00:00"
                  required
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-indigo-500"
                />
                <span className="text-[10px] text-slate-500 mt-1 block">
                  Пример: 2026-06-15 10:00:00 (соответствует этапу выемки котлована в демо-графике)
                </span>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setIsUploadModalOpen(false)}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded-lg text-xs"
              >
                Отмена
              </button>
              <button
                type="submit"
                disabled={isUploading}
                className="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold px-4 py-2 rounded-lg text-xs shadow-md"
              >
                {isUploading ? 'Загрузка...' : 'Загрузить и привязать'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
