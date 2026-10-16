import { useLayoutEffect, useRef, useState } from 'react'
import type { Episode, Profile, UiEvent } from '../model'
import { STATUS_WORD, liveTitle, sevNow } from '../model'
import { hhmm } from '../lib/format'
import { Spring, VelocityTracker, capture, clamp, lerp, project, reducedMotion } from '../lib/spring'
import { Roll } from './common'

const SEV_WORD = { warn: 'Предупреждение', err: 'Отклонение' }

export function Queue({
  events,
  episodes,
  t,
  prof,
  onOpen,
  onDecide,
  onJournal,
}: {
  events: UiEvent[]
  episodes: Map<string, Episode>
  t: number
  prof: Profile | null
  onOpen: (id: string, el: HTMLElement) => void
  onDecide: (id: string, status: 'confirmed' | 'false_positive', dir: 1 | -1) => void
  onJournal: () => void
}) {
  const pending = events
    .filter((e) => e.status === 'pending')
    .sort((a, b) => (sevNow(b, episodes.get(b.id), t, prof) === 'err' ? 1 : 0) - (sevNow(a, episodes.get(a.id), t, prof) === 'err' ? 1 : 0) || b.createdAt - a.createdAt)
  const done = events.filter((e) => e.status !== 'pending').sort((a, b) => (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt))
  const [doneOpen, setDoneOpen] = useState(false)
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
        <button type="button" className="btn ghost small" onClick={onJournal}>
          Журнал
        </button>
      </div>
      <div className="q-list" ref={list}>
        {!pending.length && <div className="q-empty">Новых отклонений нет.{done.length ? ' Решённые — ниже.' : ''}</div>}
        {pending.map((e) => (
          <QItem key={e.id} e={e} ep={episodes.get(e.id)} t={t} prof={prof} onOpen={onOpen} onDecide={onDecide} />
        ))}
      </div>
      {done.length > 0 && (
        <div className="q-done">
          <button type="button" aria-expanded={doneOpen} onClick={() => setDoneOpen(!doneOpen)}>
            <span>Решено · {done.length}</span>
            <span>{doneOpen ? 'Скрыть' : 'Показать'}</span>
          </button>
          {doneOpen && (
            <ul>
              {done.slice(0, 30).map((e) => (
                <li key={e.id}>
                  <span className="mono">{hhmm(e.at)}</span>
                  <span>
                    <button type="button" className="link-plain" onClick={(ev) => onOpen(e.id, ev.currentTarget)}>
                      <b>{e.title}</b>
                    </button>
                    <br />
                    {STATUS_WORD[e.status]}
                    {e.comment ? ` · ${e.comment}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {pending.length > 0 && <div className="q-hint">Смахните карточку вправо, чтобы подтвердить, влево, если ложное</div>}
    </section>
  )
}

function QItem({ e, ep, t, prof, onOpen, onDecide }: { e: UiEvent; ep?: Episode; t: number; prof: Profile | null; onOpen: (id: string, el: HTMLElement) => void; onDecide: (id: string, s: 'confirmed' | 'false_positive', dir: 1 | -1) => void }) {
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
        u.style.background = right ? (c.dataset.sev === 'err' ? `rgba(255,90,85,${0.18 + 0.5 * k})` : `rgba(255,143,63,${0.18 + 0.5 * k})`) : `rgba(236,232,224,${0.06 + 0.12 * k})`
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
    x.current!.set(s.base + dx)
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
    if (proj > w * 0.45) x.current!.to(w + 40, { velocity: v, damping: 1, onRest: () => onDecide(e.id, 'confirmed', 1) })
    else if (proj < -w * 0.45) x.current!.to(-w - 40, { velocity: v, damping: 1, onRest: () => onDecide(e.id, 'false_positive', -1) })
    else x.current!.to(0, { velocity: v, damping: 0.75 })
  }
  const thumb = e.album.find((a) => a.primary)?.url || e.album[0]?.url
  return (
    <div className="q-item" ref={item} data-id={e.id} data-mach={e.mach || undefined}>
      <div className="q-under" ref={under} aria-hidden="true">
        <span className="u-confirm">Подтвердить</span>
        <span className="u-false">Ложное</span>
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
            {[e.zone, SEV_WORD[sev], ep ? (ep.to ? 'завершилось' : 'продолжается') : e.stageName].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className="q-thumb">{thumb ? <img alt="" src={thumb} /> : null}</span>
      </button>
    </div>
  )
}
