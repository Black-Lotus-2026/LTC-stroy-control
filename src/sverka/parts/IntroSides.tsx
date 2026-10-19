import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import * as api from '../api'
import type { CameraItem, ProjectItem, UserProfile } from '../api'
import { dayStart, durShort, fmtDay, hhmm, hhmmss, plural } from '../lib/format'
import { CODES, MACH, SIL, type Code } from '../lib/machinery'
import { RING_MEDIA } from '../lib/ring'
import { palette, rgba, theme } from '../lib/theme'
import { PARALLAX, type WireScene } from '../lib/wire'
import { awaitsDecision, loadLocalRules, loadSettings, stageAt, stageDay, toEvent, toProfile, toStages, type Level, type Stage, type UiEvent } from '../model'

/*
 * What fills the sides of a wide intro around the drawing; the variants were drawn up on
 * docs/ui-concept/intro-sides.html. All of them read the object the workspace opens (the last chosen,
 * else the first visible) and show only what the server knows: no cameras, no corners; no plan, the
 * plan column says so. Narrow and portrait screens have no room for sides and show none.
 */

export type Side = 'cams' | 'mach' | 'site' | 'data' | 'draw'
export const SIDES: { id: Side; label: string }[] = [
  { id: 'cams', label: 'Камеры' },
  { id: 'mach', label: 'Техника этапа' },
  { id: 'site', label: 'Площадка' },
  { id: 'data', label: 'Данные объекта' },
  { id: 'draw', label: 'Чертёж' },
]
const SIDE_KEY = 'sverka:intro-side'
const FRAME_EVERY = 15000

