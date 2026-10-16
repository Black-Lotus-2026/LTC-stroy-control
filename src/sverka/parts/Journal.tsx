import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ProjectItem } from '../api'
import type { EventStatus, Settings, Stage, UiEvent } from '../model'
import { STATUS_WORD } from '../model'
import { MACH } from '../lib/machinery'
import { DAY_MS, MONTHS_G, MONTHS_S, addDays, clock, dayStart, daysBetween, fmtDay, fmtDayLong, fromDateInput, hhmm, plural, toDateInput } from '../lib/format'
import { Spring, VelocityTracker, capture, clamp, lerp, project, reducedMotion, rubber } from '../lib/spring'
import { ACT_DEFAULTS, buildAct, type ActOptions } from '../act'
import { CloseIcon, Roll, Seg, SevIcon, Tick } from './common'

type Preset = 'shift' | 'day' | 'week' | 'month' | 'all' | 'custom'
interface Range { from: number; to: number; preset: Preset }
type SevF = 'all' | 'err' | 'warn'

const PRESETS: { v: Preset; label: string }[] = [
  { v: 'shift', label: 'Смена' },
  { v: 'day', label: 'Сутки' },
  { v: 'week', label: '7 дней' },
  { v: 'month', label: '30 дней' },
  { v: 'all', label: 'Всё' },
]
const STATUSES: EventStatus[] = ['pending', 'confirmed', 'in_progress', 'false_positive', 'resolved']
const STATUS_SHORT: Record<EventStatus, string> = { pending: 'Ждут решения', confirmed: 'Подтверждено', in_progress: 'В работе', false_positive: 'Ложные', resolved: 'Устранено' }
const A4 = 794 // px, 210 mm at 96 dpi

function spanText(from: number, to: number) {
  const a = new Date(from)
  const b = new Date(to - 1)
  if (dayStart(a) === dayStart(b)) return `${a.getDate()} ${MONTHS_G[a.getMonth()]}`
  if (a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth()) return `${a.getDate()} – ${b.getDate()} ${MONTHS_G[b.getMonth()]}`
  const y = a.getFullYear() !== b.getFullYear()
  return `${a.getDate()} ${MONTHS_G[a.getMonth()]}${y ? ` ${a.getFullYear()}` : ''} – ${b.getDate()} ${MONTHS_G[b.getMonth()]}${y ? ` ${b.getFullYear()}` : ''}`
}
function rangeTitle(r: Range) {
  if (r.preset === 'shift') return `Смена ${fmtDay(r.from)}, ${hhmm(r.from)}–${hhmm(r.to)}`
  if (r.preset === 'day') return `Сутки до ${hhmm(r.to)}, ${fmtDay(r.to)}`
  if (r.preset === 'week') return `7 дней · ${spanText(r.from, r.to)}`
  if (r.preset === 'month') return `30 дней · ${spanText(r.from, r.to)}`
  if (r.preset === 'all') return `Весь журнал · ${spanText(r.from, r.to)}`
  return spanText(r.from, r.to)
}
const hay = (e: UiEvent) =>
  [e.code, e.title, e.stageName, e.zone, e.mach && MACH[e.mach].name, e.album.map((a) => a.camera).join(' '), STATUS_WORD[e.status], e.demo ? 'демо' : '', e.description].join(' ').toLowerCase()

