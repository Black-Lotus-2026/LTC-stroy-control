/*
 * Observation engine: grabs frames from every source, sends them to the detector and keeps
 * a session record of what was seen and when the system was actually watching.
 *
 * Honesty rules built in:
 * - a source is "live" only while frames arrive and change; RTSP is reported as unsupported
 *   instead of being replaced with a picture;
 * - detections count only when the model answered model_ready=true;
 * - "coverage" is the time we really analysed frames; absence is never inferred outside it.
 *
 * Analysis runs in this browser tab. The UI says so; continuous server-side collection is a
 * separate backend task.
 *
 * Demo recognition: when the model is unavailable and demo mode is on, detections come from the
 * demo scene below instead of the detector. Everything downstream works the same way, and every
 * screen and event says that recognition is a demo.
 */
import * as api from './api'
import type { CameraItem } from './api'
import { CODES, toCode, type Code } from './lib/machinery'
import type { Det, Observation, SourceView } from './model'

const CAPTURE_EVERY = 2000
const OFFLINE_AFTER_FAILS = 3
const STALE_AFTER_SAME = 15 // identical frames in a row (~30 s)
const COVER_GAP = 10_000 // frames closer than this (at ×1) belong to one continuous watch
const RETRY_OFFLINE = 10_000
const MAX_DETS = 20_000

interface Rt {
  view: SourceView
  el: HTMLImageElement | HTMLVideoElement | null
  inFlight: boolean
  lastCapture: number
  lastAnalyzed: number
  fails: number
  same: number
  hash: number
  retryAt: number
}
interface Sight { at: number; src: string; c: number }

/* Demo scene: where machines stand on the project's demo frames (src/assets/construction-camera.png
   and its crops). Camera 1 is the overview, 2 the crane, 3 the west side of the pit. */
const DEMO_SCENE: Record<'overview' | 'crane' | 'west', Omit<Det, 'demo'>[]> = {
  overview: [
    { code: 'excavator', c: 0.93, x: 0.175, y: 0.38, w: 0.275, h: 0.32 },
    { code: 'tower_crane', c: 0.86, x: 0.528, y: 0.0, w: 0.05, h: 0.37 },
    { code: 'dump_truck', c: 0.89, x: 0.512, y: 0.5, w: 0.215, h: 0.235 },
  ],
  crane: [{ code: 'tower_crane', c: 0.94, x: 0.186, y: 0.0, w: 0.086, h: 0.64 }],
  west: [{ code: 'excavator', c: 0.91, x: 0.318, y: 0.236, w: 0.5, h: 0.582 }],
}

export class Engine {
  mode: 'live' | 'recording' = 'live'
  model: 'unknown' | 'ready' | 'down' | 'demo' = 'unknown'
  /** substitute demo detections when the model is unavailable */
  demo = true
  modelMessage?: string
  modelSince?: number
  frames = 0
  conf = 60
  windowMs = 30_000
  stageName?: string
  private rts = new Map<string, Rt>()
  private pool: HTMLDivElement | null = null
  private canvas = document.createElement('canvas')
  private tiny = document.createElement('canvas')
  private dets = new Map<Code, Sight[]>()
  private cov: [number, number][] = []
  private rec: { name: string; start: number; url: string; el: HTMLVideoElement; duration: number; ended: boolean } | null = null
  private listeners = new Set<() => void>()
  private timer = 0
  private statusTimer = 0
  private emitPending = 0
  private cameras: CameraItem[] = []

  constructor() {
    this.tiny.width = 96
    this.tiny.height = 54
  }

