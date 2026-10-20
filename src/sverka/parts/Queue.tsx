import { useLayoutEffect, useRef, useState } from 'react'
import type { Episode, Profile, Rights, UiEvent } from '../model'
import { STATUS_WORD, inWork, isOpen, liveTitle, overdue, sevNow } from '../model'
import { atTime, durShort, hhmm } from '../lib/format'
import { Spring, VelocityTracker, capture, clamp, lerp, project, reducedMotion } from '../lib/spring'
import { Roll } from './common'

const SEV_WORD = { warn: 'Предупреждение', err: 'Отклонение' }

export function Queue({
  events,
  episodes,
  t,
  prof,
  rightsOf,
  onOpen,
  onDecide,
  onJournal,
}: {
  events: UiEvent[]
  episodes: Map<string, Episode>
  t: number
  prof: Profile | null
  rightsOf: (e: UiEvent) => Rights
  onOpen: (id: string, el: HTMLElement) => void
  onDecide: (id: string, status: 'confirmed' | 'false_positive', dir: 1 | -1) => void
  onJournal: (el: HTMLElement) => void
}) {
  const now = Date.now()
  const pending = events
    .filter((e) => e.status === 'pending' && e.kind !== 'stream')
    .sort((a, b) => (sevNow(b, episodes.get(b.id), t, prof) === 'err' ? 1 : 0) - (sevNow(a, episodes.get(a.id), t, prof) === 'err' ? 1 : 0) || b.createdAt - a.createdAt)
  // decided but not fixed: the nearest deadline first
  const work = events.filter(inWork).sort((a, b) => (a.deadline ?? Infinity) - (b.deadline ?? Infinity) || b.createdAt - a.createdAt)
  const late = work.filter((e) => overdue(e, now)).length
  const closed = events.filter((e) => !isOpen(e) && !e.sample && e.kind !== 'stream').sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt))
  const [fold, setFold] = useState<'work' | 'closed' | null>(null)
  const first = pending[0] ? rightsOf(pending[0]) : null
  const list = useRef<HTMLDivElement>(null)
  const rects = useRef(new Map<string, DOMRect>())
  const known = useRef<Set<string> | null>(null)

  // FLIP: survivors slide from where they were; a newborn card arrives from the slot that caused it
  useLayoutEffect(() => {
    const el = list.current
    if (!el) return
    const items = Array.from(el.querySelectorAll<HTMLElement>('.q-item'))
    const first = known.current == null
    for (const n of items) {
      const id = n.dataset.id!
      const now = n.getBoundingClientRect()
      const was = rects.current.get(id)
      if (reducedMotion()) continue
      if (was) {
        const dy = was.top - now.top
        if (Math.abs(dy) > 0.5) new Spring(dy, { response: 0.4, damping: 0.9, onUpdate: (y) => (n.style.transform = y ? `translateY(${y}px)` : '') }).to(0)
      } else if (!first && !known.current!.has(id)) {
        const card = n.querySelector<HTMLElement>('.q-card')!
        const code = n.dataset.mach
        const origin = code ? document.querySelector(`.slot[data-code="${code}"]`)?.getBoundingClientRect() : null
        const dx = origin ? origin.left + origin.width / 2 - (now.left + now.width / 2) : 0
        const dy = origin ? origin.top + origin.height / 2 - (now.top + now.height / 2) : 16
        new Spring(0, {
          response: 0.55,
          damping: 0.78,
          rest: 0.002,
          onUpdate: (p) => {
            card.style.transform = p < 1 ? `translate(${dx * (1 - p)}px,${dy * (1 - p)}px) scale(${lerp(origin ? 0.35 : 0.96, 1, p)})` : ''
            card.style.opacity = String(clamp(p * 1.6, 0, 1))
          },
        }).to(1)
      }
    }
    rects.current = new Map(items.map((n) => [n.dataset.id!, n.getBoundingClientRect()]))
    known.current = new Set(items.map((n) => n.dataset.id!))
  })

  return (
    <section className="panel queue" aria-labelledby="queueTitle" id="queue">
      <div className="queue-head">
        <span className="kicker" id="queueTitle">
          Требуют решения
          <span className="count">
            <Roll value={pending.length} />
          </span>
        </span>
        <button type="button" className="btn ghost small" onClick={(e) => onJournal(e.currentTarget)}>
          Журнал
        </button>
      </div>
      <div className="q-list" ref={list}>
        {!pending.length && <div className="q-empty">Новых отклонений нет.{work.length || closed.length ? ' Решённые — ниже.' : ''}</div>}
        {pending.map((e) => (
          <QItem key={e.id} e={e} ep={episodes.get(e.id)} t={t} now={now} prof={prof} can={rightsOf(e)} onOpen={onOpen} onDecide={onDecide} />
        ))}
      </div>
      {work.length > 0 && (
        <div className="q-done">
          <button type="button" aria-expanded={fold === 'work'} onClick={() => setFold(fold === 'work' ? null : 'work')}>
            <span>
              В работе · {work.length}
              {late > 0 && <em className="late"> · {late} {late === 1 ? 'просрочено' : 'просрочены'}</em>}
            </span>
            <span>{fold === 'work' ? 'Скрыть' : 'Показать'}</span>
          </button>
          {fold === 'work' && (
            <ul>
              {work.slice(0, 30).map((e) => (
                <DoneRow key={e.id} e={e} onOpen={onOpen} line={workLine(e, now)} late={overdue(e, now)} />
              ))}
            </ul>
          )}
        </div>
      )}
      {closed.length > 0 && (
        <div className="q-done">
          <button type="button" aria-expanded={fold === 'closed'} onClick={() => setFold(fold === 'closed' ? null : 'closed')}>
            <span>Закрыто · {closed.length}</span>
            <span>{fold === 'closed' ? 'Скрыть' : 'Показать'}</span>
          </button>
          {fold === 'closed' && (
            <ul>
              {closed.slice(0, 30).map((e) => (
                <DoneRow key={e.id} e={e} onOpen={onOpen} line={e.status === 'resolved' && e.check === 'passed' ? 'Устранено · подтвердили камеры' : STATUS_WORD[e.status]} />
              ))}
            </ul>
          )}
        </div>
      )}
      {first && <div className="q-hint">{!first.act ? first.reason : first.dismiss ? 'Смахните карточку вправо, чтобы подтвердить, влево, если ложное' : 'Смахните карточку вправо, чтобы подтвердить. Ложное отмечает администратор'}</div>}
    </section>
  )
}