export function Journal({
  events,
  stages,
  project,
  user,
  settings,
  t,
  origin,
  onOpen,
  onClose,
}: {
  events: UiEvent[]
  stages: Stage[]
  project: ProjectItem
  user: string
  settings: Settings
  t: number
  origin: DOMRect | null
  onOpen: (id: string, el: HTMLElement) => void
  onClose: () => void
}) {
  const real = events.filter((e) => !e.sample)
  const firstAt = real.length ? Math.min(...real.map((e) => e.at)) : t
  const lastAt = real.length ? Math.max(...real.map((e) => e.at)) : t
  // the scale covers every preset: from the first event (or 30 days back) to today
  const b = addDays(dayStart(Math.max(t, lastAt)), 1)
  const a = addDays(Math.min(dayStart(firstAt), addDays(dayStart(t), -29)), -1)
  const n = daysBetween(a, b)
  const activeKey = real.map((e) => dayStart(e.at)).sort().join(',') + '|' + dayStart(t)
  const fold = useMemo(() => buildFold(a, n, real.map((e) => daysBetween(a, e.at)), daysBetween(a, t)), [a, n, activeKey])

  const presetRange = (p: Preset): Range => {
    const d = dayStart(t)
    if (p === 'shift') return { from: d + settings.shiftFrom * 1000, to: d + settings.shiftTo * 1000, preset: p }
    if (p === 'day') return { from: t - DAY_MS, to: t, preset: p }
    if (p === 'week') return { from: addDays(d, -6), to: Math.max(t, lastAt), preset: p }
    if (p === 'month') return { from: addDays(d, -29), to: Math.max(t, lastAt), preset: p }
    return { from: dayStart(firstAt), to: Math.max(t, lastAt), preset: 'all' }
  }
  const [range, setRange] = useState<Range>(() => presetRange('all'))
  const [sev, setSev] = useState<SevF>('all')
  const [st, setSt] = useState<Set<EventStatus>>(new Set())
  const [q, setQ] = useState('')
  const [view, setView] = useState<'list' | 'shots'>('list')
  const [excluded, setExcluded] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<'journal' | 'act'>('journal')
  const [actMounted, setActMounted] = useState(false)
  const [opts, setOpts] = useState<ActOptions>(ACT_DEFAULTS)

  /* ── filtering ─────────────────────────────────────────── */
  const query = q.trim().toLowerCase()
  const passSev = (e: UiEvent) => sev === 'all' || e.sev === sev
  const passQ = (e: UiEvent) => !query || hay(e).includes(query)
  const passSt = (e: UiEvent) => !st.size || st.has(e.status)
  const inRange = (e: UiEvent) => e.at >= range.from && e.at <= range.to
  const base = events.filter((e) => inRange(e) && passQ(e))
  const sevCounts = { all: base.length, err: base.filter((e) => e.sev === 'err').length, warn: base.filter((e) => e.sev === 'warn').length }
  const forStatus = base.filter(passSev)
  const stCounts = Object.fromEntries(STATUSES.map((s) => [s, forStatus.filter((e) => e.status === s).length])) as Record<EventStatus, number>
  const shown = forStatus.filter(passSt).sort((x, y) => y.at - x.at)
  const items = shown.filter((e) => !e.sample && !excluded.has(e.id)).sort((x, y) => x.at - y.at)
  const filtered = sev !== 'all' || st.size > 0 || !!query
  const groups = useMemo(() => {
    const m = new Map<number, UiEvent[]>()
    for (const e of shown) {
      const d = dayStart(e.at)
      if (!m.has(d)) m.set(d, [])
      m.get(d)!.push(e)
    }
    return [...m]
  }, [shown])

  /* histogram over the whole scale; it follows the filters except the period */
  const hist = useMemo(() => {
    const cols = Array.from({ length: n }, () => ({ ep: 0, ed: 0, wp: 0, wd: 0 }))
    for (const e of events) {
      if (e.sample || !passSev(e) || !passQ(e) || !passSt(e)) continue
      const i = daysBetween(a, e.at)
      if (i < 0 || i >= n) continue
      const c = cols[i]
      const p = e.status === 'pending'
      if (e.sev === 'err') {
        if (p) c.ep++
        else c.ed++
      } else if (p) c.wp++
      else c.wd++
    }
    const max = Math.max(1, ...cols.map((c) => c.ep + c.ed + c.wp + c.wd))
    return { cols, max }
    // passSev/passQ/passSt read sev, query and st
  }, [events, a, n, sev, query, st])

  /* ── open / close: the panel grows out of the button that opened it ───────── */
  const el = useRef<HTMLElement>(null)
  const scrim = useRef<HTMLDivElement>(null)
  const sp = useRef<Spring | null>(null)
  const closing = useRef(false)
  const rect = useRef({ left: 0, top: 0, width: 0, height: 0 })
  const mob = () => matchMedia('(max-width: 860px)').matches
  const paintOpen = (p: number) => {
    const c = el.current
    if (!c) return
    const R = rect.current
    const o = origin || new DOMRect(R.left + R.width - 120, R.top + 10, 100, 30)
    const k = clamp(p, 0, 1.03)
    const top = lerp(o.top - R.top, 0, k)
    const left = lerp(o.left - R.left, 0, k)
    const right = lerp(R.left + R.width - o.right, 0, k)
    const bottom = lerp(R.top + R.height - o.bottom, 0, k)
    c.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px round ${lerp(8, mob() ? 0 : 14, clamp(k, 0, 1))}px)`
    if (scrim.current) scrim.current.style.opacity = String(clamp(p, 0, 1))
    const inner = String(clamp((p - 0.3) / 0.5, 0, 1))
    c.querySelectorAll<HTMLElement>('.j-in').forEach((x) => (x.style.opacity = inner))
  }
  useLayoutEffect(() => {
    const R = mob() ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : { left: 16, top: 64, width: innerWidth - 32, height: innerHeight - 64 - 12 }
    rect.current = R
    const c = el.current!
    Object.assign(c.style, { left: R.left + 'px', top: R.top + 'px', width: R.width + 'px', height: R.height + 'px' })
    sp.current = new Spring(0, { response: 0.52, damping: 0.9, rest: 0.002, onUpdate: paintOpen })
    paintOpen(0)
    sp.current.to(1)
    if (!reducedMotion())
      c.querySelectorAll('.j-row, .j-shot').forEach((r, i) => {
        if (i < 14) r.animate([{ opacity: 0, transform: 'translateY(10px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 240 + i * 28, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' })
      })
    const back = document.activeElement as HTMLElement | null
    window.setTimeout(() => c.querySelector<HTMLElement>('#journalTitle')?.focus({ preventScroll: true }), 60)
    return () => back?.focus?.({ preventScroll: true })
    // runs once per opening
  }, [])
  const close = () => {
    if (closing.current) return
    closing.current = true
    sp.current!.to(0, { damping: 1, onRest: onClose })
  }

  /* ── journal ⇄ act: the act comes in from the right, the list steps aside ───── */
  const listPane = useRef<HTMLDivElement>(null)
  const actPane = useRef<HTMLDivElement>(null)
  const mp = useRef<Spring | null>(null)
  if (!mp.current)
    mp.current = new Spring(0, {
      response: 0.5,
      damping: 0.92,
      rest: 0.002,
      onUpdate: (p) => {
        const l = listPane.current
        const r = actPane.current
        if (l) {
          l.style.transform = p ? `translateX(${-p * 48}px) scale(${1 - p * 0.02})` : ''
          l.style.opacity = String(1 - clamp(p * 1.4, 0, 1))
          l.style.visibility = p > 0.99 ? 'hidden' : ''
        }
        if (r) {
          r.style.transform = p < 1 ? `translateX(${(1 - p) * 64}px)` : ''
          r.style.opacity = String(clamp((p - 0.15) / 0.7, 0, 1))
          r.style.visibility = p < 0.01 ? 'hidden' : ''
        }
      },
    })
  useLayoutEffect(() => {
    if (mode === 'act') {
      setActMounted(true)
      mp.current!.to(1, { onRest: () => undefined })
    } else if (mp.current!.x > 0 || mp.current!.moving) mp.current!.to(0, { onRest: () => setActMounted(false) })
  }, [mode])
  useLayoutEffect(() => {
    if (actMounted) mp.current!.onUpdate?.(mp.current!.x)
  }, [actMounted])

  /* keys: Esc steps back (act → journal → closed), "/" focuses search */
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (document.querySelector('.case, .lightbox')) return
      if (e.key === 'Escape') {
        e.preventDefault()
        if (mode === 'act') setMode('journal')
        else close()
      }
      const tag = (e.target as HTMLElement).tagName
      if (e.key === '/' && tag !== 'INPUT' && mode === 'journal') {
        e.preventDefault()
        el.current?.querySelector<HTMLInputElement>('.j-search input')?.focus()
      }
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  })

  const toggle = (ids: string[], on: boolean) =>
    setExcluded((x) => {
      const y = new Set(x)
      for (const id of ids) {
        if (on) y.delete(id)
        else y.add(id)
      }
      return y
    })
  const pickPreset = (p: Preset) => setRange(presetRange(p))
  const real0 = shown.filter((e) => !e.sample)
  const allIn = real0.length > 0 && real0.every((e) => !excluded.has(e.id))
  const pending = shown.filter((e) => e.status === 'pending' && !e.sample).length

  return (
    <>
      <div className="scrim j-scrim" data-on="true" ref={scrim} onClick={close} style={{ opacity: 0 }} />
      <section className="journal" ref={el} role="dialog" aria-modal="true" aria-labelledby="journalTitle" data-mode={mode}>
        <header className="j-head j-in">
          <div className="j-title">
            <span className="kicker">
              {mode === 'act' ? 'Акт за период' : 'Журнал событий'}
              <span className="j-proj"> · {project.name}</span>
            </span>
            <h2 id="journalTitle" tabIndex={-1}>
              {rangeTitle(range)}
            </h2>
            <p>
              <Roll value={shown.length} /> {plural(shown.length, 'событие', 'события', 'событий')}
              {shown.some((e) => e.sev === 'err') && (
                <>
                  {' · '}
                  <span className="t-err">
                    <Roll value={shown.filter((e) => e.sev === 'err').length} /> {plural(shown.filter((e) => e.sev === 'err').length, 'отклонение', 'отклонения', 'отклонений')}
                  </span>
                </>
              )}
              {pending > 0 && (
                <>
                  {' · '}
                  <span className="t-warn">
                    <Roll value={pending} /> ждут решения
                  </span>
                </>
              )}
            </p>
          </div>
          <div className="j-actions">
            {mode === 'journal' ? (
              <button type="button" className="btn plan" onClick={() => setMode('act')} disabled={!items.length} aria-label={`Акт за период: ${items.length} ${plural(items.length, 'запись', 'записи', 'записей')}`}>
                <span className="lg">Акт за период</span>
                <span className="sm">Акт</span> · <Roll value={items.length} />
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => setMode('journal')}>
                ← К журналу
              </button>
            )}
            <button type="button" className="close-x" onClick={close} aria-label="Закрыть журнал">
              <CloseIcon />
            </button>
          </div>
        </header>

        <div className="j-range j-in">
          <div className="j-presets">
            <Seg label="Период" value={range.preset === 'custom' ? ('custom' as Preset) : range.preset} options={[...PRESETS, ...(range.preset === 'custom' ? [{ v: 'custom' as Preset, label: 'Свой' }] : [])]} onChange={pickPreset} />
            <span className="j-hint">Потяните по шкале, чтобы выбрать свой период</span>
          </div>
          <Scale a={a} b={b} fold={fold} hist={hist} stages={stages} t={t} range={range} onRange={setRange} />
        </div>

        <div className="j-body">
          <div className="j-pane j-list-pane j-in" ref={listPane}>
            <div className="j-filters">
              <Seg
                label="Важность"
                value={sev}
                onChange={setSev}
                options={[
                  { v: 'all', label: <>Все <small>{sevCounts.all}</small></> },
                  { v: 'err', label: <>Отклонения <small>{sevCounts.err}</small></> },
                  { v: 'warn', label: <>Предупреждения <small>{sevCounts.warn}</small></> },
                ]}
              />
              <div className="j-chips" role="group" aria-label="Решение">
                {STATUSES.map((s) => (
                  <button key={s} type="button" className="chip" data-s={s} aria-pressed={st.has(s)} disabled={!stCounts[s] && !st.has(s)} onClick={() => setSt((x) => { const y = new Set(x); if (y.has(s)) y.delete(s); else y.add(s); return y })}>
                    {STATUS_SHORT[s]} <small>{stCounts[s]}</small>
                  </button>
                ))}
              </div>
              <label className="j-search">
                <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="7" cy="7" r="4.8" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M10.6 10.6 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Техника, этап, камера, код" aria-label="Поиск по журналу" />
                {q ? (
                  <button type="button" onClick={() => setQ('')} aria-label="Очистить поиск">
                    <CloseIcon />
                  </button>
                ) : (
                  <kbd>/</kbd>
                )}
              </label>
              <Seg label="Вид" value={view} onChange={setView} className="j-view" options={[{ v: 'list', label: 'Список' }, { v: 'shots', label: 'Кадры' }]} />
            </div>
            <div className="j-listhead">
              <Tick on={allIn} onChange={(v) => toggle(real0.map((e) => e.id), v)} label={allIn ? 'Снять все с акта' : 'Включить все в акт'} />
              <span>
                В акт: <b>{items.length}</b> из {real0.length}
                {excluded.size > 0 && real0.some((e) => excluded.has(e.id)) && (
                  <button type="button" className="link-plain" onClick={() => setExcluded(new Set())}>
                    вернуть все
                  </button>
                )}
              </span>
              {filtered && (
                <button type="button" className="link-plain" onClick={() => { setSev('all'); setSt(new Set()); setQ('') }}>
                  Сбросить фильтры
                </button>
              )}
            </div>
            <div className="j-scroll">
              {!shown.length && (
                <div className="j-empty">
                  <strong>{events.length ? 'Ничего не нашлось' : 'Журнал пуст'}</strong>
                  {events.length
                    ? filtered
                      ? 'За этот период нет событий с такими условиями.'
                      : 'За этот период событий нет. Выберите другой период на шкале.'
                    : 'События появятся, когда система заметит отклонение от плана.'}
                </div>
              )}
              {view === 'list'
                ? groups.map(([d, list]) => (
                    <div className="j-day" key={d}>
                      <div className="j-dayhead">
                        <Tick on={list.filter((e) => !e.sample).every((e) => !excluded.has(e.id))} onChange={(v) => toggle(list.filter((e) => !e.sample).map((e) => e.id), v)} label="Включить день в акт" />
                        <b>{fmtDayLong(d)}</b>
                        <span>
                          {list.length} {plural(list.length, 'событие', 'события', 'событий')}
                        </span>
                      </div>
                      {list.map((e) => (
                        <Row key={e.id} e={e} stages={stages} included={!excluded.has(e.id)} onToggle={(v) => toggle([e.id], v)} onOpen={onOpen} />
                      ))}
                    </div>
                  ))
                : shown.length > 0 && (
                    <div className="j-shots">
                      {shown.map((e) => (
                        <Shot key={e.id} e={e} included={!excluded.has(e.id)} onToggle={(v) => toggle([e.id], v)} onOpen={onOpen} />
                      ))}
                    </div>
                  )}
            </div>
          </div>
          {actMounted && (
            <div className="j-pane j-act-pane" ref={actPane} style={{ opacity: 0, visibility: 'hidden' }}>
              <Act project={project} user={user} range={range} items={items} stages={stages} settings={settings} opts={opts} setOpts={setOpts} total={real0.length} onRange={setRange} />
            </div>
          )}
        </div>
      </section>
    </>
  )
}

function Row({ e, stages, included, onToggle, onOpen }: { e: UiEvent; stages: Stage[]; included: boolean; onToggle: (v: boolean) => void; onOpen: (id: string, el: HTMLElement) => void }) {
  const stage = stages.find((s) => s.id === e.stageId)
  const photo = e.album.find((x) => x.primary) || e.album[0]
  return (
    <div className="j-row" data-sev={e.sev} data-sample={e.sample || undefined}>
      {e.sample ? <span className="tick-space" /> : <Tick on={included} onChange={onToggle} label={included ? 'Убрать из акта' : 'Включить в акт'} />}
      <button type="button" className="j-open" onClick={(ev) => onOpen(e.id, ev.currentTarget)}>
        <span className="j-time mono">{hhmm(e.at)}</span>
        <span className="j-sev" data-sev={e.sev}>
          <SevIcon sev={e.sev} />
        </span>
        <span className="j-main">
          <b>{e.title}</b>
          <small>
            {[stage ? `Этап ${stage.n} «${stage.name}»` : e.stageName, photo?.camera, e.zone].filter(Boolean).join(' · ')}
            {e.demo && <span className="tag">демо</span>}
            {e.sample && <span className="tag">пример с сервера</span>}
          </small>
        </span>
        <span className="j-st" data-s={e.status}>
          {STATUS_WORD[e.status]}
        </span>
        <span className="j-thumb">{photo ? <img src={photo.url} alt="" loading="lazy" /> : null}</span>
      </button>
    </div>
  )
}

function Shot({ e, included, onToggle, onOpen }: { e: UiEvent; included: boolean; onToggle: (v: boolean) => void; onOpen: (id: string, el: HTMLElement) => void }) {
  const photo = e.album.find((x) => x.primary) || e.album[0]
  return (
    <div className="j-shot" data-sev={e.sev}>
      <button type="button" className="j-open" onClick={(ev) => onOpen(e.id, ev.currentTarget)}>
        <span className="j-pic">
          {photo ? <img src={photo.url} alt="" loading="lazy" /> : <span className="j-nopic">кадр не сохранён</span>}
          <span className="j-cap">
            <span className="j-sev" data-sev={e.sev}>
              <SevIcon sev={e.sev} />
            </span>
            {fmtDay(e.at)}, {hhmm(e.at)}
            {e.demo && <span className="tag">демо</span>}
          </span>
          {e.album.length > 1 && <span className="j-count">{e.album.length} {plural(e.album.length, 'кадр', 'кадра', 'кадров')}</span>}
        </span>
        <span className="j-main">
          <b>{e.title}</b>
          <small className="j-st" data-s={e.status}>
            {STATUS_WORD[e.status]}
            {photo ? ` · ${photo.camera}` : ''}
          </small>
        </span>
      </button>
      {!e.sample && <Tick on={included} onChange={onToggle} label={included ? 'Убрать из акта' : 'Включить в акт'} className="on-pic" />}
    </div>
  )
}

/* ── The scale ───────────────────────────────────────────────────────────────
   Days with event counts, plan stages in gold under them, and a brush for the period.
   Long stretches without events fold into a narrow crease (the folding-rule idea of the dock),
   so a recording from May and today's shift both get readable days on one strip.
   The brush is two springs (start, end) in fractions of the strip. Dragging is 1:1; on release it
   snaps to midnight, carrying the hand's velocity; a thrown period rubber-bands at the ends. */
interface FoldSeg { d0: number; d1: number; u0: number; u1: number; gap: boolean }
interface Fold { a: number; n: number; segs: FoldSeg[]; U: number }
const GAP_UNITS = 1.3

function buildFold(a: number, n: number, active: number[], today: number): Fold {
  const kept = new Array<boolean>(n).fill(false)
  for (const d of active) for (let k = d - 1; k <= d + 1; k++) if (k >= 0 && k < n) kept[k] = true
  // the working week stays unfolded, so "7 дней" always reads as seven days
  for (let k = today - 6; k <= today; k++) if (k >= 0 && k < n) kept[k] = true
  const segs: FoldSeg[] = []
  let u = 0
  for (let i = 0; i < n; ) {
    let j = i
    while (j < n && kept[j] === kept[i]) j++
    const gap = !kept[i] && j - i > 1
    const w = gap ? GAP_UNITS : j - i
    const last = segs[segs.length - 1]
    if (!gap && last && !last.gap) {
      last.d1 = j
      last.u1 += w
    } else segs.push({ d0: i, d1: j, u0: u, u1: u + w, gap })
    u += w
    i = j
  }
  return { a, n, segs, U: u }
}
function fOfMs(F: Fold, ms: number) {
  const d = clamp((ms - F.a) / DAY_MS, 0, F.n)
  const s = F.segs.find((x) => d >= x.d0 && d <= x.d1) ?? F.segs[F.segs.length - 1]
  return (s.u0 + ((d - s.d0) / Math.max(1e-9, s.d1 - s.d0)) * (s.u1 - s.u0)) / F.U
}
function msOfF(F: Fold, f: number) {
  const u = clamp(f, 0, 1) * F.U
  const s = F.segs.find((x) => u >= x.u0 && u <= x.u1) ?? F.segs[F.segs.length - 1]
  return F.a + (s.d0 + ((u - s.u0) / Math.max(1e-9, s.u1 - s.u0)) * (s.d1 - s.d0)) * DAY_MS
}
const snapDay = (ms: number) => dayStart(ms + DAY_MS / 2)

function Scale({
  a,
  b,
  fold,
  hist,
  stages,
  t,
  range,
  onRange,
}: {
  a: number
  b: number
  fold: Fold
  hist: { cols: { ep: number; ed: number; wp: number; wd: number }[]; max: number }
  stages: Stage[]
  t: number
  range: Range
  onRange: (r: Range) => void
}) {
  const track = useRef<HTMLDivElement>(null)
  const brush = useRef<HTMLDivElement>(null)
  const shadeL = useRef<HTMLDivElement>(null)
  const shadeR = useRef<HTMLDivElement>(null)
  const label = useRef<HTMLSpanElement>(null)
  const [W, setW] = useState(0)
  const F = useRef(fold)
  F.current = fold
  const fOf = (ms: number) => fOfMs(F.current, ms)
  const msOf = (f: number) => msOfF(F.current, f)

  const paint = () => {
    const f = sf.current!.x
    const g = sg.current!.x
    if (brush.current) {
      brush.current.style.left = f * 100 + '%'
      brush.current.style.width = Math.max(0, g - f) * 100 + '%'
    }
    if (shadeL.current) shadeL.current.style.width = Math.max(0, f) * 100 + '%'
    if (shadeR.current) shadeR.current.style.left = Math.min(1, g) * 100 + '%'
    const lb = label.current
    const tr = track.current
    if (lb && tr) {
      lb.textContent = spanText(msOf(f), msOf(g))
      const w = lb.offsetWidth
      lb.style.transform = `translateX(${clamp(((f + g) / 2) * tr.clientWidth - w / 2, 0, Math.max(0, tr.clientWidth - w))}px)`
    }
  }
  const sf = useRef<Spring | null>(null)
  const sg = useRef<Spring | null>(null)
  if (!sf.current) {
    sf.current = new Spring(fOf(range.from), { response: 0.42, damping: 0.86, rest: 0.0004, onUpdate: () => paint() })
    sg.current = new Spring(fOf(range.to), { response: 0.42, damping: 0.86, rest: 0.0004, onUpdate: () => paint() })
  }
  const drag = useRef<null | { mode: 'l' | 'r' | 'body' | 'new'; x0: number; f0: number; g0: number; anchor: number; moved: boolean; W: number; left: number }>(null)
  const vt = useRef(new VelocityTracker())
  const raf = useRef(0)

  // the period changed from outside (preset, dates) or the strip refolded: travel there
  useLayoutEffect(() => {
    if (drag.current) return
    sf.current!.to(fOf(range.from))
    sg.current!.to(fOf(range.to))
  }, [range.from, range.to, fold])
  useLayoutEffect(() => {
    const tr = track.current
    if (!tr) return
    const ro = new ResizeObserver(() => {
      setW(tr.clientWidth)
      paint()
    })
    ro.observe(tr)
    return () => ro.disconnect()
  }, [])
  useLayoutEffect(() => paint())

  const commitLive = () => {
    if (raf.current) return
    raf.current = requestAnimationFrame(() => {
      raf.current = 0
      onRange({ from: msOf(sf.current!.x), to: msOf(sg.current!.x), preset: 'custom' })
    })
  }
  const fx = (clientX: number, d: { left: number; W: number }) => clamp((clientX - d.left) / d.W, 0, 1)
  /** the day under the pointer; inside a crease, the whole folded stretch */
  const cellAt = (f: number): [number, number] => {
    const u = f * F.current.U
    const s = F.current.segs.find((x) => u >= x.u0 && u <= x.u1)
    if (s?.gap) return [a + s.d0 * DAY_MS, a + s.d1 * DAY_MS]
    const d = dayStart(msOf(f))
    return [d, addDays(d, 1)]
  }
  const down = (e: React.PointerEvent) => {
    if (e.button) return
    const tr = track.current!
    const r = tr.getBoundingClientRect()
    const h = (e.target as HTMLElement).closest<HTMLElement>('[data-h]')?.dataset.h as 'l' | 'r' | 'body' | undefined
    sf.current!.stop()
    sg.current!.stop()
    const f = clamp((e.clientX - r.left) / r.width, 0, 1)
    drag.current = { mode: h || 'new', x0: e.clientX, f0: sf.current!.x, g0: sg.current!.x, anchor: dayStart(msOf(f)), moved: false, W: r.width, left: r.left }
    vt.current.reset()
    vt.current.add(e.clientX, 0)
    capture(tr, e.pointerId)
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    vt.current.add(e.clientX, 0)
    if (!d.moved && Math.abs(e.clientX - d.x0) < 4) return
    d.moved = true
    const dx = (e.clientX - d.x0) / d.W
    const rb = (over: number) => rubber(over * d.W, d.W) / d.W
    const minW = 6 / d.W
    if (d.mode === 'body') {
      const w = d.g0 - d.f0
      let f = d.f0 + dx
      if (f < 0) f = -rb(-f)
      if (f + w > 1) f = 1 - w + rb(f + w - 1)
      sf.current!.set(f)
      sg.current!.set(f + w)
    } else if (d.mode === 'l') {
      let f = Math.min(d.f0 + dx, sg.current!.x - minW)
      if (f < 0) f = -rb(-f)
      sf.current!.set(f)
    } else if (d.mode === 'r') {
      let g = Math.max(d.g0 + dx, sf.current!.x + minW)
      if (g > 1) g = 1 + rb(g - 1)
      sg.current!.set(g)
    } else {
      const c = dayStart(msOf(fx(e.clientX, d)))
      sf.current!.set(fOf(Math.min(d.anchor, c)))
      sg.current!.set(fOf(addDays(Math.max(d.anchor, c), 1)))
    }
    commitLive()
  }
  const up = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    cancelAnimationFrame(raf.current)
    raf.current = 0
    const v = vt.current.get().x / d.W
    let lo: number
    let hi: number
    if (!d.moved) [lo, hi] = cellAt(fx(e.clientX, d))
    else if (d.mode === 'body') {
      const wd = Math.max(1, Math.round((msOf(d.g0) - msOf(d.f0)) / DAY_MS))
      lo = snapDay(msOf(sf.current!.x + project(v * d.W, 0.99) / d.W))
      hi = addDays(lo, wd)
      if (hi > b) {
        hi = b
        lo = addDays(b, -wd)
      }
      if (lo < a) {
        lo = a
        hi = addDays(a, wd)
      }
    } else {
      lo = d.mode === 'r' ? range.from : snapDay(msOf(sf.current!.x))
      hi = d.mode === 'l' ? range.to : snapDay(msOf(sg.current!.x))
      if (d.mode === 'new') {
        lo = msOf(sf.current!.x)
        hi = msOf(sg.current!.x)
      }
      if (hi - lo < DAY_MS / 2) {
        if (d.mode === 'l') lo = addDays(dayStart(hi - 1), 0)
        else hi = addDays(dayStart(lo), 1)
      }
    }
    lo = clamp(lo, a, b)
    hi = clamp(hi, a, b)
    sf.current!.to(fOf(lo), { velocity: d.moved ? v : 0, damping: 0.86 })
    sg.current!.to(fOf(hi), { velocity: d.moved ? v : 0, damping: 0.86 })
    onRange({ from: lo, to: hi, preset: 'custom' })
  }
  const key = (h: 'l' | 'r' | 'body') => (e: React.KeyboardEvent) => {
    const k = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
    if (!k) return
    e.preventDefault()
    let lo = dayStart(range.from)
    let hi = snapDay(range.to)
    if (hi <= lo) hi = addDays(lo, 1)
    if (h === 'body') {
      lo = addDays(lo, k)
      hi = addDays(hi, k)
      if (lo < a || hi > b) return
    } else if (h === 'l') lo = clamp(addDays(lo, k), a, addDays(hi, -1))
    else hi = clamp(addDays(hi, k), addDays(lo, 1), b)
    onRange({ from: lo, to: hi, preset: 'custom' })
  }

  const pct = (f: number) => `${f * 100}%`
  const H = 46
  const pxU = W / fold.U
  const k = (v: number) => (v ? Math.max(2, (v / hist.max) * H) : 0)
  const today = daysBetween(a, t)
  return (
    <div className="j-scale">
      <div className="j-top" aria-hidden="true">
        <span className="j-lbl" ref={label} />
      </div>
      <div className="j-track" ref={track} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <div className="j-hist" aria-hidden="true">
          {fold.segs.map((s) =>
            s.gap ? (
              <span key={s.d0} className="j-fold" style={{ flexGrow: s.u1 - s.u0 }} title={`Нет событий: ${s.d1 - s.d0} ${plural(s.d1 - s.d0, 'день', 'дня', 'дней')}`}>
                <i />
              </span>
            ) : (
              Array.from({ length: s.d1 - s.d0 }, (_, j) => {
                const i = s.d0 + j
                const c = hist.cols[i]
                const tot = c.ep + c.ed + c.wp + c.wd
                return (
                  <span key={i} className="j-col" data-today={i === today || undefined} data-empty={!tot || undefined}>
                    <span className="j-bar">
                      <i className="wd" style={{ height: k(c.wd) }} />
                      <i className="wp" style={{ height: k(c.wp) }} />
                      <i className="ed" style={{ height: k(c.ed) }} />
                      <i className="ep" style={{ height: k(c.ep) }} />
                    </span>
                    {tot > 0 && pxU >= 26 && <b className="j-n">{tot}</b>}
                  </span>
                )
              })
            ),
          )}
        </div>
        <div className="j-plan" aria-hidden="true">
          {stages.map((s) => {
            if (s.end + DAY_MS <= a || s.start >= b) return null
            const l = fOfMs(fold, Math.max(a, s.start))
            const r = fOfMs(fold, Math.min(b, s.end + DAY_MS))
            if (r - l <= 0) return null
            return (
              <span key={s.id} className="j-stage" style={{ left: pct(l), width: `calc(${pct(r - l)} - 2px)` }} title={`Этап ${s.n} «${s.name}»`}>
                {(r - l) * W > 16 && <em>{s.n}</em>}
              </span>
            )
          })}
        </div>
        <div className="j-now" style={{ left: pct(fOfMs(fold, t)) }} aria-hidden="true" />
        <div className="j-shade l" ref={shadeL} />
        <div className="j-shade r" ref={shadeR} />
        <div className="j-brush" ref={brush} data-h="body" tabIndex={0} role="group" aria-label="Выбранный период. Стрелки сдвигают на день" onKeyDown={key('body')}>
          <button type="button" className="j-h l" data-h="l" aria-label="Начало периода" onKeyDown={(e) => { e.stopPropagation(); key('l')(e) }}>
            <i />
          </button>
          <button type="button" className="j-h r" data-h="r" aria-label="Конец периода" onKeyDown={(e) => { e.stopPropagation(); key('r')(e) }}>
            <i />
          </button>
        </div>
      </div>
      <div className="j-axis" aria-hidden="true">
        {fold.segs.map((s) => {
          const left = pct(s.u0 / fold.U)
          if (s.gap) {
            const days = s.d1 - s.d0
            return (
              <span key={s.d0} className="j-gap" style={{ left, width: pct((s.u1 - s.u0) / fold.U) }}>
                {days >= 60 ? `${Math.round(days / 30)} мес.` : `${days} дн.`}
              </span>
            )
          }
          const out = []
          for (let i = s.d0; i < s.d1; i++) {
            const d = addDays(a, i)
            const dt = new Date(d)
            const first = i === s.d0 || dt.getDate() === 1
            const every = pxU >= 34 ? 1 : pxU >= 20 ? 2 : pxU >= 12 ? 5 : 0
            if (!first && (!every || dt.getDate() % every)) continue
            out.push(
              <span key={i} className={`j-day-l${first ? ' first' : ''}${i === today ? ' today' : ''}`} style={{ left: pct((s.u0 + (i - s.d0)) / fold.U), width: pct(1 / fold.U) }}>
                {first ? `${dt.getDate()} ${MONTHS_S[dt.getMonth()]}` : dt.getDate()}
              </span>,
            )
          }
          return out
        })}
      </div>
    </div>
  )
}

/* ── Act: options on the left, the real A4 page on the right ───────────────── */
function Act({
  project,
  user,
  range,
  items,
  stages,
  settings,
  opts,
  setOpts,
  total,
  onRange,
}: {
  project: ProjectItem
  user: string
  range: Range
  items: UiEvent[]
  stages: Stage[]
  settings: Settings
  opts: ActOptions
  setOpts: (o: ActOptions) => void
  total: number
  onRange: (r: Range) => void
}) {
  const [formedAt] = useState(() => Date.now())
  const html = useMemo(() => buildAct({ project, user, from: range.from, to: range.to, items, stages, settings, opts, formedAt }), [project, user, range.from, range.to, items, stages, settings, opts, formedAt])
  const frame = useRef<HTMLIFrameElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [k, setK] = useState(1)
  const [h, setH] = useState(1123)
  useLayoutEffect(() => {
    const b = box.current
    if (!b) return
    const ro = new ResizeObserver(() => setK(Math.min(1, (b.clientWidth - 40) / A4)))
    ro.observe(b)
    return () => ro.disconnect()
  }, [])
  // the sheet is as tall as the act: watch the page body inside the frame
  useEffect(() => {
    const f = frame.current
    if (!f) return
    let ro: ResizeObserver | null = null
    const attach = () => {
      const d = f.contentDocument
      const w = f.contentWindow as (Window & { ResizeObserver?: typeof ResizeObserver }) | null
      if (!d?.body || !w) return
      const m = () => setH(Math.max(600, Math.ceil(d.body.getBoundingClientRect().height)))
      m()
      ro?.disconnect()
      ro = new (w.ResizeObserver || ResizeObserver)(m)
      ro.observe(d.body)
    }
    f.addEventListener('load', attach)
    attach()
    return () => {
      f.removeEventListener('load', attach)
      ro?.disconnect()
    }
  }, [html])
  const print = () => {
    const w = frame.current?.contentWindow
    if (!w) return
    w.focus()
    w.print()
  }
  const openTab = () => {
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
    window.open(url, '_blank', 'noopener')
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
  const demo = items.filter((e) => e.demo).length
  const opt = (key: keyof ActOptions, title: string, desc: string) => (
    <div className="a-opt">
      <div>
        <b>{title}</b>
        <small>{desc}</small>
      </div>
      <button type="button" className="toggle" role="switch" aria-checked={opts[key]} aria-label={title} onClick={() => setOpts({ ...opts, [key]: !opts[key] })}>
        <span className="sw" />
      </button>
    </div>
  )
  return (
    <div className="a-wrap">
      <aside className="a-side">
        <div className="a-block">
          <span className="kicker">Период</span>
          <div className="a-dates">
            <label>
              С
              <input className="input" type="date" value={toDateInput(range.from)} max={toDateInput(range.to - 1)} onChange={(e) => e.target.value && onRange({ from: fromDateInput(e.target.value), to: range.to, preset: 'custom' })} />
            </label>
            <label>
              по
              <input className="input" type="date" value={toDateInput(Math.max(range.from, range.to - 1))} min={toDateInput(range.from)} onChange={(e) => e.target.value && onRange({ from: range.from, to: addDays(fromDateInput(e.target.value), 1), preset: 'custom' })} />
            </label>
          </div>
          <p className="a-note">
            {hhmm(range.from)} {fmtDay(range.from)} – {hhmm(range.to)} {fmtDay(range.to)}
            {range.preset === 'shift' && ` · смена ${clock(settings.shiftFrom)}–${clock(settings.shiftTo)}`}
          </p>
        </div>
        <div className="a-block">
          <span className="kicker">Записи</span>
          <p className="a-count">
            <b>
              <Roll value={items.length} />
            </b>{' '}
            из {total} {plural(total, 'события', 'событий', 'событий')} периода
          </p>
          <p className="a-note">
            {total > items.length ? 'Снятые галочки и фильтры журнала не входят. ' : 'В акт идут события, видимые в журнале. '}
            {demo > 0 && `${demo} в демо-режиме: в акте это помечено. `}
            Примеры с сервера в акт не попадают.
          </p>
        </div>
        <div className="a-block">
          <span className="kicker">Что включить</span>
          {opt('summary', 'Сводка', 'Сколько отклонений, предупреждений и решений')}
          {opt('photos', 'Кадры событий', 'Основной кадр каждого события')}
          {opt('method', 'Как система делает выводы', 'Источник требований и параметры контроля')}
          {opt('signatures', 'Строки для подписей', 'Пустые строки: фамилии вписываются от руки')}
        </div>
        <div className="a-go">
          <button type="button" className="btn plan" onClick={print} disabled={!items.length}>
            Печать или PDF
          </button>
          <button type="button" className="btn" onClick={openTab}>
            Открыть в новой вкладке
          </button>
          <p className="a-note">Чтобы получить PDF, выберите в окне печати «Сохранить как PDF». На сервере акт не хранится.</p>
        </div>
      </aside>
      <div className="a-preview" ref={box}>
        <div className="a-paper" style={{ width: A4 * k, height: h * k }}>
          <iframe ref={frame} title="Предпросмотр акта" srcDoc={html} style={{ width: A4, height: h, transform: `scale(${k})` }} />
        </div>
      </div>
    </div>
  )
}