const read = (k: string) => {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
const wide = () => matchMedia(RING_MEDIA).matches

/** Whether the screen has room for sides, following resizes and rotation. */
function useWide() {
  const [is, setIs] = useState(wide)
  useEffect(() => {
    const m = matchMedia(RING_MEDIA)
    const on = () => setIs(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return is
}

/** The chosen side, remembered between visits. */
export function useSide(): [Side, (s: Side) => void] {
  const [side, setSide] = useState<Side>(() => {
    const s = read(SIDE_KEY)
    return SIDES.some((x) => x.id === s) ? (s as Side) : 'cams'
  })
  const choose = (s: Side) => {
    setSide(s)
    try {
      localStorage.setItem(SIDE_KEY, s)
    } catch {
      // storage unavailable
    }
  }
  return [side, choose]
}

export interface Site {
  project: ProjectItem | null
  stages: Stage[]
  stage: Stage | null
  levels: Partial<Record<Code, Level>>
  events: UiEvent[]
}

/** The object, its plan, the stage of today with its machinery, and the journal; loaded once the
 * screen is wide enough to show them, also when it becomes so later. */
export function useSite(user: UserProfile) {
  const [site, setSite] = useState<Site | null>(null)
  const isWide = useWide()
  const loaded = site !== null
  useEffect(() => {
    if (!isWide || loaded) return
    let live = true
    const load = async (): Promise<Site> => {
      const ps = await api.projects()
      const visible = ps.filter((p) => user.role === 'admin' || !p.owner_username || p.owner_username === user.username)
      const last = read('sverka:project')
      const project = visible.find((p) => p.id === last) ?? visible[0] ?? null
      if (!project) return { project: null, stages: [], stage: null, levels: {}, events: [] }
      const [items, incidents] = await Promise.all([api.stages(project.id).catch(() => []), api.incidents(project.id).catch(() => [])])
      const stages = toStages(items)
      const stage = stageAt(stages, Date.now())
      const events = incidents.map((a) => toEvent(a, api.mediaUrl)).filter((e) => !e.sample)
      const levels: Partial<Record<Code, Level>> = {}
      if (stage) {
        const prof = await api.profile(stage.id).catch(() => null)
        if (prof) {
          const rules = toProfile(prof, loadSettings(project.id), loadLocalRules(stage.id)).rules
          for (const c of CODES) levels[c] = rules[c].lvl
        }
      }
      return { project, stages, stage, levels, events }
    }
    load().then(
      (s) => {
        if (live) setSite(s)
      },
      () => undefined,
    )
    return () => {
      live = false
    }
  }, [user, isWide, loaded])
  return site
}

export interface Feed { id: string; n: number; name: string; state: 'wait' | 'live' | 'off'; note: string; img: HTMLImageElement | null; at: number }

/**
 * Up to four cameras of the object with their latest frame. A frame is fetched one at a time through
 * the server every 15 s and the stream is never held open, as on the workspace.
 */
export function useFeeds(cameras: CameraItem[] | undefined) {
  const [feeds, setFeeds] = useState<Feed[]>([])
  useEffect(() => {
    if (!cameras?.length) return
    let live = true, timer = 0
    const cams = cameras.slice(0, 4)
    const urls = cams.map((c) => (c.stream_url || '').trim())
    const http = (i: number) => /^https?:\/\//i.test(urls[i])
    const set = (i: number, patch: Partial<Feed>) => setFeeds((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)))
    const grab = async () => {
      for (let i = 0; i < cams.length && live; i++) {
        if (!http(i)) continue
        try {
          const img = await api.grabFrame(urls[i])
          if (live) set(i, { state: 'live', note: '', img, at: Date.now() })
        } catch {
          if (live) set(i, { state: 'off', note: 'нет сигнала' })
        }
      }
      if (live) timer = window.setTimeout(grab, FRAME_EVERY)
    }
    Promise.resolve().then(() => {
      if (!live) return
      setFeeds(cams.map((c, i) => ({ id: c.id, n: i + 1, name: c.name, state: http(i) ? 'wait' : 'off', note: http(i) ? '' : /^rtsp:/i.test(urls[i]) ? 'RTSP' : 'нет адреса', img: null, at: 0 })))
      void grab()
    })
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [cameras])
  return feeds
}

function useNow(every = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(t)
  }, [every])
  return now
}
// the centre of the drawing in the intro layout (wire.ts, landscape)
const centre = () => ({ x: innerWidth * 0.62, y: innerHeight * 0.47 })

/** Picks what the sides show; only where there are sides. */
export function SideSwitch({ side, onSide }: { side: Side; onSide: (s: Side) => void }) {
  return (
    <div className="it-sides" role="group" aria-label="Что показать по краям">
      {SIDES.map((s) => (
        <button key={s.id} type="button" aria-pressed={s.id === side} onClick={() => onSide(s.id)}>
          {s.label}
        </button>
      ))}
    </div>
  )
}

/* ── cameras in the corners, a dashed sight line from each to the drawing: «из единой точки» ── */

// corners in the order cameras fill them: the top ones first, so two cameras still frame the page
const CORNERS = ['c1', 'c3', 'c2', 'c4']

function Cams({ feeds, switched }: { feeds: Feed[]; switched: boolean }) {
  const frames = useRef<(HTMLCanvasElement | null)[]>([])
  const cards = useRef<(HTMLElement | null)[]>([])
  const [rays, setRays] = useState<{ x1: number; y1: number; x2: number; y2: number }[]>([])
  const now = useNow()

  // each new frame into its card, cropped to fill it
  useEffect(() => {
    feeds.forEach((f, i) => {
      const cv = frames.current[i]
      if (!cv || !f.img || cv.dataset.at === String(f.at)) return
      const dpr = Math.min(2, devicePixelRatio || 1)
      cv.width = Math.round(cv.clientWidth * dpr)
      cv.height = Math.round(cv.clientHeight * dpr)
      const { naturalWidth: iw, naturalHeight: ih } = f.img
      const k = Math.max(cv.width / iw, cv.height / ih)
      cv.getContext('2d')!.drawImage(f.img, (cv.width - iw * k) / 2, (cv.height - ih * k) / 2, iw * k, ih * k)
      cv.dataset.at = String(f.at)
    })
  }, [feeds])

  // from the inner edge of each card to the centre of the drawing
  useLayoutEffect(() => {
    const measure = () => {
      const c = centre()
      setRays(
        cards.current
          .slice(0, feeds.length)
          .filter((el): el is HTMLElement => !!el)
          .map((el) => {
            const r = el.getBoundingClientRect(), left = r.left < innerWidth / 2
            return { x1: left ? r.right : r.left, y1: r.top + r.height / 2, x2: c.x, y2: c.y }
          }),
      )
    }
    measure()
    addEventListener('resize', measure)
    return () => removeEventListener('resize', measure)
  }, [feeds.length])

  if (!feeds.length) return null
  const c = centre()
  return (
    <div className="it-side" data-switched={switched || undefined}>
      <svg className="it-rays" aria-hidden="true">
        {rays.map((r, i) => (
          <line key={i} {...r} />
        ))}
        <circle cx={c.x} cy={c.y} r={5} />
        <circle className="pulse" cx={c.x} cy={c.y} r={5} />
      </svg>
      {feeds.map((f, i) => (
        <figure
          key={f.id}
          className={`it-cam ${CORNERS[i]}`}
          data-state={f.state}
          style={{ '--k': i } as CSSProperties}
          ref={(el) => {
            cards.current[i] = el
          }}
        >
          <canvas
            ref={(el) => {
              frames.current[i] = el
            }}
            aria-hidden="true"
          />
          <figcaption>
            <span className="osd">
              <i className="dot" aria-hidden="true" />
              КАМ {f.n}
              <span className="mono">{f.state === 'live' ? hhmmss(now) : f.state === 'wait' ? 'подключение' : f.note}</span>
            </span>
            <span className="name">{f.name}</span>
          </figcaption>
        </figure>
      ))}
    </div>
  )
}

/* ── machinery of today's stage: the plan in gold on the left, the journal in white on the right ── */

const drawn = (code: Code) => SIL[code].replace(/<(path|circle)/g, '<$1 pathLength="1"')
const ACTIVE = new Set(['pending', 'confirmed', 'in_progress'])

function MRow({ code, on, note, miss, k }: { code: Code; on: boolean; note: string; miss?: boolean; k: number }) {
  return (
    <div className={`it-mrow${on ? ' on' : ''}${miss ? ' miss' : ''}`} style={{ '--k': k } as CSSProperties}>
      <svg viewBox="0 0 64 40" aria-hidden="true" dangerouslySetInnerHTML={{ __html: drawn(code) }} />
      <span>
        {MACH[code].name}
        {on && <small>{note}</small>}
      </span>
    </div>
  )
}

function Machinery({ site, switched }: { site: Site; switched: boolean }) {
  const today = dayStart(Date.now())
  // the latest open event about each machine today
  const latest = new Map<Code, UiEvent>()
  for (const e of site.events) {
    if (!e.mach || e.at < today || !ACTIVE.has(e.status) || (e.kind !== 'missing' && e.kind !== 'oop')) continue
    if ((latest.get(e.mach)?.at ?? 0) < e.at) latest.set(e.mach, e)
  }
  const planned = (c: Code) => site.levels[c] === 'req' || site.levels[c] === 'rec'
  const stage = site.stage ? site.stage.name : site.stages.length ? 'сегодня вне этапов' : 'план не загружен'
  return (
    <div className="it-side" data-switched={switched || undefined}>
      <div className="it-mcol plan">
        <span className="kicker">План · {stage}</span>
        {CODES.map((c, i) => (
          <MRow key={c} code={c} k={i} on={planned(c)} note={site.levels[c] === 'req' ? 'обязательна' : 'рекомендуется'} />
        ))}
      </div>
      <div className="it-mcol fact">
        <span className="kicker">Факт · журнал за сегодня</span>
        {CODES.map((c, i) => {
          const e = latest.get(c)
          return <MRow key={c} code={c} k={i} on={planned(c) || !!e} miss={!!e} note={e ? `${e.kind === 'oop' ? 'не по этапу' : 'не замечен'} · ${hhmm(e.at)}` : 'без отклонений'} />
        })}
      </div>
    </div>
  )
}

/* ── the site round the drawing: a dashed ground grid, floodlights, a tower crane, cabins, fences ── */

function SiteLayer({ aim, switched }: { aim: RefObject<{ x: number; y: number }>; switched: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current!, sx = cv.getContext('2d')!
    let raf = 0, drawn = ''
    const frame = () => {
      raf = requestAnimationFrame(frame)
      const w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(2, devicePixelRatio || 1)
      const a = aim.current ?? { x: 0, y: 0 }
      const th = theme(), pal = palette(th), ink = rgba(pal.ink, 1)
      const key = `${w}x${h}:${a.x.toFixed(4)}:${a.y.toFixed(4)}:${th}`
      if (key === drawn || !w || !h) return
      drawn = key
      cv.width = Math.round(w * dpr)
      cv.height = Math.round(h * dpr)
      sx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // the drawing's camera, intro layout
      const unit = Math.min(w * 0.36, h * 0.45), D = 5, f = unit * D, cx = w * 0.62, cy = h * 0.47
      const yaw = a.x * PARALLAX.yaw, pitch = 0.3 + a.y * PARALLAX.pitch
      const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch)
      const P = (x: number, y: number, z: number) => {
        const xr = x * cyw - z * syw, zr = x * syw + z * cyw, y2 = y * cp + zr * sp, z2 = -y * sp + zr * cp, d = f / (D + z2)
        return [cx + xr * d, cy - y2 * d, z2]
      }
      const G = -0.75 // the ground the drawing and the letters stand on
      const fade = (z: number) => Math.max(0, Math.min(1, 1 - (z - 0.5) / 5.5))
      type V3 = [number, number, number]
      const seg = (a1: V3, b1: V3, alpha: number) => {
        const p = P(...a1), q = P(...b1)
        sx.globalAlpha = alpha * fade((p[2] + q[2]) / 2)
        sx.beginPath()
        sx.moveTo(p[0], p[1])
        sx.lineTo(q[0], q[1])
        sx.stroke()
      }
      const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, al: number) => {
        const v: V3[] = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]
        for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) seg(v[i], v[j], al)
      }
      sx.lineWidth = 1
      sx.setLineDash([3, 5])
      sx.strokeStyle = ink
      // ground grid
      for (let x = -8; x <= 8; x += 0.5) for (let z = -1.5; z < 6; z += 0.75) seg([x, G, z], [x, G, z + 0.75], 0.09)
      for (let z = -1.5; z <= 6; z += 0.5) for (let x = -8; x < 8; x += 1) seg([x, G, z], [x + 1, G, z], 0.09)
      // floodlights: the light first, then the masts
      for (const [x, z, h2] of [[-2.2, 0.3, 1.5], [2.5, 2.4, 1.9], [-1.4, 4.2, 1.8], [3.2, -0.2, 1.3]]) {
        const top = P(x, G + h2, z), g1 = P(x - 0.9, G, z - 0.4), g2 = P(x + 0.9, G, z - 0.4)
        const grad = sx.createLinearGradient(top[0], top[1], (g1[0] + g2[0]) / 2, g1[1])
        grad.addColorStop(0, rgba(pal.beam, 0.085))
        grad.addColorStop(1, rgba(pal.beam, 0))
        sx.globalAlpha = fade(top[2])
        sx.fillStyle = grad
        sx.beginPath()
        sx.moveTo(top[0], top[1])
        sx.lineTo(g1[0], g1[1])
        sx.lineTo(g2[0], g2[1])
        sx.closePath()
        sx.fill()
        const pool = P(x, G, z - 0.3), rg = sx.createRadialGradient(pool[0], pool[1], 0, pool[0], pool[1], (160 * 5) / (D + pool[2]))
        rg.addColorStop(0, rgba(pal.beam, 0.07))
        rg.addColorStop(1, rgba(pal.beam, 0))
        sx.fillStyle = rg
        sx.fillRect(pool[0] - 400, pool[1] - 200, 800, 400)
        seg([x, G, z], [x, G + h2, z], 0.4)
        box(x - 0.12, G + h2, z - 0.05, x + 0.12, G + h2 + 0.1, z + 0.05, 0.5)
        const lamp = P(x, G + h2, z - 0.05)
        sx.globalAlpha = 0.9 * fade(lamp[2])
        sx.fillStyle = pal.lamp
        sx.beginPath()
        sx.arc(lamp[0], lamp[1], 2.2, 0, 7)
        sx.fill()
      }
      // a tower crane far left, in the plan's gold
      sx.strokeStyle = rgba(pal.gold, 1)
      const mx = -3.1, mz = 2.2, mh = 2.2
      for (const [dx, dz] of [[-0.06, -0.06], [0.06, -0.06], [0.06, 0.06], [-0.06, 0.06]]) seg([mx + dx, G, mz + dz], [mx + dx, G + mh, mz + dz], 0.45)
      for (let y = 0; y < mh; y += 0.18) seg([mx - 0.06, G + y, mz - 0.06], [mx + 0.06, G + y + 0.18, mz - 0.06], 0.3)
      seg([mx - 0.5, G + mh, mz], [mx + 1.8, G + mh, mz], 0.45)
      seg([mx, G + mh + 0.3, mz], [mx + 1.8, G + mh, mz], 0.3)
      seg([mx, G + mh + 0.35, mz], [mx - 0.6, G + mh, mz], 0.3)
      seg([mx + 1.2, G + mh, mz], [mx + 1.2, G + mh - 0.8, mz], 0.3)
      box(mx - 0.5, G + mh - 0.2, mz - 0.08, mx - 0.3, G + mh, mz + 0.08, 0.4)
      // cabins and a fence on the right, a fence and stacks of material on the left
      sx.strokeStyle = ink
      for (const [x, y] of [[1.9, 0], [2.55, 0], [1.9, 0.32]]) box(x, G + y, 1.1, x + 0.6, G + y + 0.3, 1.35, 0.42)
      for (let x = 1.7; x <= 5; x += 0.3) seg([x, G, -0.5], [x, G + 0.24, -0.5], 0.32)
      seg([1.7, G + 0.22, -0.5], [5, G + 0.22, -0.5], 0.32)
      seg([1.7, G + 0.07, -0.5], [5, G + 0.07, -0.5], 0.32)
      for (let x = -5; x <= -1.6; x += 0.3) seg([x, G, -0.7], [x, G + 0.24, -0.7], 0.32)
      seg([-5, G + 0.22, -0.7], [-1.6, G + 0.22, -0.7], 0.32)
      for (const [x, z] of [[-2.4, 1.2], [-2.0, 1.3]]) for (let k = 0; k < 3; k++) box(x, G + k * 0.06, z, x + 0.3, G + k * 0.06 + 0.05, z + 0.5, 0.36)
      sx.globalAlpha = 1
      sx.setLineDash([])
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [aim])
  return (
    <div className="it-side" data-switched={switched || undefined}>
      <canvas className="it-site" ref={ref} aria-hidden="true" />
    </div>
  )
}

