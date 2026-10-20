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
 * A camera whose frames repeat a recording (lib/loop.ts) is "looped": its frames stop counting
 * for the site until the repetition ends.
 * Camera view: every frame of a camera with an approved view is compared with it (lib/view.ts).
 * A camera that looks away for VIEW_BAD_FRAMES frames in a row is "changed", and its frames stop
 * counting for the site until it matches again; an agreed move pauses the comparison.
 *
 * Analysis runs in this browser tab. The UI says so; continuous server-side collection is a
 * separate backend task.
 *
 */
import * as api from './api'
import { toObservationCode } from '../domain/constructionObservations'
import type { CameraItem, CameraViewState } from './api'
import { CODES, toCode, type Code } from './lib/machinery'
import { LOOP_H, LOOP_W, LoopDetector, loopGray } from './lib/loop'
import { SHARP_H, SHARP_W, VIEW_H, VIEW_W, compareViews, judgeView, viewBlocked, viewFeatures, type ViewFeatures, type ViewMatch, type ViewProblem } from './lib/view'
import type { Det, Observation, SourceView, ViewCheck } from './model'

const CAPTURE_EVERY = 2000
const OFFLINE_AFTER_FAILS = 3
const STALE_AFTER_SAME = 15 // identical frames in a row (~30 s)
const COVER_GAP = 10_000 // frames closer than this (at ×1) belong to one continuous watch
const RETRY_OFFLINE = 10_000
const MAX_DETS = 20_000
const VIEW_BAD_FRAMES = 8 // ~16 s of a different picture: a truck that stops in front of the camera drives on sooner
const VIEW_GOOD_FRAMES = 3

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
/** What the server says about a camera's view, and the reference prepared for comparison. */
interface ViewRef {
  url: string | null
  at?: number
  by?: string | null
  ref?: ViewFeatures
  failed?: boolean
  moveUntil?: number
  moveBy?: string | null
}
interface ViewTrack {
  state: ViewCheck['state']
  since?: number
  bad: number
  good: number
  firstBad?: number
  problem?: ViewProblem
  last?: ViewMatch
  before?: string
  beforeAt?: number
  url?: string | null
}

export class Engine {
  mode: 'live' | 'recording' = 'live'
  model: 'unknown' | 'ready' | 'down' = 'unknown'
  complianceEnabled = false
  evaluableClasses: Code[] = []
  modelMessage?: string
  modelSince?: number
  frames = 0
  conf = 60
  windowMs = 30_000
  stageName?: string
  safetyProjectId?: string
  safetyRecordingCameraId?: string
  private safetySession = Math.random().toString(36).slice(2)
  private generation = 0
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
  private loops = new Map<string, LoopDetector>()
  /** small copies of past frames: the evidence of what a looped camera repeats */
  private thumb = document.createElement('canvas')
  private viewRefs = new Map<string, ViewRef>()
  private viewTracks = new Map<string, ViewTrack>()
  private vBig = document.createElement('canvas')
  private vSmall = document.createElement('canvas')
  viewOk = 0.6
  viewBad = 0.45

  constructor() {
    this.tiny.width = LOOP_W
    this.tiny.height = LOOP_H
    this.thumb.width = 320
    this.thumb.height = 180
    this.vBig.width = SHARP_W
    this.vBig.height = SHARP_H
    this.vSmall.width = VIEW_W
    this.vSmall.height = VIEW_H
  }

  /** A camera frame against the last half hour of the same camera: does it replay a recording? */
  private watchLoop(rt: Rt, el: CanvasImageSource, px: Uint8ClampedArray, at: number) {
    let det = this.loops.get(rt.view.id)
    if (!det) this.loops.set(rt.view.id, (det = new LoopDetector()))
    const t = this.thumb.getContext('2d')!
    t.drawImage(el, 0, 0, 320, 180)
    const s = det.push(at, loopGray(px), this.thumb.toDataURL('image/jpeg', 0.6))
    rt.view.loop = s.looped ? { looped: true, period: s.period, since: s.since, thenAt: s.then?.at, thenSnap: s.then?.snap, closeness: s.closeness } : undefined
  }

