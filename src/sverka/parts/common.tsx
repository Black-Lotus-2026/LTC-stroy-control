import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Spring, reducedMotion } from '../lib/spring'

/* ── Toast with optional undo ───────────────────────────── */
interface ToastItem { id: number; text: string; undo?: () => void; error?: boolean; retry?: () => void }
type ToastFn = (text: string, o?: { undo?: () => void; error?: boolean; retry?: () => void }) => void
const ToastCtx = createContext<ToastFn>(() => undefined)
export const useToast = () => useContext(ToastCtx)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [item, setItem] = useState<ToastItem | null>(null)
  const el = useRef<HTMLDivElement>(null)
  const spring = useRef<Spring | null>(null)
  const timer = useRef(0)
  if (!spring.current)
    spring.current = new Spring(0, {
      response: 0.42,
      damping: 0.86,
      rest: 0.002,
      onUpdate: (p) => {
        const t = el.current
        if (!t) return
        t.style.transform = `translateX(-50%) translateY(${(1 - p) * 24}px) scale(${0.96 + 0.04 * p})`
        t.style.opacity = String(p)
      },
    })
  const hide = useCallback(() => {
    clearTimeout(timer.current)
    spring.current!.to(0, { onRest: () => setItem(null) })
  }, [])
  const show = useCallback<ToastFn>(
    (text, o = {}) => {
      clearTimeout(timer.current)
      setItem({ id: Date.now(), text, ...o })
      const dur = o.undo || o.retry ? 6500 : o.error ? 6000 : 3400
      timer.current = window.setTimeout(hide, dur)
    },
    [hide],
  )
  useEffect(() => {
    if (item) spring.current!.to(1, { onRest: () => undefined })
  }, [item])
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {item && (
        <div className={`toast${item.error ? ' is-error' : ''}`} ref={el} role="status" key={item.id} style={{ opacity: 0 }}>
          <span>{item.text}</span>
          {item.undo && (
            <button type="button" className="btn small" onClick={() => { item.undo!(); hide() }}>
              Отменить
            </button>
          )}
          {item.retry && (
            <button type="button" className="btn small" onClick={() => { item.retry!(); hide() }}>
              Повторить
            </button>
          )}
          <i className="t-bar" style={{ animation: reducedMotion() ? 'none' : `tbar ${item.undo || item.retry ? 6.5 : item.error ? 6 : 3.4}s linear forwards` }} />
        </div>
      )}
    </ToastCtx.Provider>
  )
}

/* ── Glyphs ─────────────────────────────────────────────── */
export const GLYPH: Record<string, string> = {
  ok: '<circle cx="22" cy="22" r="13" fill="var(--ok)"/><path d="M15.5 22.4l4.4 4.3 8.6-9" fill="none" stroke="var(--on-status)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  warn: '<path d="M22 6.5 38.5 35.5h-33z" fill="var(--warn)" stroke="var(--warn)" stroke-width="3" stroke-linejoin="round"/><path d="M22 16.5v9" stroke="var(--on-status)" stroke-width="2.8" stroke-linecap="round"/><circle cx="22" cy="30.4" r="1.7" fill="var(--on-status)"/>',
  err: '<path d="M22 5.5 38.5 22 22 38.5 5.5 22z" fill="var(--err)" stroke="var(--err)" stroke-width="3" stroke-linejoin="round"/><path d="M22 14.5v9" stroke="var(--on-status)" stroke-width="2.8" stroke-linecap="round"/><circle cx="22" cy="28.6" r="1.7" fill="var(--on-status)"/>',
  nodata: '<defs><pattern id="hp" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.4" height="5" fill="var(--fg-3)"/></pattern></defs><circle cx="22" cy="22" r="13.5" fill="url(#hp)" stroke="var(--fg-3)" stroke-width="1.5"/>',
  none: '<circle cx="22" cy="22" r="13" fill="none" stroke="var(--fg-3)" stroke-width="1.5" stroke-dasharray="3 3"/>',
}
export function SevIcon({ sev }: { sev: 'warn' | 'err' | 'info' }) {
  if (sev === 'err') return <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1 13 7 7 13 1 7z" fill="currentColor" /></svg>
  if (sev === 'warn') return <svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.6 13 12.4H1z" fill="currentColor" /></svg>
  return <svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="currentColor" /></svg>
}
export const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
    <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
  </svg>
)
export const Chevron = ({ up = false }: { up?: boolean }) => (
  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
    <path d={up ? 'M2 6.5 5 3.5 8 6.5' : 'M2 3.5 5 6.5 8 3.5'} fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
)

