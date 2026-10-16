import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Observation, Profile, Stage, UiEvent } from '../model'
import { LV, LV_ORDER } from '../model'
import { CODES, MACH, Sil, type Code } from '../lib/machinery'
import { DAY_MS, MONTHS_S, dayStart, fmtDay, hhmm } from '../lib/format'
import { Spring, VelocityTracker, capture, clamp, easeOut, lerp, project, rubber } from '../lib/spring'
import { Chevron } from './common'

const DEMAND: Code[] = ['excavator', 'dump_truck', 'bulldozer', 'tower_crane', 'concrete_mixer', 'concrete_pump', 'truck_crane', 'loader', 'roller', 'grader']

export function Dock({
  stages,
  current,
  t,
  obs,
  events,
  profiles,
  needProfiles,
  onRule,
  onOpenEvent,
  onUploadPlan,
  onSeek,
  open,
  setOpen,
  shift,
}: {
  stages: Stage[]
  current: Stage | null
  t: number
  obs: Observation
  events: UiEvent[]
  profiles: Map<string, Profile>
  needProfiles: () => void
  onRule: (code: Code, el: HTMLElement, stageId: string) => void
  onOpenEvent: (id: string, el: HTMLElement) => void
  onUploadPlan: (f: File) => void
  onSeek: (t: number) => void
  open: boolean
  setOpen: (o: boolean) => void
  shift: { from: number; to: number }
}) {
  const dock = useRef<HTMLElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const pRef = useRef(0)
  const [sel, setSel] = useState<string | null>(null)
  const selStage = stages.find((s) => s.id === sel) || current || stages[0] || null
  const span = stages.length ? { from: stages[0].start - 3 * DAY_MS, to: stages[stages.length - 1].end + 8 * DAY_MS } : null

  const limits = useCallback(() => {
    const mob = matchMedia('(max-width: 860px)').matches
    const min = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-min')) || 104
    const app = document.querySelector('.app') as HTMLElement | null
    const max = mob ? innerHeight - 24 : Math.max(min + 200, (app?.clientHeight || innerHeight) - 62)
    return { min, max, mob }
  }, [])

  /* geometry: the folded strip and the gantt share one x scale; only y and height change */
  const layout = useCallback(
    (p: number) => {
      const b = body.current
      if (!b || !span) return
      const { mob } = limits()
      const gut = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gut')) || 20
      const W = b.clientWidth
      const left = lerp(mob ? gut : gut + 252, mob ? gut : gut + 252, easeOut(p))
      const right = lerp(gut, mob ? gut : gut + 380, easeOut(p))
      const w = W - left - right
      const x = (d: number) => ((d - span.from) / (span.to - span.from)) * w
      const rowTop = mob ? 92 : 98
      const rowH = mob ? 54 : 44
      const stripTop = mob ? 42 : 2
      const pc = b.querySelector<HTMLElement>('.plan-canvas')
      if (pc) {
        pc.style.left = left + 'px'
        pc.style.right = right + 'px'
      }
      stages.forEach((s, i) => {
        const bar = b.querySelector<HTMLElement>(`.p-bar[data-id="${s.id}"]`)
        if (!bar) return
        // складной метр: each segment drops from the strip into its row, staggered
        const n = Math.max(1, stages.length - 1)
        const pi = easeOut(clamp((p - i * (0.28 / n)) / (1 - 0.28), 0, 1))
        const rowY = mob ? rowTop + i * rowH + 38 : rowTop + i * rowH + 14
        const top = lerp(stripTop, rowY, pi)
        const h = lerp(mob ? 4 : 6, mob ? 8 : 16, pi)
        const L = x(s.start)
        const R = x(s.end + DAY_MS)
        bar.style.transform = `translate(${L}px, ${top}px)`
        bar.style.width = Math.max(2, R - L - 2) + 'px'
        bar.style.height = h + 'px'
      })
      const now = b.querySelector<HTMLElement>('.p-now')
      if (now) {
        now.style.transform = `translateX(${x(dayStart(t))}px)`
        now.style.top = stripTop - 3 + 'px'
        now.style.opacity = String(1 - clamp(p * 3, 0, 1))
      }
      const fade = 1 - clamp(p / 0.25, 0, 1)
      for (const sel of ['.day', '.dock-lead', '.dock-note']) {
        const el = b.querySelector<HTMLElement>(sel)
        if (!el) continue
        el.style.opacity = String(fade)
        el.style.pointerEvents = p > 0.1 ? 'none' : ''
        if (sel === '.day') el.style.transform = `translateY(${p * 24}px)`
      }
      const head = b.querySelector<HTMLElement>('.pf-head')
      if (head) {
        const o = clamp((p - 0.35) / 0.4, 0, 1)
        head.style.opacity = String(o)
        head.style.transform = `translateY(${(1 - o) * 12}px)`
      }
      const months = b.querySelector<HTMLElement>('.pf-months')
      if (months) {
        months.style.left = left + 'px'
        months.style.right = right + 'px'
        months.style.top = rowTop - 26 + 'px'
        months.style.height = stages.length * rowH + 30 + 'px'
        months.style.opacity = String(clamp((p - 0.4) / 0.4, 0, 1))
        for (const m of Array.from(months.children) as HTMLElement[]) m.style.left = x(Number(m.dataset.t)) + 'px'
      }
      const grid = b.querySelector<HTMLElement>('.pf-grid')
      if (grid) {
        Object.assign(grid.style, { left: left + 'px', right: right + 'px', top: rowTop + 'px', height: stages.length * rowH + 'px', opacity: String(clamp((p - 0.5) / 0.4, 0, 1)) })
        const td = grid.querySelector<HTMLElement>('.pf-today')
        if (td) Object.assign(td.style, { left: x(dayStart(t)) + 'px', top: '0', height: stages.length * rowH + 'px' })
      }
      const rows = b.querySelector<HTMLElement>('.pf-rows')
      if (rows) {
        rows.style.top = rowTop + 'px'
        Array.from(rows.children).forEach((r, i) => {
          const el = r as HTMLElement
          const o = clamp((p - 0.45 - i * 0.03) / 0.3, 0, 1)
          el.style.top = i * rowH + 'px'
          el.style.opacity = String(o)
          el.style.transform = `translateX(${(1 - o) * -10}px)`
          el.tabIndex = p > 0.5 ? 0 : -1
        })
      }
      const dm = b.querySelector<HTMLElement>('.pf-demand')
      if (dm) {
        dm.style.top = rowTop + stages.length * rowH + 34 + 'px'
        const o = clamp((p - 0.62) / 0.38, 0, 1)
        dm.style.opacity = String(o)
        dm.style.visibility = o < 0.02 ? 'hidden' : 'visible'
        dm.style.display = mob ? 'none' : ''
        const legend = dm.querySelector<HTMLElement>('.dm-legend')
        if (legend) legend.style.left = left - gut + 'px'
        dm.querySelectorAll<HTMLElement>('.dm-row').forEach((row, i) => {
          row.style.top = 28 + i * 22 + 'px'
          row.querySelectorAll<HTMLElement>('.dm-cell').forEach((cell, j) => {
            const s = stages[j]
            const L = x(s.start)
            const R = x(s.end + DAY_MS)
            cell.style.left = left - gut + L + 'px'
            cell.style.width = Math.max(2, R - L - 2) + 'px'
            cell.tabIndex = p > 0.5 ? 0 : -1
          })
        })
      }
      const det = b.querySelector<HTMLElement>('.pf-detail')
      if (det) {
        const o = clamp((p - 0.6) / 0.4, 0, 1)
        if (mob) {
          det.style.top = rowTop + stages.length * rowH + 14 + 'px'
          det.style.bottom = 'auto'
        } else {
          det.style.top = rowTop - 26 + 'px'
          det.style.bottom = '14px'
        }
        det.style.opacity = String(o)
        det.style.transform = `translateX(${(1 - o) * 30}px)`
        det.style.visibility = o < 0.02 ? 'hidden' : 'visible'
      }
      const full = b.querySelector<HTMLElement>('.plan-full')
      if (full) {
        full.dataset.open = String(p > 0.5)
        full.style.overflow = mob && p > 0.5 ? 'auto' : ''
      }
    },
    [limits, span?.from, span?.to, stages, t],
  )

  const spring = useRef<Spring | null>(null)
  if (!spring.current)
    spring.current = new Spring(0, {
      response: 0.46,
      damping: 0.86,
      rest: 0.3,
      onUpdate: (h) => {
        const d = dock.current
        if (!d) return
        const { min, max } = limits()
        d.style.height = h + 'px'
        pRef.current = clamp((h - min) / (max - min), 0, 1)
        layoutRef.current(pRef.current)
        document.body.dataset.plan = pRef.current > 0.5 ? 'open' : ''
      },
    })
  const layoutRef = useRef(layout)
  layoutRef.current = layout

  useLayoutEffect(() => {
    const { min } = limits()
    if (!spring.current!.moving && !open) spring.current!.set(min)
    layout(pRef.current)
  })
  useEffect(() => {
    const { min, max } = limits()
    spring.current!.to(open ? max : min, { damping: 0.9 })
    if (open) needProfiles()
  }, [open, limits, needProfiles])
  useEffect(() => {
    const onResize = () => {
      const { min, max } = limits()
      spring.current!.set(open ? max : min)
    }
    addEventListener('resize', onResize)
    return () => removeEventListener('resize', onResize)
  }, [open, limits])

  /* drag the grip (or the folded strip) up and down, with momentum projection */
  const drag = useRef<{ y: number; h: number; moved: boolean } | null>(null)
  const vt = useRef(new VelocityTracker())
  const gripDown = (e: React.PointerEvent) => {
    if (e.button) return
    spring.current!.stop()
    drag.current = { y: e.clientY, h: dock.current!.getBoundingClientRect().height, moved: false }
    vt.current.reset()
    vt.current.add(0, e.clientY)
    capture(e.currentTarget, e.pointerId)
  }
  const gripMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    vt.current.add(0, e.clientY)
    const dy = d.y - e.clientY
    if (Math.abs(dy) > 4) d.moved = true
    const { min, max } = limits()
    let h = d.h + dy
    if (h > max) h = max + rubber(h - max, innerHeight)
    if (h < min) h = min - rubber(min - h, 200)
    spring.current!.set(h)
  }
  const gripUp = () => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (!d.moved) {
      setOpen(!open)
      return
    }
    const v = -vt.current.get().y
    const { min, max } = limits()
    const proj = spring.current!.x + project(v, 0.99)
    const next = Math.abs(proj - max) < Math.abs(proj - min)
    if (next === open) spring.current!.to(open ? max : min, { velocity: v, damping: 0.8 })
    else {
      spring.current!.to(next ? max : min, { velocity: v, damping: 0.8 })
      setOpen(next)
    }
  }
  const dragProps = { onPointerDown: gripDown, onPointerMove: gripMove, onPointerUp: gripUp, onPointerCancel: gripUp }

  const months: number[] = []
  if (span) {
    const d = new Date(span.from)
    d.setDate(1)
    d.setMonth(d.getMonth() + 1)
    while (d.getTime() < span.to) {
      months.push(d.getTime())
      d.setMonth(d.getMonth() + 1)
    }
  }
  const prof = selStage ? profiles.get(selStage.id) : undefined

  return (
    <section className="dock" ref={dock} aria-label="План и время">
      <div className="grip" role="button" tabIndex={0} aria-expanded={open} aria-label={open ? 'Свернуть план работ' : 'Развернуть план работ'} {...dragProps} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setOpen(!open))}>
        <i />
      </div>
      <div className="dock-body" ref={body}>
        <div className="dock-lead">
          {stages.length ? (
            <>
              <span className="kicker">
                {current ? `Этап ${current.n} из ${stages.length} · день ${Math.round((dayStart(t) - current.start) / DAY_MS) + 1}/${current.days}` : `Вне плана · ${fmtDay(t)}`}
              </span>
              <strong title={current?.name}>{current?.name || 'Нет этапа на эту дату'}</strong>
              <button type="button" onClick={() => setOpen(!open)} aria-controls="planFull">
                <Chevron up />
                <span>План работ</span>
              </button>
            </>
          ) : (
            <>
              <span className="kicker">План работ</span>
              <strong>Не загружен</strong>
            </>
          )}
        </div>
        <div className="plan-canvas" {...dragProps}>
          {stages.map((s) => {
            const today = dayStart(t)
            const cls = today > s.end ? 'done' : today >= s.start ? 'active' : 'future'
            const prog = cls === 'active' ? (today - s.start) / Math.max(1, s.end - s.start) : 0
            return (
              <div key={s.id} className={`p-bar ${cls}`} data-id={s.id}>
                {cls === 'active' && <i className="p-fill" style={{ width: `${prog * 100}%` }} />}
              </div>
            )
          })}
          {stages.length > 0 && <div className="p-now" />}
        </div>
        <DayRuler t={t} obs={obs} events={events} onOpenEvent={onOpenEvent} onSeek={onSeek} shift={shift} />
        <div className="dock-note">{obs.mode === 'recording' ? 'Перетащите отметку, чтобы перемотать запись' : 'Архива кадров нет: шкала показывает текущий сеанс'}</div>
        <div className="plan-full" id="planFull" data-open="false">
          <div className="pf-head">
            <div>
              <span className="kicker">План работ · {stages.length} {stages.length === 1 ? 'этап' : 'этапов'}</span>
              <h2>{stages.length ? `${fmtDay(stages[0].start)} – ${fmtDay(stages[stages.length - 1].end)}` : 'План не загружен'}</h2>
              <p>Сопоставлено со справочником: {stages.filter((s) => s.catalog).length} из {stages.length}</p>
            </div>
            <div className="pf-actions">
              <label className="btn small">
                Загрузить .xlsx или .csv
                <input type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => e.target.files?.[0] && onUploadPlan(e.target.files[0])} />
              </label>
              <button type="button" className="btn small" onClick={() => setOpen(false)}>
                Свернуть
              </button>
            </div>
          </div>
          <div className="pf-months">
            {months.map((m) => {
              const d = new Date(m)
              return (
                <span key={m} data-t={m}>
                  {MONTHS_S[d.getMonth()]}
                  {d.getMonth() === 0 ? ` ’${String(d.getFullYear()).slice(2)}` : ''}
                </span>
              )
            })}
          </div>
          <div className="pf-grid">
            <div className="pf-today">
              <span>{fmtDay(t)}</span>
            </div>
          </div>
          <div className="pf-rows">
            {stages.map((s) => {
              const today = dayStart(t)
              const state = today > s.end ? 'завершён по плану' : today >= s.start ? 'идёт сейчас' : ''
              return (
                <button key={s.id} type="button" className="pf-row" aria-current={s.id === selStage?.id} onClick={() => setSel(s.id)}>
                  <span className="n">{s.n}</span>
                  <span className="t">
                    <b>{s.name}</b>
                    <small className={state === 'идёт сейчас' ? 'active' : ''}>
                      {fmtDay(s.start)} – {fmtDay(s.end)} · {s.days} дн.{state ? ` · ${state}` : ''}
                    </small>
                  </span>
                </button>
              )
            })}
          </div>
          <div className="pf-demand">
            <div className="dm-head">
              <span className="kicker">Какая техника нужна по плану</span>
            </div>
            <div className="dm-legend">
              <span><i style={{ background: 'var(--plan)' }} />обязательна</span>
              <span><i style={{ background: 'rgba(207,157,61,.42)' }} />рекомендуется</span>
              <span><i style={{ background: 'rgba(207,157,61,.12)' }} />допустима</span>
              <span><i style={{ background: 'var(--hatch)', boxShadow: 'inset 0 0 0 1px var(--line-2)' }} />не учитывается</span>
              <span><i style={{ background: 'var(--fg)', width: 5, height: 5, borderRadius: '50%' }} />изменено вручную</span>
            </div>
            {DEMAND.map((c) => (
              <div key={c} className="dm-row">
                <span>
                  <Sil code={c} ink="dim" />
                  {MACH[c].name}
                </span>
                {stages.map((s) => {
                  const r = profiles.get(s.id)?.rules[c]
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`dm-cell ${r ? 'l-' + r.lvl : 'l-load'}${r?.edited ? ' edited' : ''}`}
                      disabled={!r}
                      onClick={(e) => onRule(c, e.currentTarget, s.id)}
                      title={r ? `${MACH[c].name} · этап ${s.n} · ${LV[r.lvl].label.toLowerCase()} · ${Math.round(r.p * 100)}%` : 'Загружаем профиль'}
                      aria-label={r ? `${MACH[c].name}, этап ${s.n}: ${LV[r.lvl].label.toLowerCase()}` : 'Загружаем'}
                    />
                  )
                })}
              </div>
            ))}
          </div>
          <aside className="pf-detail">
            {selStage ? (
              <>
                <span className="kicker">
                  Этап {selStage.n} · {selStage.days} дн.
                </span>
                <h3>{selStage.name}</h3>
                <div className="meta">
                  {fmtDay(selStage.start)} – {fmtDay(selStage.end)}
                  <br />
                  {selStage.catalog ? `Справочник: ${selStage.catalog}${selStage.similarity != null ? ` · сходство ${selStage.similarity.toFixed(2).replace('.', ',')}` : ''}` : 'Не сопоставлен со справочником'}
                </div>
                <div className="req-list">
                  {!prof && <div className="skeleton"><i /><i /></div>}
                  {prof &&
                    LV_ORDER.map((lv) => {
                      const items = CODES.map((c) => prof.rules[c]).filter((r) => r.lvl === lv).sort((a, b) => b.p - a.p)
                      if (!items.length) return null
                      return (
                        <div key={lv} className="req-group">
                          <span className="kicker">{LV[lv].group}{lv === 'no' ? ' · вне плана' : ''}</span>
                          {items.map((r) => (
                            <button key={r.code} type="button" className="req" onClick={(e) => onRule(r.code, e.currentTarget, selStage.id)}>
                              <Sil code={r.code} ink={lv === 'req' || lv === 'rec' ? 'ghost' : 'dim'} />
                              <span className="r-name">
                                {MACH[r.code].name}
                                {r.edited && <small className="edited">изменено вручную · по справочнику {LV[r.base].label.toLowerCase()}</small>}
                              </span>
                              <span className="r-p">{Math.round(r.p * 100)}%</span>
                              <span className="r-bar">
                                <i style={{ width: `${r.p * 100}%` }} />
                              </span>
                            </button>
                          ))}
                        </div>
                      )
                    })}
                </div>
              </>
            ) : (
              <p className="hint">Загрузите план, чтобы увидеть этапы.</p>
            )}
          </aside>
        </div>
      </div>
    </section>
  )
}