  /* camera views: the approved reference of each camera and agreed moves, as the server has them */
  setViews(states: CameraViewState[]) {
    const seen = new Set<string>()
    for (const st of states) {
      seen.add(st.camera_id)
      const old = this.viewRefs.get(st.camera_id)
      const url = st.reference?.url ?? null
      const move = st.move?.status === 'approved' ? st.move : null
      const next: ViewRef = {
        url,
        at: st.reference?.at ? new Date(st.reference.at).getTime() : undefined,
        by: st.reference?.by,
        ref: old && old.url === url ? old.ref : undefined,
        failed: old && old.url === url ? old.failed : false,
        moveUntil: move ? new Date(move.until).getTime() : undefined,
        moveBy: move ? move.approved_by || move.by : undefined,
      }
      this.viewRefs.set(st.camera_id, next)
      if (url && !next.ref && !next.failed && (!old || old.url !== url)) this.loadRef(st.camera_id, url)
      if (old?.url !== url) this.viewTracks.delete(st.camera_id)
      if (st.match_ok) this.viewOk = st.match_ok
      if (st.match_bad) this.viewBad = st.match_bad
    }
    for (const id of [...this.viewRefs.keys()]) if (!seen.has(id)) this.viewRefs.delete(id)
    for (const rt of this.rts.values()) this.showView(rt)
    this.emit()
  }
  private async loadRef(id: string, url: string) {
    try {
      const bmp = await api.viewImage(url)
      try {
        const r = this.viewRefs.get(id)
        if (!r || r.url !== url) return
        r.ref = this.featuresOf(bmp, bmp.width, bmp.height)
      } finally {
        bmp.close()
      }
    } catch {
      const r = this.viewRefs.get(id)
      if (r && r.url === url) r.failed = true
    }
    const rt = this.rts.get(id)
    if (rt) this.showView(rt)
    this.emit()
  }
  private featuresOf(el: CanvasImageSource, w: number, h: number) {
    const big = this.vBig.getContext('2d', { willReadFrequently: true })!
    big.imageSmoothingQuality = 'high'
    big.drawImage(el, 0, 0, w, h, 0, 0, SHARP_W, SHARP_H)
    const small = this.vSmall.getContext('2d', { willReadFrequently: true })!
    small.imageSmoothingQuality = 'high'
    small.drawImage(this.vBig, 0, 0, VIEW_W, VIEW_H)
    return viewFeatures(small.getImageData(0, 0, VIEW_W, VIEW_H).data, big.getImageData(0, 0, SHARP_W, SHARP_H).data)
  }
  /** One frame of a camera against its approved view. */
  private judgeFrame(rt: Rt, el: CanvasImageSource, w: number, h: number, snapshot: string, at: number) {
    const id = rt.view.id
    const r = this.viewRefs.get(id)
    let tr = this.viewTracks.get(id)
    if (!tr || tr.url !== r?.url) this.viewTracks.set(id, (tr = { state: 'none', bad: 0, good: 0, url: r?.url }))
    if (!r?.url || !r.ref || (r.moveUntil != null && r.moveUntil > Date.now())) return
    const cur = this.featuresOf(el, w, h)
    const m = compareViews(r.ref, cur)
    const j = judgeView(r.ref, cur, m, this.viewOk, this.viewBad)
    tr.last = m
    if (j.verdict === 'ok') {
      tr.good++
      tr.bad = 0
      tr.firstBad = undefined
      tr.before = snapshot
      tr.beforeAt = at
      if (tr.state !== 'ok' && (tr.state !== 'changed' || tr.good >= VIEW_GOOD_FRAMES)) {
        tr.state = 'ok'
        tr.since = at
      }
    } else if (j.verdict === 'bad') {
      tr.bad++
      tr.good = 0
      tr.firstBad ??= at
      tr.problem = j.problem
      if (tr.state !== 'changed' && tr.bad >= VIEW_BAD_FRAMES) {
        tr.state = 'changed'
        tr.since = tr.firstBad
      }
    } else if (tr.state === 'none') tr.state = 'pending'
  }
  private showView(rt: Rt) {
    if (rt.view.kind !== 'camera') return
    const r = this.viewRefs.get(rt.view.id)
    const tr = this.viewTracks.get(rt.view.id)
    if (!r) {
      rt.view.view = undefined
      return
    }
    const moving = r.moveUntil != null && r.moveUntil > Date.now()
    const state: ViewCheck['state'] = !r.url ? 'none' : moving ? 'move' : !r.ref || !tr || tr.state === 'none' ? 'pending' : tr.state
    const shifted = tr?.last && tr.last.best >= 0.7 ? tr.last : undefined
    rt.view.view = {
      state,
      refUrl: r.url ?? undefined,
      refAt: r.at,
      refBy: r.by,
      problem: state === 'changed' ? tr?.problem : undefined,
      match: !moving ? tr?.last?.match : undefined,
      dx: shifted?.dx,
      dy: shifted?.dy,
      since: state === 'ok' || state === 'changed' ? tr?.since : undefined,
      before: tr?.before,
      beforeAt: tr?.beforeAt,
      moveUntil: moving ? r.moveUntil : undefined,
      moveBy: moving ? r.moveBy : undefined,
    }
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
    this.generation++
    clearInterval(this.timer)
    clearInterval(this.statusTimer)
    this.timer = 0
    this.statusTimer = 0
  }
  /** Forget everything: used when the object changes. */
  reset() {
    this.generation++
    this.safetyProjectId = undefined
    this.safetyRecordingCameraId = undefined
    this.stopRecording(false)
    for (const id of [...this.rts.keys()]) this.removeSource(id)
    this.cameras = []
    this.loops.clear()
    this.viewRefs.clear()
    this.viewTracks.clear()
    this.clearSession()
    this.emit()
  }
  dispose() {
    this.stop()
    this.reset()
    clearTimeout(this.emitPending)
    this.emitPending = 0
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

  setSafetyRecordingCamera(cameraId?: string) {
    this.safetyRecordingCameraId = cameraId
    this.safetySession = Math.random().toString(36).slice(2)
    this.generation++
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
    this.showView(rt)
  }
  private removeSource(id: string) {
    const rt = this.rts.get(id)
    if (!rt) return
    if (rt.el instanceof HTMLImageElement) rt.el.removeAttribute('src')
    rt.el?.remove()
    this.rts.delete(id)
    this.loops.delete(id)
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
    this.safetySession = Math.random().toString(36).slice(2)
    this.generation++
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
    const generation = this.generation
    rt.inFlight = true
    rt.lastCapture = Date.now()
    try {
      const frame = await api.grabFrame(rt.view.url!)
      rt.inFlight = false
      try {
        if (generation !== this.generation || this.rts.get(rt.view.id) !== rt) return
        this.capture(rt, frame)
      } finally {
        frame.removeAttribute('src') // closes the stream connection, including a discarded frame
      }
    } catch (e) {
      rt.inFlight = false
      if (generation !== this.generation || this.rts.get(rt.view.id) !== rt) return
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
    tctx.drawImage(el, 0, 0, LOOP_W, LOOP_H)
    const px = tctx.getImageData(0, 0, LOOP_W, LOOP_H).data
    let hash = 0
    for (let i = 0; i < px.length; i += 4) hash = (Math.imul(hash, 31) + px[i] + px[i + 1] * 3 + px[i + 2] * 7) >>> 0
    const playing = !isVideo || !el.paused
    if (hash === rt.hash && playing) rt.same++
    else rt.same = 0
    rt.hash = hash
    if (rt.same >= STALE_AFTER_SAME && !isVideo) this.setStatus(rt, 'stale', 'Кадр не меняется больше 30 секунд.')
    else if (rt.view.status !== 'live') this.setStatus(rt, 'live')

    const at = this.now()
    const generation = this.generation
    const cameraId = isVideo ? this.safetyRecordingCameraId : rt.view.id
    const safety = this.safetyProjectId && cameraId ? { projectId: this.safetyProjectId, cameraId, sourceId: `${this.safetySession}:${rt.view.id}`, positionMs: at, recordingMode: isVideo } : undefined
    rt.view.snapshot = snapshot
    rt.view.lastFrame = at
    rt.fails = 0
    // the visible picture is the analysed frame itself
    if (source && rt.el instanceof HTMLImageElement) rt.el.src = snapshot
    if (!isVideo) {
      this.watchLoop(rt, el, px, at)
      this.judgeFrame(rt, el, w0, h0, snapshot, at)
      this.showView(rt)
    }
    // a camera that replays a recording, looks away or is being moved says nothing about the site
    if (rt.view.loop?.looped || viewBlocked(rt.view)) {
      rt.view.dets = []
      rt.lastAnalyzed = Date.now()
      this.emit()
      return
    }
    rt.inFlight = true
    this.canvas.toBlob(
      (blob) => {
        if (!blob || generation !== this.generation || this.rts.get(rt.view.id) !== rt) {
          rt.inFlight = false
          return
        }
        api
          .detectFrame(blob, this.stageName, safety)
          .then((res) => {
            if (generation !== this.generation || this.rts.get(rt.view.id) !== rt) return
            if (!res.model_ready) {
              this.setModel('down', res.message || 'модель не загружена')
              rt.view.dets = []
              return
            }
            this.setCompliance(res)
            this.setModel('ready')
            const dets: Det[] = []
            for (const d of res.detections) {
              const code = toObservationCode(d.canonical_code) ?? toObservationCode(d.raw_label)
              if (!code || d.confidence * 100 < this.conf) continue
              dets.push({ code, c: d.confidence, x: d.x1, y: d.y1, w: d.x2 - d.x1, h: d.y2 - d.y1 })
              const stageCode = toCode(code)
              if (stageCode) this.record(stageCode, { at, src: rt.view.id, c: d.confidence })
            }
            rt.view.dets = dets
            rt.lastAnalyzed = Date.now()
            this.frames++
            this.addCoverage(at)
          })
          .catch((e: unknown) => {
            if (generation !== this.generation || this.rts.get(rt.view.id) !== rt) return
            const msg = e instanceof Error ? e.message : 'сервис не ответил'
            rt.view.dets = []
            this.setModel('down', msg)
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

  private setModel(state: 'ready' | 'down', message?: string) {
    if (this.model !== state) this.modelSince = this.now()
    this.model = state
    if (state === 'down') {
      this.complianceEnabled = false
      this.evaluableClasses = []
      for (const rt of this.rts.values()) rt.view.dets = []
    }
    this.modelMessage = state === 'ready' ? undefined : message
    this.emit()
  }

  private setCompliance(response: { compliance_enabled?: boolean; evaluable_classes?: string[] }) {
    const enabled = response.compliance_enabled === true
    const classes = enabled ? (response.evaluable_classes ?? []).flatMap(c => { const code = toCode(c); return code ? [code] : [] }).sort() : []
    if (enabled !== this.complianceEnabled || classes.join(',') !== this.evaluableClasses.join(',')) {
      // Coverage collected under another permission cannot establish qualified absence.
      this.cov = []
      this.dets.clear()
    }
    this.complianceEnabled = enabled
    this.evaluableClasses = classes
  }

  private async pollStatus() {
    const generation = this.generation
    try {
      const s = await api.detectorStatus()
      if (generation !== this.generation) return
      this.setCompliance(s)
      if (!s.ready) this.setModel('down', s.message || 'модель не загружена')
      else if (this.model !== 'ready') this.setModel('ready')
    } catch (e) {
      if (generation !== this.generation) return
      this.setModel('down', e instanceof Error ? e.message : 'сервис не ответил')
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
      complianceEnabled: this.complianceEnabled,
      evaluableClasses: [...this.evaluableClasses],
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