/* ── the object's own numbers in the corners ── */

function ObjectData({ site, feeds, switched }: { site: Site; feeds: Feed[]; switched: boolean }) {
  const now = useNow()
  const { project, stages, stage, events } = site
  const today = dayStart(now)
  const live = feeds.filter((f) => f.state === 'live').length
  const waiting = events.filter(awaitsDecision).sort((a, b) => b.at - a.at)
  const day = stage ? stageDay(stage, now) : 0
  const zones = project?.zones?.map((z) => z.name).filter(Boolean) ?? []
  return (
    <div className="it-side" data-switched={switched || undefined}>
      <section className="it-panel tl" style={{ '--k': 0 } as CSSProperties}>
        <span className="kicker">Объект</span>
        <h3>{project?.name ?? 'Объект не выбран'}</h3>
        <p>{project?.address || (zones.length ? `${plural(zones.length, 'Зона', 'Зоны', 'Зоны')}: ${zones.join(', ')}` : 'Зоны не заданы')}</p>
      </section>
      <section className="it-panel bl" style={{ '--k': 1 } as CSSProperties}>
        <span className="kicker">{stage ? `Этап ${stage.n} из ${stages.length}` : 'План работ'}</span>
        <h3>{stage ? stage.name : stages.length ? 'Сегодня вне этапов плана' : 'План не загружен'}</h3>
        {stage && (
          <>
            <div className="bar">
              <i style={{ transform: `scaleX(${Math.min(1, day / stage.days)})` }} />
            </div>
            <p className="mono">
              день {day} из {stage.days} · {fmtDay(stage.start)} — {fmtDay(stage.end)}
            </p>
          </>
        )}
        {stages.length > 0 && (
          <div className="gantt" aria-hidden="true">
            {stages.map((s) => (
              <i key={s.id} className={s === stage ? 'now' : s.end < today ? 'done' : ''} />
            ))}
          </div>
        )}
      </section>
      <section className="it-panel tr" style={{ '--k': 2 } as CSSProperties}>
        <span className="kicker">{feeds.length ? `Источники · ${live} из ${feeds.length} дают кадры` : 'Источники'}</span>
        {feeds.length ? (
          <ul>
            {feeds.map((f) => (
              <li key={f.id} data-state={f.state}>
                <i className="dot" aria-hidden="true" />
                <span className="nm">{f.name}</span>
                <span className="mono">{f.state === 'live' ? durShort(now - f.at) : f.state === 'wait' ? '…' : f.note}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p>Камеры не добавлены</p>
        )}
      </section>
      <section className="it-panel br" style={{ '--k': 3 } as CSSProperties}>
        <span className="kicker">Ждут решения</span>
        <div className="big">
          {waiting.length}
          <small>{plural(waiting.length, 'событие', 'события', 'событий')}</small>
        </div>
        <p>{waiting[0] ? waiting[0].title : 'Все события разобраны'}</p>
      </section>
    </div>
  )
}

/* ── the page as a drawing sheet: grid axes, elevation marks, the title block ── */

function DrawingSheet({ site, scene, subject, switched }: { site: Site | null; scene: WireScene | null; subject: string; switched: boolean }) {
  const [size, setSize] = useState(() => ({ w: innerWidth, h: innerHeight }))
  const [turn, setTurn] = useState(0)
  useEffect(() => {
    const resize = () => setSize({ w: innerWidth, h: innerHeight })
    addEventListener('resize', resize)
    const t = window.setInterval(() => setTurn(Math.round((((scene?.turn ?? 0) * 180) / Math.PI % 360 + 360) % 360)), 250)
    return () => {
      removeEventListener('resize', resize)
      clearInterval(t)
    }
  }, [scene])
  const { w, h } = size
  // the column axes start right of the title block in the upper left
  const cols = 8, x0 = Math.round(Math.min(420, w * 0.25)), x1 = w - 110, y0 = 150, y1 = h - 150
  const top = 120, bottom = h - 120, marks = 48
  return (
    <div className="it-side" data-switched={switched || undefined}>
      <svg className="it-axes" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
        {Array.from({ length: cols }, (_, i) => {
          const x = x0 + ((x1 - x0) * i) / (cols - 1)
          return (
            <g key={i}>
              <line className="ax" x1={x} y1={104} x2={x} y2={h - 96} />
              <circle cx={x} cy={92} r={11} />
              <text x={x} y={92}>
                {i + 1}
              </text>
            </g>
          )
        })}
        {[...'АБВГ'].map((ch, i) => {
          const y = y0 + ((y1 - y0) * i) / 3
          return (
            <g key={ch}>
              <line className="ax" x1={34} y1={y} x2={w - 96} y2={y} />
              <circle cx={22} cy={y} r={11} />
              <text x={22} y={y}>
                {ch}
              </text>
            </g>
          )
        })}
      </svg>
      <div className="it-elev" aria-hidden="true">
        {Array.from({ length: marks + 1 }, (_, k) => {
          const y = bottom - top - ((bottom - top) * k) / marks
          return (
            <span key={k}>
              <i style={{ top: y, width: k % 4 ? 6 : 12 }} />
              {k % 8 === 0 && <b style={{ top: y }}>+{((k / 4) * 3.3).toFixed(3).replace('.', ',')}</b>}
            </span>
          )
        })}
      </div>
      <dl className="it-stamp">
        <dt>Объект</dt>
        <dd>{site?.project?.name ?? '—'}</dd>
        <dt>Этап</dt>
        <dd>{site?.stage?.name ?? (site?.stages.length ? 'вне этапов' : 'нет плана')}</dd>
        <dt>Показано</dt>
        <dd>{subject}</dd>
        <dt>Поворот</dt>
        <dd>{turn}°</dd>
      </dl>
      <i className="it-corner tl" />
      <i className="it-corner tr" />
      <i className="it-corner bl" />
      <i className="it-corner br" />
    </div>
  )
}

/** The chosen side. `switched` drops the entrance delay once someone picks a side by hand. */
export function Sides({ side, user, scene, aim, subject, switched }: { side: Side; user: UserProfile; scene: WireScene | null; aim: RefObject<{ x: number; y: number }>; subject: string; switched: boolean }) {
  const site = useSite(user)
  const feeds = useFeeds(site?.project?.cameras)
  if (side === 'site') return <SiteLayer key="site" aim={aim} switched={switched} />
  if (side === 'draw') return <DrawingSheet key="draw" site={site} scene={scene} subject={subject} switched={switched} />
  if (!site) return null
  if (side === 'cams') return <Cams key="cams" feeds={feeds} switched={switched} />
  if (side === 'mach') return <Machinery key="mach" site={site} switched={switched} />
  return <ObjectData key="data" site={site} feeds={feeds} switched={switched} />
}