/** One line on where a task stands: the recheck, the deadline, the escalation. */
function workLine(e: UiEvent, now: number) {
  const word = STATUS_WORD[e.status]
  if (e.check === 'requested') return `${word} · проверка исправления запрошена`
  if (e.escalatedAt) return `${word} · у руководителя с ${atTime(e.escalatedAt, now)}`
  if (e.deadline == null) return word
  return e.deadline <= now ? `${word} · срок истёк ${durShort(now - e.deadline)} назад` : `${word} · исправить до ${atTime(e.deadline, now)}`
}

function DoneRow({ e, line, late = false, onOpen }: { e: UiEvent; line: string; late?: boolean; onOpen: (id: string, el: HTMLElement) => void }) {
  return (
    <li>
      <span className="mono">{hhmm(e.at)}</span>
      <span>
        <button type="button" className="link-plain" onClick={(ev) => onOpen(e.id, ev.currentTarget)}>
          <b>{e.title}</b>
        </button>
        <br />
        <span className={late ? 'late' : undefined}>{line}</span>
        {e.assignee && <span className="who"> · {e.assignee}</span>}
      </span>
    </li>
  )
}

function QItem({ e, ep, t, now, prof, can, onOpen, onDecide }: { e: UiEvent; ep?: Episode; t: number; now: number; prof: Profile | null; can: Rights; onOpen: (id: string, el: HTMLElement) => void; onDecide: (id: string, s: 'confirmed' | 'false_positive', dir: 1 | -1) => void }) {
  const item = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLButtonElement>(null)
  const under = useRef<HTMLDivElement>(null)
  const st = useRef<{ x0: number; y0: number; base: number; lock: null | 'x' | 'y'; id: number } | null>(null)
  const swiped = useRef(false)
  const vt = useRef(new VelocityTracker())
  const sev = sevNow(e, ep, t, prof)
  const x = useRef<Spring | null>(null)
  if (!x.current)
    x.current = new Spring(0, {
      response: 0.38,
      damping: 0.86,
      rest: 0.4,
      onUpdate: (v) => {
        const c = card.current
        const u = under.current
        const it = item.current
        if (!c || !u || !it) return
        c.style.transform = v ? `translateX(${v}px)` : ''
        const k = clamp(Math.abs(v) / (it.clientWidth * 0.42), 0, 1)
        const right = v > 0
        u.style.background = `color-mix(in srgb, var(--${right ? (c.dataset.sev === 'err' ? 'err' : 'warn') : 'fg'}) ${((right ? 0.18 + 0.5 * k : 0.06 + 0.12 * k) * 100).toFixed(1)}%, transparent)`
        const [cf, fl] = Array.from(u.children) as HTMLElement[]
        cf.style.opacity = right ? String(k) : '0'
        fl.style.opacity = !right ? String(k) : '0'
        cf.style.transform = `translateX(${(1 - k) * -10}px)`
        fl.style.transform = `translateX(${(1 - k) * 10}px)`
      },
    })
  const down = (ev: React.PointerEvent) => {
    if (ev.button) return
    x.current!.stop()
    st.current = { x0: ev.clientX, y0: ev.clientY, base: x.current!.x, lock: null, id: ev.pointerId }
    vt.current.reset()
    vt.current.add(ev.clientX, ev.clientY)
  }
  const move = (ev: React.PointerEvent) => {
    const s = st.current
    if (!s) return
    vt.current.add(ev.clientX, ev.clientY)
    const dx = ev.clientX - s.x0
    const dy = ev.clientY - s.y0
    if (!s.lock) {
      // hysteresis: commit to a direction only after ~10px
      if (Math.hypot(dx, dy) < 10) return
      s.lock = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'
      if (s.lock === 'x') capture(card.current!, s.id)
    }
    if (s.lock !== 'x') return
    // a direction the user may not take only gives a little, like a locked door
    const v = s.base + dx
    const shut = (v > 0 && !can.act) || (v < 0 && !can.dismiss)
    x.current!.set(shut ? Math.sign(v) * Math.min(56, Math.abs(v) * 0.22) : v)
  }
  const up = () => {
    const s = st.current
    st.current = null
    if (!s || s.lock !== 'x') return
    swiped.current = true
    window.setTimeout(() => (swiped.current = false), 60)
    const v = vt.current.get().x
    const w = item.current!.clientWidth
    const proj = x.current!.x + project(v, 0.99)
    if (proj > w * 0.45 && can.act) x.current!.to(w + 40, { velocity: v, damping: 1, onRest: () => onDecide(e.id, 'confirmed', 1) })
    else if (proj < -w * 0.45 && can.dismiss) x.current!.to(-w - 40, { velocity: v, damping: 1, onRest: () => onDecide(e.id, 'false_positive', -1) })
    else x.current!.to(0, { velocity: v, damping: 0.75 })
  }
  const thumb = e.album.find((a) => a.primary)?.url || e.album[0]?.url
  return (
    <div className="q-item" ref={item} data-id={e.id} data-mach={e.mach || undefined}>
      <div className="q-under" ref={under} aria-hidden="true">
        <span className="u-confirm">{can.act ? 'Подтвердить' : 'Решает ответственный'}</span>
        <span className="u-false">{can.dismiss ? 'Ложное' : 'Ложное отмечает администратор'}</span>
      </div>
      <button
        type="button"
        className="q-card"
        ref={card}
        data-sev={sev}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onClick={(ev) => {
          if (!swiped.current) onOpen(e.id, ev.currentTarget)
        }}
        aria-label={`${SEV_WORD[sev]}: ${liveTitle(e, ep, t)}. Открыть разбор`}
      >
        <span className="sev" />
        <span className="q-main">
          <span className="q-title">
            <span className="q-t">{liveTitle(e, ep, t)}</span>
            <span className="mono">{hhmm(e.at)}</span>
          </span>
          <span className="q-sub">
            {[e.sample ? 'пример с сервера' : e.demo ? 'демо' : null, e.zone, SEV_WORD[sev], ep ? (ep.to ? 'завершилось' : 'продолжается') : e.stageName].filter(Boolean).join(' · ')}
            {e.deadline != null && (e.deadline <= now ? <span className="late"> · срок истёк</span> : ` · до ${atTime(e.deadline, now)}`)}
          </span>
        </span>
        <span className="q-thumb">{thumb ? <img alt="" src={thumb} /> : null}</span>
      </button>
    </div>
  )
}
