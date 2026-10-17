import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Observation, Profile, Stage, UiEvent } from '../model'
import { LV, LV_ORDER, stageAt } from '../model'
import { CODES, MACH, Sil, type Code } from '../lib/machinery'
import { DAY_MS, MONTHS_S, addDays, dayStart, fmtDay, hhmm, plural } from '../lib/format'
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
  onResetStage,
  onOpenEvent,
  onUploadPlan,
  onSaveSchedule,
  onClearPlan,
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
  onResetStage: (stageId: string) => Promise<void>
  onOpenEvent: (id: string, el: HTMLElement) => void
  onUploadPlan: (f: File) => void
  onSaveSchedule: (changes: { id: string; start: number; end: number }[]) => Promise<void>
  onClearPlan: () => Promise<void>
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

  /* schedule editing: a draft moves one stage (and, if asked, the ones after it) by whole days.
     Bars show the draft through per-stage springs, so following stages ride along like coupled
     wagons; nothing reaches the server until "Сохранить". */
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [clearAsk, setClearAsk] = useState(false)
  // while saving, fresh dates from the server mean the draft is applied: show the plan as is
  const saveBase = useRef<Stage[] | null>(null)
  const live = saveBase.current && saveBase.current !== stages ? null : draft
  const edited = live ? stages.find((x) => x.id === live.id) ?? null : null
  const offsetFor = (s: Stage, d: Draft | null): [number, number] => {
    if (!d) return [0, 0]
    if (s.id === d.id) return [d.ds, d.de]
    const e = stages.find((x) => x.id === d.id)
    return d.cascade && e && s.n > e.n ? [d.de, d.de] : [0, 0]
  }
  const shownOf = (s: Stage, d: Draft | null = live): Stage => {
    const [a, b] = offsetFor(s, d)
    return a || b ? { ...s, start: addDays(s.start, a), end: addDays(s.end, b), days: s.days + b - a } : s
  }
  const shown = stages.map((s) => shownOf(s))
  const offs = useRef(new Map<string, { s: Spring; e: Spring }>())
  const queued = useRef(false)
  const relayout = () => {
    if (queued.current) return
    queued.current = true
    queueMicrotask(() => {
      queued.current = false
      layoutRef.current(pRef.current)
    })
  }
  const off = (id: string) => {
    let o = offs.current.get(id)
    if (!o) {
      o = { s: new Spring(0, { response: 0.42, damping: 0.84, rest: 0.004, onUpdate: relayout }), e: new Spring(0, { response: 0.42, damping: 0.84, rest: 0.004, onUpdate: relayout }) }
      offs.current.set(id, o)
    }
    return o
  }
  const committed = useRef(new Map<string, { start: number; end: number }>())
  const barDrag = useRef<null | { id: string; mode: 'start' | 'end' | 'move'; x0: number; s0: number; e0: number; ppd: number; days: number; moved: boolean; last: number }>(null)

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
        const o = offs.current.get(s.id)
        const L = x(s.start + (o ? o.s.x : 0) * DAY_MS)
        const R = x(s.end + DAY_MS + (o ? o.e.x : 0) * DAY_MS)
        bar.style.transform = `translate(${L}px, ${top}px)`
        bar.style.width = Math.max(2, R - L - 2) + 'px'
        bar.style.height = h + 'px'
      })
      const tip = b.querySelector<HTMLElement>('.p-tip')
      const bd = barDrag.current
      if (tip && bd) {
        const s = stages.find((z) => z.id === bd.id)
        const o = offs.current.get(bd.id)
        if (s && o) {
          const i = stages.indexOf(s)
          const edgeX = bd.mode === 'start' ? x(s.start + o.s.x * DAY_MS) : x(s.end + DAY_MS + o.e.x * DAY_MS)
          tip.style.transform = `translate(${(pc?.offsetLeft ?? left) + edgeX}px, ${(mob ? rowTop + i * rowH + 38 : rowTop + i * rowH + 14) - 26}px) translateX(-50%)`
        }
      }
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
            const o = offs.current.get(s.id)
            const L = x(s.start + (o ? o.s.x : 0) * DAY_MS)
            const R = x(s.end + DAY_MS + (o ? o.e.x : 0) * DAY_MS)
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
    for (const s of stages) {
      const o = off(s.id)
      // the plan itself moved (saved or undone): keep the bar where it is on screen, then settle
      const prev = committed.current.get(s.id)
      if (prev) {
        const ds = Math.round((s.start - prev.start) / DAY_MS)
        const de = Math.round((s.end - prev.end) / DAY_MS)
        if (ds) o.s.set(o.s.x - ds)
        if (de) o.e.set(o.e.x - de)
      }
      committed.current.set(s.id, { start: s.start, end: s.end })
      if (barDrag.current?.id === s.id) continue
      const [a, b] = offsetFor(s, live)
      o.s.to(a)
      o.e.to(b)
    }
    // offsetFor reads stages and the live draft
  }, [stages, live])
  useEffect(() => {
    if (!open) {
      setDraft(null)
      setClearAsk(false)
    }
  }, [open])

  /* drag a stage on the gantt: the ends change dates, the middle moves the whole stage */
  const barDown = (s: Stage) => (e: React.PointerEvent) => {
    if (e.button || pRef.current < 0.5 || limits().mob) return
    e.stopPropagation()
    const b = body.current
    if (!b || !span) return
    const gut = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gut')) || 20
    const w = b.clientWidth - (gut + 252) - (gut + 380)
    const ppd = w / ((span.to - span.from) / DAY_MS)
    const h = (e.target as HTMLElement).dataset.h as 'start' | 'end' | undefined
    const d = draft?.id === s.id ? draft : null
    setSel(s.id)
    barDrag.current = { id: s.id, mode: h || 'move', x0: e.clientX, s0: d?.ds ?? 0, e0: d?.de ?? 0, ppd, days: s.days, moved: false, last: NaN }
    if (draft && draft.id !== s.id) setDraft(null)
    vt.current.reset()
    vt.current.add(e.clientX, 0)
    capture(e.currentTarget, e.pointerId)
  }
  const barMove = (e: React.PointerEvent) => {
    const d = barDrag.current
    if (!d) return
    vt.current.add(e.clientX, 0)
    const dd = (e.clientX - d.x0) / d.ppd
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return
    if (!d.moved) {
      d.moved = true
      b0.current?.classList.add('editing')
    }
    const o = off(d.id)
    let so = o.s.x
    let eo = o.e.x
    if (d.mode === 'move') {
      so = d.s0 + dd
      eo = d.e0 + dd
    } else if (d.mode === 'end') eo = Math.max(d.e0 + dd, so - (d.days - 1))
    else so = Math.min(d.s0 + dd, eo + (d.days - 1))
    o.s.set(so)
    o.e.set(eo)
    const r = Math.round(eo)
    const rs = Math.round(so)
    if (r * 1000 + rs !== d.last) {
      d.last = r * 1000 + rs
      // followers ride along on their own springs, a beat behind the hand
      const cascade = draft?.cascade ?? true
      setDraft({ id: d.id, ds: rs, de: r, cascade })
    }
  }
  const barUp = () => {
    const d = barDrag.current
    if (!d) return
    barDrag.current = null
    b0.current?.classList.remove('editing')
    const o = off(d.id)
    const v = vt.current.get().x / d.ppd
    const ds = Math.round(o.s.x)
    const de = Math.round(o.e.x)
    o.s.to(ds, { velocity: d.mode !== 'end' ? v : 0, damping: 0.8 })
    o.e.to(de, { velocity: d.mode !== 'start' ? v : 0, damping: 0.8 })
    if (!d.moved) return
    setDraft(ds || de ? { id: d.id, ds, de, cascade: draft?.cascade ?? true } : null)
  }
  const b0 = body

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
          {shown.map((s) => {
            const today = dayStart(t)
            const cls = today > s.end ? 'done' : today >= s.start ? 'active' : 'future'
            const prog = cls === 'active' ? (today - s.start) / Math.max(1, s.end - s.start) : 0
            return (
              <div key={s.id} className={`p-bar ${cls}`} data-id={s.id} data-draft={live?.id === s.id || undefined} onPointerDown={barDown(s)} onPointerMove={barMove} onPointerUp={barUp} onPointerCancel={barUp}>
                {cls === 'active' && <i className="p-fill" style={{ width: `${prog * 100}%` }} />}
                <i className="p-h l" data-h="start" />
                <i className="p-h r" data-h="end" />
              </div>
            )
          })}
          {stages.length > 0 && <div className="p-now" />}
        </div>
        <span className="p-tip" aria-hidden="true">
          {live && edited ? (barDrag.current?.mode === 'start' ? fmtDay(addDays(edited.start, live.ds)) : fmtDay(addDays(edited.end, live.de))) : ''}
        </span>
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
              {clearAsk ? (
                <span className="confirm-row">
                  Удалить план из {stages.length} {plural(stages.length, 'этапа', 'этапов', 'этапов')}? Правила техники по этапам тоже пропадут.
                  <button
                    type="button"
                    className="btn small danger"
                    disabled={saving === 'clear'}
                    onClick={() => {
                      setSaving('clear')
                      onClearPlan().finally(() => {
                        setSaving(null)
                        setClearAsk(false)
                      })
                    }}
                  >
                    {saving === 'clear' ? 'Удаляем…' : 'Удалить план'}
                  </button>
                  <button type="button" className="btn small ghost" onClick={() => setClearAsk(false)}>
                    Отмена
                  </button>
                </span>
              ) : (
                <>
                  <label className="btn small">
                    Загрузить .xlsx или .csv
                    <input type="file" accept=".xlsx,.xls,.csv" hidden onChange={(e) => e.target.files?.[0] && onUploadPlan(e.target.files[0])} />
                  </label>
                  {stages.length > 0 && (
                    <button type="button" className="btn small ghost" onClick={() => setClearAsk(true)}>
                      Очистить план
                    </button>
                  )}
                  <button type="button" className="btn small" onClick={() => setOpen(false)}>
                    Свернуть
                  </button>
                </>
              )}
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
            {shown.map((s) => {
              const today = dayStart(t)
              const state = today > s.end ? 'завершён по плану' : today >= s.start ? 'идёт сейчас' : ''
              return (
                <button key={s.id} type="button" className="pf-row" aria-current={s.id === selStage?.id} onClick={() => setSel(s.id)}>
                  <span className="n">{s.n}</span>
                  <span className="t">
                    <b>{s.name}</b>
                    <small className={state === 'идёт сейчас' ? 'active' : ''} data-moved={(live && s.start !== stages.find((x) => x.id === s.id)?.start) || (live && s.end !== stages.find((x) => x.id === s.id)?.end) || undefined}>
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
              <span><i style={{ background: 'color-mix(in srgb, var(--plan) 42%, transparent)' }} />рекомендуется</span>
              <span><i style={{ background: 'color-mix(in srgb, var(--plan) 12%, transparent)' }} />допустима</span>
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
                <div className="meta">{selStage.catalog ? `Справочник: ${selStage.catalog}${selStage.similarity != null ? ` · сходство ${selStage.similarity.toFixed(2).replace('.', ',')}` : ''}` : 'Не сопоставлен со справочником'}</div>
                <Schedule
                  stage={selStage}
                  stages={stages}
                  draft={live?.id === selStage.id ? live : null}
                  shownOf={shownOf}
                  t={t}
                  current={current}
                  saving={saving === 'schedule'}
                  onDraft={setDraft}
                  onSave={async () => {
                    if (!live) return
                    const changes = stages.filter((s) => offsetFor(s, live).some(Boolean)).map((s) => {
                      const x = shownOf(s)
                      return { id: s.id, start: x.start, end: x.end }
                    })
                    setSaving('schedule')
                    saveBase.current = stages
                    try {
                      await onSaveSchedule(changes)
                      setDraft(null)
                    } finally {
                      saveBase.current = null
                      setSaving(null)
                    }
                  }}
                />
                {prof?.edited && (
                  <div className="req-reset">
                    <span>
                      Изменено вручную: {CODES.filter((c) => prof.rules[c].edited).length} из {CODES.length}
                    </span>
                    <button
                      type="button"
                      className="link"
                      disabled={saving === 'reset'}
                      onClick={() => {
                        setSaving('reset')
                        onResetStage(selStage.id).finally(() => setSaving(null))
                      }}
                    >
                      {saving === 'reset' ? 'Возвращаем…' : 'Вернуть все к исходным'}
                    </button>
                  </div>
                )}
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

interface Draft { id: string; ds: number; de: number; cascade: boolean }

function Schedule({
  stage,
  stages,
  draft,
  shownOf,
  t,
  current,
  saving,
  onDraft,
  onSave,
}: {
  stage: Stage
  stages: Stage[]
  draft: Draft | null
  shownOf: (s: Stage, d?: Draft | null) => Stage
  t: number
  current: Stage | null
  saving: boolean
  onDraft: (d: Draft | null) => void
  onSave: () => Promise<void>
}) {
  const [err, setErr] = useState<string | null>(null)
  const d = draft ?? { id: stage.id, ds: 0, de: 0, cascade: true }
  const x = shownOf(stage, d)
  const after = stages.filter((s) => s.n > stage.n)
  const set = (p: Partial<Draft>) => {
    const n = { ...d, ...p }
    if (stage.days + n.de - n.ds < 1) return
    onDraft(n.ds || n.de ? n : { ...n, ds: 0, de: 0 })
  }
  const editing = !!draft
  const last = stages[stages.length - 1]
  const lastShown = last ? shownOf(last, d) : null
  const nowAfter = stageAt(stages.map((s) => shownOf(s, d)), t)
  const delta = d.de
  const words = (n: number) => `${n > 0 ? '+' : '−'}${Math.abs(n)} ${plural(Math.abs(n), 'день', 'дня', 'дней')}`
  return (
    <div className="sched" data-editing={editing || undefined}>
      <div className="sched-top">
        <span className="kicker">Сроки</span>
        {!editing && (
          <button type="button" className="link" onClick={() => onDraft({ id: stage.id, ds: 0, de: 0, cascade: true })}>
            Изменить
          </button>
        )}
      </div>
      {!editing ? (
        <p className="sched-line">
          {fmtDay(stage.start)} – {fmtDay(stage.end)} · {stage.days} дн.
          <small>Можно потянуть края полосы на графике</small>
        </p>
      ) : (
        <>
          <div className="sched-grid">
            <span>Начало</span>
            <div className="stepper">
              <button type="button" aria-label="Начало раньше на день" onClick={() => set({ ds: d.ds - 1 })}>
                −
              </button>
              <output>{fmtDay(x.start)}</output>
              <button type="button" aria-label="Начало позже на день" onClick={() => set({ ds: d.ds + 1 })}>
                +
              </button>
            </div>
            <span>Окончание</span>
            <div className="stepper">
              <button type="button" aria-label="Окончание раньше на день" onClick={() => set({ de: d.de - 1 })}>
                −
              </button>
              <output>{fmtDay(x.end)}</output>
              <button type="button" aria-label="Окончание позже на день" onClick={() => set({ de: d.de + 1 })}>
                +
              </button>
            </div>
            <span>Длительность</span>
            <b>
              {x.days} дн.{x.days !== stage.days && <em>{words(x.days - stage.days)}</em>}
            </b>
          </div>
          {after.length > 0 && (
            <button type="button" className="toggle sched-cascade" role="switch" aria-checked={d.cascade} onClick={() => set({ cascade: !d.cascade })}>
              <span className="sw" />
              Сдвинуть следующие этапы ({after.length})
            </button>
          )}
          <p className="sched-impact">
            {!d.ds && !d.de
              ? 'Сроки пока не изменены.'
              : [
                  d.de ? `Окончание ${words(d.de)}: ${fmtDay(stage.end)} → ${fmtDay(x.end)}.` : '',
                  d.ds ? `Начало ${words(d.ds)}: ${fmtDay(stage.start)} → ${fmtDay(x.start)}.` : '',
                  after.length && delta
                    ? d.cascade
                      ? `Этапы ${after[0].n}–${after[after.length - 1].n} сдвинутся на ${words(delta).replace('+', '')}, план закончится ${fmtDay(lastShown!.end)}.`
                      : `Следующие этапы останутся на месте${delta > 0 && after[0].start <= x.end ? ', этап ' + after[0].n + ' начнётся раньше, чем закончится этот' : ''}.`
                    : '',
                  nowAfter?.id !== current?.id ? `Сверка на ${fmtDay(t)} пойдёт по этапу ${nowAfter ? `${nowAfter.n} «${nowAfter.name}»` : '— (вне плана)'} вместо ${current ? current.n : 'вне плана'}.` : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
          </p>
          {err && <p className="err-line">{err}</p>}
          <div className="form-actions">
            <button
              type="button"
              className="btn small plan"
              disabled={saving || (!d.ds && !d.de)}
              onClick={() => {
                setErr(null)
                onSave().catch((e: Error) => setErr(e.message))
              }}
            >
              {saving ? 'Сохраняем…' : 'Сохранить сроки'}
            </button>
            <button type="button" className="btn small ghost" onClick={() => onDraft(null)} disabled={saving}>
              Отмена
            </button>
          </div>
        </>
      )}
    </div>
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
        <button key={e.id} type="button" className="d-ev" data-sev={e.sev} data-done={String(e.status !== 'pending' || e.kind === 'stream')} style={{ left: X(e.at) }} title={`${hhmm(e.at)} · ${e.title}`} aria-label={`${hhmm(e.at)}: ${e.title}`} onPointerDown={(ev) => ev.stopPropagation()} onClick={(ev) => onOpenEvent(e.id, ev.currentTarget)} />
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
