import { useLayoutEffect, useRef } from 'react'
import type { Verdict as V, VerdictAction } from '../model'
import { Spring, reducedMotion } from '../lib/spring'
import { GLYPH, Rich } from './common'

/* One sentence and one action. When the state changes the old line leaves upward and blurs,
   the new one arrives from below: a newer state reads as "later", the way time runs down a page. */
export function Verdict({ v, onAction, at }: { v: V; onAction: (a: VerdictAction, el: HTMLElement) => void; at?: string }) {
  const wrap = useRef<HTMLDivElement>(null)
  const title = useRef<HTMLHeadingElement>(null)
  const glyph = useRef<HTMLDivElement>(null)
  const prev = useRef<{ key: string; text: string } | null>(null)
  const key = v.tone + '|' + v.title.replace(/\d+/g, '#')

  useLayoutEffect(() => {
    const was = prev.current
    prev.current = { key, text: v.title }
    if (!was || was.key === key || reducedMotion() || !wrap.current || !title.current) return
    const old = document.createElement('h1')
    old.className = 'v-title morph-out'
    old.textContent = was.text
    wrap.current.appendChild(old)
    const t = title.current
    const s = new Spring(0, {
      response: 0.5,
      damping: 1,
      rest: 0.002,
      onUpdate: (p) => {
        old.style.transform = `translateY(${-p * 18}px)`
        old.style.opacity = String(1 - p)
        old.style.filter = `blur(${p * 6}px)`
        t.style.transform = p < 1 ? `translateY(${(1 - p) * 22}px)` : ''
        t.style.opacity = String(p)
        t.style.filter = p < 1 ? `blur(${(1 - p) * 6}px)` : ''
      },
      onRest: () => old.remove(),
    })
    s.to(1)
    const g = glyph.current
    const gs = new Spring(0.6, { response: 0.45, damping: 0.62, rest: 0.002, onUpdate: (x) => g && (g.style.transform = `scale(${x})`) })
    gs.to(1)
    return () => {
      s.settle()
      gs.settle()
    }
  }, [key, v.title])

  return (
    <section className="verdict" aria-live="polite">
      <div className="v-glyph" ref={glyph} aria-hidden="true" dangerouslySetInnerHTML={{ __html: `<svg viewBox="0 0 44 44">${GLYPH[v.tone] || GLYPH.none}</svg>` }} />
      <div className="v-text">
        <div className="v-line" ref={wrap}>
          <h1 className="v-title" ref={title}>
            {v.title}
            {at && <span className="v-at mono"> · {at}</span>}
          </h1>
        </div>
        <p className="v-sub">
          <Rich text={v.sub} />
        </p>
      </div>
      <div className="v-actions">
        {(v.actions || []).map((a) => (
          <button key={a.act + (a.id || '')} type="button" className={`btn${a.primary ? ' primary' : ''}`} onClick={(e) => onAction(a, e.currentTarget)}>
            {a.label}
          </button>
        ))}
      </div>
    </section>
  )
}