/** Number that rolls to its new value: up when it grows, down when it shrinks. */
export function Roll({ value }: { value: number }) {
  const [shown, setShown] = useState(value)
  const [prev, setPrev] = useState<number | null>(null)
  const box = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (value === shown) return
    if (reducedMotion()) {
      setShown(value)
      return
    }
    setPrev(shown)
    setShown(value)
  }, [value, shown])
  useEffect(() => {
    if (prev == null || !box.current) return
    const up = shown > prev
    const [a, b] = Array.from(box.current.children) as HTMLElement[]
    const s = new Spring(0, {
      response: 0.42,
      damping: 0.85,
      rest: 0.002,
      onUpdate: (p) => {
        if (a) a.style.transform = `translateY(${(up ? -100 : 100) * p}%)`
        if (b) b.style.transform = `translateY(${(up ? 1 - p : -(1 - p)) * 100}%)`
      },
      onRest: () => setPrev(null),
    })
    s.to(1)
    return () => {
      s.stop()
    }
  }, [prev, shown])
  if (prev == null) return <span className="roll">{shown}</span>
  const up = shown > prev
  return (
    <span className="roll rolling" ref={box}>
      <span>{prev}</span>
      <span style={{ transform: `translateY(${up ? 100 : -100}%)` }}>{shown}</span>
    </span>
  )
}

/** Plain text with **bold** spans. Never parses HTML, so server text stays text. */
export function Rich({ text }: { text: string }) {
  const parts = text.split(/\*\*(.+?)\*\*/g)
  return <>{parts.map((p, i) => (i % 2 ? <strong key={i}>{p}</strong> : p))}</>
}

/** Segmented control; the pill travels to the choice on a spring and can be re-targeted mid-flight. `onChange` also gets the button of the choice. */
export function Seg<T extends string>({ value, options, onChange, label, className = '' }: { value: T; options: { v: T; label: React.ReactNode }[]; onChange: (v: T, el: HTMLElement) => void; label: string; className?: string }) {
  const box = useRef<HTMLDivElement>(null)
  const pill = useRef<HTMLElement>(null)
  const px = useRef(new Spring(0, { response: 0.34, damping: 0.86, rest: 0.2, onUpdate: (v) => pill.current && (pill.current.style.transform = `translateX(${v}px)`) }))
  const pw = useRef(new Spring(0, { response: 0.34, damping: 0.95, rest: 0.2, onUpdate: (v) => pill.current && (pill.current.style.width = v + 'px') }))
  const first = useRef(true)
  useLayoutEffect(() => {
    const b = box.current?.querySelector<HTMLElement>('button[aria-checked="true"]')
    if (!b || !pill.current) return
    pill.current.style.height = b.offsetHeight + 'px'
    pill.current.style.top = b.offsetTop + 'px'
    if (first.current || !b.offsetWidth) {
      px.current.set(b.offsetLeft)
      pw.current.set(b.offsetWidth)
      first.current = !b.offsetWidth
    } else {
      px.current.to(b.offsetLeft)
      pw.current.to(b.offsetWidth)
    }
  })
  return (
    <div className={`seg seg-auto ${className}`} role="radiogroup" aria-label={label} ref={box}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          role="radio"
          aria-checked={o.v === value}
          tabIndex={o.v === value ? 0 : -1}
          onClick={(e) => onChange(o.v, e.currentTarget)}
          onKeyDown={(e) => {
            const i = options.findIndex((x) => x.v === value)
            const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
            if (!d) return
            e.preventDefault()
            const j = (i + d + options.length) % options.length
            onChange(options[j].v, box.current!.querySelectorAll<HTMLElement>('button')[j])
            window.setTimeout(() => box.current?.querySelector<HTMLElement>('button[aria-checked="true"]')?.focus(), 0)
          }}
        >
          {o.label}
        </button>
      ))}
      <i className="pill" ref={pill} />
    </div>
  )
}

/** Checkbox drawn as a small square; the tick is drawn with a stroke when it turns on. */
export function Tick({ on, onChange, label, className = '' }: { on: boolean; onChange: (v: boolean) => void; label: string; className?: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={on} aria-label={label} title={label} className={`tick ${className}`} onClick={(e) => { e.stopPropagation(); onChange(!on) }}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" />
        <path d="M4.6 8.3l2.3 2.3 4.6-5" />
      </svg>
    </button>
  )
}
