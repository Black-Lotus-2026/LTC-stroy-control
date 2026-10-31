import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import * as api from '../api'
import type { CameraItem } from '../api'
import type { ContextDTO } from '../customerApi'
import { loadIntroSite, type IntroSite as Site } from '../introData'
import { dayStart, durShort, fmtDay, hhmm, hhmmss, plural } from '../lib/format'
import { CODES, MACH, SIL, type Code } from '../lib/machinery'
import { RING_MEDIA } from '../lib/ring'
import { awaitsDecision, stageDay, type UiEvent } from '../model'

/*
 * What fills the sides of a wide intro around the drawing; the variants were drawn up on
 * docs/ui-concept/intro-sides.html. All of them read the object the workspace opens (the last chosen,
 * else the first visible) and show only what the server knows: no cameras, no corners; no plan, the
 * plan column says so. Narrow and portrait screens have no room for sides and show none.
 */

export type Side = 'cams' | 'mach' | 'data'
export const SIDES: { id: Side; label: string }[] = [
  { id: 'cams', label: 'Камеры' },
  { id: 'mach', label: 'Техника этапа' },
  { id: 'data', label: 'Данные объекта' },
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

/** The sides never choose a project or infer a role independently of the context loader. */
export function useSite(context: ContextDTO | null) {
  const [state, setState] = useState<{ key: string; site: Site | null; error: string } | null>(null)
  const isWide = useWide()
  const key = context ? `${context.assignment_id}:${context.authorization_version}` : ''
  useEffect(() => {
    if (!isWide || !context) return
    let live = true
    loadIntroSite(context, () => live).then(site => { if (live) setState({ key, site, error: '' }) }, error => { if (live) setState({ key, site: null, error: error instanceof Error ? error.message : 'Данные объекта недоступны.' }) })
    return () => { live = false }
  }, [key, isWide])
  return state?.key === key ? state : { key, site: null, error: '' }
}

export interface Feed { id: string; n: number; name: string; state: 'wait' | 'live' | 'off'; note: string; img: HTMLImageElement | null; at: number }

/**
 * Up to four cameras of the object with their latest frame. A frame is fetched one at a time through
 * the server every 15 s and the stream is never held open, as on the workspace.
 */
export function useFeeds(cameras: CameraItem[] | undefined) {
  const [feeds, setFeeds] = useState<Feed[]>([])
  useEffect(() => {
    if (!cameras?.length) { setFeeds([]); return }
    let live = true, timer = 0
    const cams = cameras.slice(0, 4)
    const set = (i: number, patch: Partial<Feed>) => setFeeds((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)))
    const grab = async () => {
      for (let i = 0; i < cams.length && live; i++) {
        try {
          const img = await api.grabFrame(cams[i].id)
          if (live) set(i, { state: 'live', note: '', img, at: Date.now() })
        } catch {
          if (live) set(i, { state: 'off', note: 'нет сигнала' })
        }
      }
      if (live) timer = window.setTimeout(grab, FRAME_EVERY)
    }
    Promise.resolve().then(() => {
      if (!live) return
      setFeeds(cams.map((c, i) => ({ id: c.id, n: i + 1, name: c.name, state: 'wait', note: '', img: null, at: 0 })))
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
      const { naturalWidth: iw, naturalHeight: ih } = f.img
      if (!iw || !ih) return
      const dpr = Math.min(2, devicePixelRatio || 1)
      const w = Math.round(cv.clientWidth * dpr)
      const h = Math.round(cv.clientHeight * dpr)
      if (!w || !h) return
      cv.width = w
      cv.height = h
      const k = Math.max(w / iw, h / ih)
      const ctx = cv.getContext('2d')
      if (ctx) {
        ctx.drawImage(f.img, (w - iw * k) / 2, (h - ih * k) / 2, iw * k, ih * k)
      }
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
  const stage = !site.planAvailable ? 'вне области доступа' : site.stage ? site.stage.name : site.stages.length ? 'сегодня вне этапов' : 'план не загружен'
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
          return <MRow key={c} code={c} k={i} on={planned(c) || !!e} miss={!!e} note={e ? `${e.kind === 'oop' ? 'не по этапу' : 'не замечен'} · ${hhmm(e.at)}` : 'нет события в доступном журнале'} />
        })}
      </div>
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
        <h3>{!site.planAvailable ? 'Вне области доступа' : stage ? stage.name : stages.length ? 'Сегодня вне этапов плана' : 'План не загружен'}</h3>
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
          <p>{site.camerasAvailable ? 'Доступных камер нет' : 'Камеры вне текущего назначения'}</p>
        )}
      </section>
      <section className="it-panel br" style={{ '--k': 3 } as CSSProperties}>
        <span className="kicker">Ждут решения</span>
        <div className="big">
          {site.eventsAvailable ? waiting.length : '—'}
          <small>{plural(waiting.length, 'событие', 'события', 'событий')}</small>
        </div>
        <p>{!site.eventsAvailable ? 'Дела вне текущего назначения' : waiting[0] ? waiting[0].title : 'В доступном журнале нет ожидающих решений'}</p>
      </section>
    </div>
  )
}

/** The chosen side. `switched` drops the entrance delay once someone picks a side by hand. */
export function Sides({ side, context, switched }: { side: Side; context: ContextDTO | null; scene?: unknown; aim?: unknown; subject?: string; switched: boolean }) {
  const { site, error } = useSite(context)
  const feeds = useFeeds(site?.camerasAvailable ? site.project.cameras : undefined)
  if (error) return <div className="it-side"><section className="it-panel tl"><span className="kicker">Данные объекта недоступны</span><p>{error}</p></section></div>
  if (!site) return null
  if ((side === 'mach' && !site.planAvailable) || (side === 'cams' && !site.camerasAvailable)) return <div className="it-side"><section className="it-panel tl"><span className="kicker">Область назначения</span><p>{side === 'mach' ? 'План работ вне текущей области доступа.' : 'Камеры вне текущей области доступа.'}</p></section></div>
  if (side === 'cams') return <Cams key="cams" feeds={feeds} switched={switched} />
  if (side === 'mach') return <Machinery key="mach" site={site} switched={switched} />
  return <ObjectData key="data" site={site} feeds={feeds} switched={switched} />
}