  /* lifecycle (idempotent, StrictMode-safe) */
  start() {
    if (!this.pool) {
      this.pool = document.createElement('div')
      this.pool.setAttribute('aria-hidden', 'true')
      Object.assign(this.pool.style, { position: 'fixed', left: '-10000px', top: '0', width: '320px', height: '180px', overflow: 'hidden', opacity: '0', pointerEvents: 'none' })
      document.body.appendChild(this.pool)
      for (const rt of this.rts.values()) if (rt.el && !rt.el.isConnected) this.pool.appendChild(rt.el)
    }
    if (!this.timer) this.timer = window.setInterval(() => this.tick(), 500)
    if (!this.statusTimer) {
      this.pollStatus()
      this.statusTimer = window.setInterval(() => this.pollStatus(), 20_000)
    }
  }
  stop() {
    clearInterval(this.timer)
    clearInterval(this.statusTimer)
    this.timer = 0
    this.statusTimer = 0
  }
  /** Forget everything: used when the object changes. */
  reset() {
    this.stopRecording(false)
    for (const id of [...this.rts.keys()]) this.removeSource(id)
    this.cameras = []
    this.clearSession()
    this.emit()
  }
  dispose() {
    this.stop()
    this.reset()
    this.pool?.remove()
    this.pool = null
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
  private emit() {
    if (this.emitPending) return
    this.emitPending = window.setTimeout(() => {
      this.emitPending = 0
      for (const fn of this.listeners) fn()
    }, 120)
  }

  now() {
    return this.rec ? this.rec.start + this.rec.el.currentTime * 1000 : Date.now()
  }

  /* sources */
  setCameras(cams: CameraItem[]) {
    this.cameras = cams
    if (this.mode === 'recording') return
    const keep = new Set(cams.map((c) => c.id))
    for (const id of [...this.rts.keys()]) if (!keep.has(id)) this.removeSource(id)
    cams.forEach((c, i) => {
      const existing = this.rts.get(c.id)
      if (existing && existing.view.url === c.stream_url) {
        existing.view.n = i + 1
        existing.view.name = c.name
        return
      }
      if (existing) this.removeSource(c.id)
      this.addCamera(c, i + 1)
    })
    this.emit()
  }
  private addCamera(c: CameraItem, n: number) {
    const url = (c.stream_url || '').trim()
    const protocol: SourceView['protocol'] = /^https?:\/\//i.test(url) ? 'http' : /^rtsp:\/\//i.test(url) ? 'rtsp' : 'other'
    const view: SourceView = { id: c.id, n, name: c.name, kind: 'camera', url, protocol, status: 'connecting', since: Date.now(), dets: [] }
    const rt: Rt = { view, el: null, inFlight: false, lastCapture: 0, lastAnalyzed: 0, fails: 0, same: 0, hash: 0, retryAt: 0 }
    if (protocol === 'rtsp') {
      view.status = 'unsupported'
      view.message = 'RTSP не воспроизводится в браузере. Нужен шлюз в MJPEG/HLS или серверный сбор кадров.'
    } else if (protocol === 'other') {
      view.status = 'unsupported'
      view.message = url ? 'Неизвестный тип адреса потока.' : 'У камеры не указан адрес потока.'
    } else {
      // frames are fetched one at a time through the server; the stream is never held open
      const img = new Image()
      img.decoding = 'async'
      img.className = 'f-media'
      img.draggable = false
      img.alt = ''
      rt.el = img
      this.pool?.appendChild(img)
    }
    this.rts.set(c.id, rt)
  }
  private removeSource(id: string) {
    const rt = this.rts.get(id)
    if (!rt) return
    if (rt.el instanceof HTMLImageElement) rt.el.removeAttribute('src')
    rt.el?.remove()
    this.rts.delete(id)
  }
  private setStatus(rt: Rt, status: SourceView['status'], message?: string) {
    if (rt.view.status !== status) rt.view.since = Date.now()
    rt.view.status = status
    rt.view.message = message
    this.emit()
  }

  /** The media element of a source, adopted by the visible frame. */
  element(id: string) {
    return this.rts.get(id)?.el ?? null
  }
  /** Return an adopted element to the hidden pool so it keeps streaming. */
  release(el: Element | null) {
    if (el && this.pool && el.parentElement !== this.pool) this.pool.appendChild(el)
  }

  /* recording mode: the observation clock follows the video */
  startRecording(file: File, start: number) {
    this.stopRecording(false)
    for (const id of [...this.rts.keys()]) this.removeSource(id)
    this.clearSession()
    const url = URL.createObjectURL(file)
    const el = document.createElement('video')
    el.src = url
    el.muted = true
    el.playsInline = true
    el.preload = 'auto'
    el.className = 'f-media'
    this.rec = { name: file.name, start, url, el, duration: 0, ended: false }
    this.mode = 'recording'
    const view: SourceView = { id: 'recording', n: 1, name: file.name, kind: 'video', protocol: 'file', status: 'connecting', since: Date.now(), dets: [] }
    const rt: Rt = { view, el, inFlight: false, lastCapture: 0, lastAnalyzed: 0, fails: 0, same: 0, hash: 0, retryAt: 0 }
    el.onloadeddata = () => {
      if (this.rec) this.rec.duration = el.duration * 1000
      this.setStatus(rt, 'live')
      el.play().catch(() => this.emit())
    }
    el.onerror = () => this.setStatus(rt, 'offline', 'Браузер не может воспроизвести этот файл.')
    el.onended = () => {
      if (this.rec) this.rec.ended = true
      this.emit()
    }
    el.onseeked = () => {
      rt.lastCapture = 0 // analyse the new position right away
      this.emit()
    }
    el.onplay = el.onpause = () => this.emit()
    this.rts.set('recording', rt)
    this.pool?.appendChild(el)
    this.emit()
  }
  stopRecording(resume = true) {
    if (!this.rec) return
    this.rec.el.pause()
    this.rec.el.removeAttribute('src')
    this.rec.el.load()
    URL.revokeObjectURL(this.rec.url)
    this.removeSource('recording')
    this.rec = null
    this.mode = 'live'
    this.clearSession()
    if (resume) this.setCameras(this.cameras)
    this.emit()
  }
  get recording() {
    return this.rec
  }
  seek(t: number) {
    if (!this.rec) return
    const sec = Math.max(0, Math.min(this.rec.el.duration || 0, (t - this.rec.start) / 1000))
    this.rec.el.currentTime = sec
    this.rec.ended = false
  }
  togglePlay() {
    if (!this.rec) return
    if (this.rec.el.paused) this.rec.el.play().catch(() => undefined)
    else this.rec.el.pause()
  }
  setRate(r: number) {
    if (this.rec) this.rec.el.playbackRate = r
    this.emit()
  }
  get rate() {
    return this.rec?.el.playbackRate ?? 1
  }

  private clearSession() {
    this.dets.clear()
    this.cov = []
    this.frames = 0
  }

  /* loop */
  private tick() {
    const wall = Date.now()
    for (const rt of this.rts.values()) {
      const v = rt.view
      if (v.status === 'unsupported' || v.status === 'idle' || !rt.el || rt.inFlight) continue
      if (rt.el instanceof HTMLImageElement) {
        const due = v.status === 'offline' ? wall >= rt.retryAt : wall - rt.lastCapture >= CAPTURE_EVERY
        if (due) this.pullFrame(rt)
        continue
      }
      if (rt.el instanceof HTMLVideoElement && rt.el.paused && rt.lastCapture) continue
      if (wall - rt.lastCapture >= CAPTURE_EVERY) this.capture(rt)
    }
    // a source that stopped producing analysed frames is no longer live
    for (const rt of this.rts.values()) {
      if (rt.view.status === 'live' && rt.lastAnalyzed && wall - rt.lastAnalyzed > 15_000 && !(rt.el instanceof HTMLVideoElement && rt.el.paused)) {
        this.setStatus(rt, 'offline', 'Кадры перестали поступать.')
        rt.retryAt = wall
      }
    }
    this.emit()
  }

  /** Camera: take one frame from the stream through the server proxy, show it, analyse it. */
  private async pullFrame(rt: Rt) {
    rt.inFlight = true
    rt.lastCapture = Date.now()
    try {
      const frame = await api.grabFrame(rt.view.url!)
      rt.inFlight = false
      this.capture(rt, frame)
      frame.removeAttribute('src') // closes the stream connection
    } catch (e) {
      rt.inFlight = false
      rt.fails++
      if (rt.fails >= OFFLINE_AFTER_FAILS || rt.view.status !== 'live') {
        this.setStatus(rt, 'offline', e instanceof Error ? e.message : 'Камера не отдала кадр.')
        rt.retryAt = Date.now() + RETRY_OFFLINE
      }
      this.emit()
    }
  }

  private capture(rt: Rt, source?: HTMLImageElement) {
    const el = source ?? rt.el!
    if (el instanceof HTMLVideoElement) rt.lastCapture = Date.now()
    const isVideo = el instanceof HTMLVideoElement
    const w0 = isVideo ? el.videoWidth : (el as HTMLImageElement).naturalWidth
    const h0 = isVideo ? el.videoHeight : (el as HTMLImageElement).naturalHeight
    if (!w0 || !h0 || (isVideo && el.readyState < 2)) {
      rt.fails++
      if (rt.fails >= OFFLINE_AFTER_FAILS && !isVideo) {
        this.setStatus(rt, 'offline', 'Камера не прислала ни одного кадра.')
        rt.retryAt = Date.now() + RETRY_OFFLINE
      }
      return
    }
    const scale = Math.min(1, 960 / w0)
    const w = Math.round(w0 * scale)
    const h = Math.round(h0 * scale)
    this.canvas.width = w
    this.canvas.height = h
    const ctx = this.canvas.getContext('2d')!
    let snapshot = ''
    try {
      ctx.drawImage(el, 0, 0, w, h)
      snapshot = this.canvas.toDataURL('image/jpeg', 0.72)
    } catch {
      this.setStatus(rt, 'offline', 'Браузер не может прочитать кадр: поток не разрешает чтение (CORS).')
      return
    }
    // a frozen stream keeps returning the same picture; that is not a live camera
    // fine enough that an on-screen camera clock changes it; a truly frozen stream does not
    const tctx = this.tiny.getContext('2d', { willReadFrequently: true })!
    tctx.drawImage(el, 0, 0, 96, 54)
    const px = tctx.getImageData(0, 0, 96, 54).data
    let hash = 0
    for (let i = 0; i < px.length; i += 4) hash = (Math.imul(hash, 31) + px[i] + px[i + 1] * 3 + px[i + 2] * 7) >>> 0
    const playing = !isVideo || !el.paused
    if (hash === rt.hash && playing) rt.same++
    else rt.same = 0
    rt.hash = hash
    if (rt.same >= STALE_AFTER_SAME && !isVideo) this.setStatus(rt, 'stale', 'Кадр не меняется больше 30 секунд.')
    else if (rt.view.status !== 'live') this.setStatus(rt, 'live')

    const at = this.now()
    rt.view.snapshot = snapshot
    rt.view.lastFrame = at
    rt.fails = 0
    // the visible picture is the analysed frame itself
    if (source && rt.el instanceof HTMLImageElement) rt.el.src = snapshot
    rt.inFlight = true
    this.canvas.toBlob(
      (blob) => {
        if (!blob) {
          rt.inFlight = false
          return
        }
        api
          .detectFrame(blob, this.stageName)
          .then((res) => {
            if (!res.model_ready) {
              if (this.demo) return this.demoFrame(rt, at, res.message || 'модель не загружена')
              this.setModel('down', res.message || 'модель не загружена')
              rt.view.dets = []
              return
            }
            this.setModel('ready')
            const dets: Det[] = []
            for (const d of res.detections) {
              const code = toCode(d.raw_label) ?? toCode(d.canonical_code)
              if (!code || d.confidence * 100 < this.conf) continue
              dets.push({ code, c: d.confidence, x: d.x1, y: d.y1, w: d.x2 - d.x1, h: d.y2 - d.y1 })
              this.record(code, { at, src: rt.view.id, c: d.confidence })
            }
            rt.view.dets = dets
            rt.lastAnalyzed = Date.now()
            this.frames++
            this.addCoverage(at)
          })
          .catch((e: unknown) => {
            const msg = e instanceof Error ? e.message : 'сервис не ответил'
            if (this.demo) this.demoFrame(rt, at, msg)
            else this.setModel('down', msg)
          })
          .finally(() => {
            rt.inFlight = false
            this.emit()
          })
      },
      'image/jpeg',
      0.8,
    )
  }

  private setModel(state: 'ready' | 'down' | 'demo', message?: string) {
    if (this.model !== state) this.modelSince = this.now()
    this.model = state
    this.modelMessage = state === 'ready' ? undefined : message
    this.emit()
  }

  /** The model is unavailable: answer from the demo scene so the stand can show the whole flow. */
  private demoFrame(rt: Rt, at: number, reason: string) {
    this.setModel('demo', reason)
    const scene = rt.view.kind === 'video' ? 'overview' : (['overview', 'crane', 'west'] as const)[(rt.view.n - 1) % 3]
    // the dump truck works ten minutes and leaves for six; in a recording it leaves after the first fifth
    const rec = this.rec
    const truck = rec ? at - rec.start < Math.max(30_000, 0.2 * (rec.duration || 0)) : Math.floor(at / 60_000) % 16 < 10
    const dets: Det[] = DEMO_SCENE[scene].filter((d) => d.code !== 'dump_truck' || truck).filter((d) => d.c * 100 >= this.conf).map((d) => ({ ...d, demo: true }))
    for (const d of dets) this.record(d.code, { at, src: rt.view.id, c: d.c })
    rt.view.dets = dets
    rt.lastAnalyzed = Date.now()
    this.frames++
    this.addCoverage(at)
  }
  private async pollStatus() {
    try {
      const s = await api.detectorStatus()
      if (!s.ready) this.setModel(this.demo ? 'demo' : 'down', s.message || 'модель не загружена')
      else if (this.model !== 'ready') this.setModel('ready')
    } catch (e) {
      this.setModel(this.demo ? 'demo' : 'down', e instanceof Error ? e.message : 'сервис не ответил')
    }
  }

  /* session record */
  private record(code: Code, s: Sight) {
    let arr = this.dets.get(code)
    if (!arr) this.dets.set(code, (arr = []))
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (arr[m].at <= s.at) lo = m + 1
      else hi = m
    }
    arr.splice(lo, 0, s)
    if (arr.length > MAX_DETS) arr.splice(0, arr.length - MAX_DETS)
  }
  /** Frames are taken every 2 s of wall time; at ×8 that is 16 s of filmed time. */
  private coverGap() {
    return COVER_GAP * Math.max(1, this.rec?.el.playbackRate ?? 1)
  }
  private addCoverage(at: number) {
    const COVER_GAP = this.coverGap()
    const c = this.cov
    let i = c.findIndex(([a, b]) => at >= a - COVER_GAP && at <= b + COVER_GAP)
    if (i < 0) {
      c.push([at, at])
      c.sort((x, y) => x[0] - y[0])
      i = c.findIndex(([a]) => a === at)
    } else {
      c[i][0] = Math.min(c[i][0], at)
      c[i][1] = Math.max(c[i][1], at)
    }
    // merge neighbours that now touch
    for (let k = c.length - 1; k > 0; k--) {
      if (c[k][0] - c[k - 1][1] <= COVER_GAP) {
        c[k - 1][1] = Math.max(c[k - 1][1], c[k][1])
        c.splice(k, 1)
      }
    }
  }
  private lastIndexAtOrBefore(arr: Sight[], t: number) {
    let lo = 0
    let hi = arr.length
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (arr[m].at <= t) lo = m + 1
      else hi = m
    }
    return lo - 1
  }

  liveSnapshots() {
    return [...this.rts.values()].filter((r) => r.view.status === 'live' && r.view.snapshot).map((r) => ({ name: r.view.name, snapshot: r.view.snapshot!, id: r.view.id }))
  }

  snapshot(): Observation {
    const rec = this.rec
    const sources = [...this.rts.values()].map((r) => ({ ...r.view, dets: [...r.view.dets] })).sort((a, b) => a.n - b.n)
    const dets = this.dets
    const cov = this.cov.map((x) => [...x] as [number, number])
    const lastIdx = (arr: Sight[], t: number) => this.lastIndexAtOrBefore(arr, t)
    const windowMs = this.windowMs
    const gap = this.coverGap()
    return {
      mode: this.mode,
      t: this.now(),
      sources,
      model: this.model,
      modelMessage: this.modelMessage,
      modelSince: this.modelSince,
      frames: this.frames,
      recording: rec ? { name: rec.name, start: rec.start, duration: rec.duration, paused: rec.el.paused, ended: rec.ended } : undefined,
      seenWithin: (code, t, win) => {
        const arr = dets.get(code)
        if (!arr) return []
        const best = new Map<string, number>()
        for (let i = lastIdx(arr, t); i >= 0 && arr[i].at > t - win; i--) best.set(arr[i].src, Math.max(best.get(arr[i].src) ?? 0, arr[i].c))
        return [...best].map(([src, c]) => ({ src, c }))
      },
      lastSeen: (code, t) => {
        const arr = dets.get(code)
        if (!arr) return null
        const i = lastIdx(arr, t)
        return i >= 0 ? arr[i].at : null
      },
      episodeStart: (code, t, gap) => {
        const arr = dets.get(code)
        if (!arr) return null
        let i = lastIdx(arr, t)
        if (i < 0) return null
        while (i > 0 && arr[i].at - arr[i - 1].at <= gap) i--
        return arr[i].at
      },
      coverageStart: (t) => {
        const iv = cov.find(([a, b]) => t >= a && t <= b + gap)
        return iv ? iv[0] : null
      },
      presence: (code) => {
        const arr = dets.get(code) || []
        const out: [number, number][] = []
        for (const s of arr) {
          const last = out[out.length - 1]
          if (last && s.at - last[1] <= windowMs) last[1] = s.at
          else out.push([s.at, s.at])
        }
        return out
      },
      coverage: () => {
        return cov
      },
    }
  }
}

export const ALL_CODES = CODES