/* Day ruler. Live: today's shift, what this session analysed, events; nothing to scrub, there is
   no frame archive. Recording: the span of the file; the playhead seeks with momentum and is
   pulled to events. */
function DayRuler({ t, obs, events, onOpenEvent, onSeek, shift }: { t: number; obs: Observation; events: UiEvent[]; onOpenEvent: (id: string, el: HTMLElement) => void; onSeek: (t: number) => void; shift: { from: number; to: number } }) {
  const el = useRef<HTMLDivElement>(null)
  const [w, setW] = useState(600)
  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => el.current && setW(el.current.clientWidth))
    if (el.current) ro.observe(el.current)
    return () => ro.disconnect()
  }, [])
  const rec = obs.recording
  const d0 = dayStart(t)
  const from = rec ? rec.start : d0 + 6 * 3600_000
  const to = rec ? rec.start + Math.max(60_000, rec.duration || 60_000) : d0 + 20 * 3600_000
  const X = (v: number) => clamp(((v - from) / (to - from)) * w, 0, w)
  const T = (x: number) => from + (x / w) * (to - from)
  const ticks: { x: number; label: string; major: boolean }[] = []
  if (rec) {
    const stepMin = Math.max(1, Math.round((to - from) / 60_000 / 8))
    for (let m = 0; m * 60_000 <= to - from; m += stepMin) ticks.push({ x: X(from + m * 60_000), label: hhmm(from + m * 60_000), major: m % (stepMin * 2) === 0 })
  } else for (let h = 6; h <= 20; h++) ticks.push({ x: X(d0 + h * 3600_000), label: String(h).padStart(2, '0'), major: h % 3 === 0 })
  const dayEvents = events.filter((e) => e.at >= from && e.at <= to)

  const drag = useRef<{ r: DOMRect } | null>(null)
  const vt = useRef(new VelocityTracker())
  const ts = useRef<Spring | null>(null)
  if (!ts.current) ts.current = new Spring(0, { response: 0.4, damping: 1, rest: 200, onUpdate: (v) => onSeekRef.current(v) })
  const onSeekRef = useRef(onSeek)
  onSeekRef.current = onSeek
  const down = (e: React.PointerEvent) => {
    if (!rec) return
    ts.current!.stop()
    capture(e.currentTarget, e.pointerId)
    const r = e.currentTarget.getBoundingClientRect()
    drag.current = { r }
    vt.current.reset()
    vt.current.add(e.clientX, 0)
    onSeek(T(clamp(e.clientX - r.left, 0, r.width))) // respond on press
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    vt.current.add(e.clientX, 0)
    let x = e.clientX - d.r.left
    if (x > d.r.width) x = d.r.width + rubber(x - d.r.width, d.r.width * 0.3)
    if (x < 0) x = -rubber(-x, d.r.width * 0.3)
    onSeek(T(clamp(x, 0, d.r.width)))
  }
  const up = () => {
    const d = drag.current
    drag.current = null
    if (!d || !rec) return
    const vx = vt.current.get().x
    const xNow = X(t)
    const xProj = clamp(xNow + project(vx, 0.99), 0, d.r.width)
    // magnet: events pull the projected landing point
    let target = T(xProj)
    for (const ev of dayEvents) if (Math.abs(X(ev.at) - xProj) < 18) target = ev.at
    if (Math.abs(vx) < 40 && target === T(xProj)) return
    ts.current!.set(t)
    ts.current!.to(target, { velocity: vx * ((to - from) / d.r.width) })
  }
  const cov = obs.coverage().filter(([a, b]) => b >= from && a <= to)
  return (
    <div className="day" ref={el} role="slider" tabIndex={rec ? 0 : -1} aria-label={rec ? 'Позиция записи' : 'Время наблюдения'} aria-valuemin={from} aria-valuemax={to} aria-valuenow={Math.round(t)} aria-valuetext={hhmm(t)} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} style={{ cursor: rec ? 'ew-resize' : 'default' }}
      onKeyDown={(e) => {
        if (!rec) return
        if (e.key === 'ArrowLeft') onSeek(t - (e.shiftKey ? 60_000 : 5_000))
        if (e.key === 'ArrowRight') onSeek(t + (e.shiftKey ? 60_000 : 5_000))
      }}>
      <div className="d-track" />
      {!rec && <div className="d-shift" style={{ left: X(d0 + shift.from * 1000), width: X(d0 + shift.to * 1000) - X(d0 + shift.from * 1000) }} />}
      {cov.map(([a, b]) => (
        <div key={a} className="d-cov" style={{ left: X(a), width: Math.max(2, X(b) - X(a)) }} title={`Анализ ${hhmm(a)}–${hhmm(b)}`} />
      ))}
      {dayEvents.map((e) => (
        <button key={e.id} type="button" className="d-ev" data-sev={e.sev} data-done={String(e.status !== 'pending')} style={{ left: X(e.at) }} title={`${hhmm(e.at)} · ${e.title}`} aria-label={`${hhmm(e.at)}: ${e.title}`} onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => onOpenEvent(e.id, ev.currentTarget)} />
      ))}
      {!rec && <div className="d-nowmark" style={{ left: X(Date.now()) }} />}
      <div className="d-axis">
        {ticks.map((k) => (
          <span key={k.x + k.label} className={k.major ? 'major' : ''} style={{ left: k.x }}>
            {k.label}
          </span>
        ))}
      </div>
      <div className="d-head" style={{ transform: `translateX(${X(t)}px)` }}>
        {/* the label stays inside the ruler near its ends */}
        <span style={{ transform: `translateX(${X(t) > w - 34 ? '-100%' : X(t) < 34 ? '0%' : '-50%'})` }}>{obs.mode === 'live' ? 'сейчас' : hhmm(t)}</span>
      </div>
    </div>
  )
}
