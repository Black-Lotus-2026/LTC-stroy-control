import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { UserProfile } from '../api'
import { fmtDayLong } from '../lib/format'
import { SUBJECTS, WireScene } from '../lib/wire'
import { ROLE_LABEL } from '../model'

const WORDS = ['СТРОЙ', 'КОНТРОЛЬ']

/**
 * The page before the workspace: a dashed wireframe turning slowly on its stand and rebuilding
 * itself from a machine into a building and back, the product name set huge behind it, the role
 * at the bottom. Continuing mounts the workspace underneath while this page leaves off the top.
 */
export function Intro({ user, leaving, onContinue, onGone }: { user: UserProfile; leaving: boolean; onContinue: () => void; onGone: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const type = useRef<HTMLDivElement>(null)
  const fills = useRef<(HTMLElement | null)[]>([])
  const scene = useRef<WireScene | null>(null)
  const [idx, setIdx] = useState(0)

  useEffect(() => {
    const s = new WireScene(canvas.current!, {
      onIndex: setIdx,
      onTick: (i, p) =>
        fills.current.forEach((el, j) => {
          if (el) el.style.transform = `scaleX(${j < i ? 1 : j === i ? p.toFixed(4) : 0})`
        }),
      onParallax: (x, y) => {
        if (type.current) type.current.style.transform = `translate3d(${(-x * 14).toFixed(2)}px, ${(-y * 8).toFixed(2)}px, 0)`
      },
    })
    scene.current = s
    s.start()
    return () => {
      s.stop()
      scene.current = null
    }
  }, [])

  useEffect(() => {
    if (leaving) {
      // in case the exit animation never reports its end (hidden tab)
      const t = window.setTimeout(onGone, 1400)
      return () => clearTimeout(t)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onContinue()
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [leaving, onContinue, onGone])

  return (
    <div
      className="intro"
      data-leaving={leaving || undefined}
      onAnimationEnd={(e) => {
        if (leaving && e.target === e.currentTarget && e.animationName === 'itOut') onGone()
      }}
    >
      <div className="intro-type" ref={type}>
        <div className="it-block">
          <h1 className="sr">Строй-контроль</h1>
          {WORDS.map((w, l) => (
            <div className={`it-line l${l}`} key={w} aria-hidden="true">
              {[...w].map((ch, i) => (
                <span key={i} style={{ '--i': i, '--l': l } as CSSProperties}>
                  {ch}
                </span>
              ))}
            </div>
          ))}
          <p className="it-tag">
            <span>Наблюдайте за этапами стройки</span>
            <i aria-hidden="true" />
            <span>из единой точки</span>
          </p>
        </div>
      </div>

      <canvas className="intro-canvas" ref={canvas} aria-hidden="true" />

      <header className="intro-top">
        <div className="brand" aria-hidden="true">
          СК
        </div>
        <span className="it-name">Строй-контроль</span>
        <span className="grow" />
        <span className="it-date">{fmtDayLong(Date.now())}</span>
      </header>

      <footer className="intro-foot">
        <div className="it-role">
          <span className="kicker">Ваша роль</span>
          <b>{ROLE_LABEL}</b>
          <small>{user.username}</small>
        </div>
        <ol className="it-steps" aria-label="Что на заставке">
          {SUBJECTS.map((s, i) => (
            <li key={s.title}>
              <button type="button" aria-current={i === idx || undefined} data-gold={s.gold || undefined} onClick={() => scene.current?.show(i)}>
                <span className="it-bar">
                  <i
                    ref={(el) => {
                      fills.current[i] = el
                    }}
                  />
                </span>
                <span className="it-lab">
                  <span className="mono">{String(i + 1).padStart(2, '0')}</span>
                  {s.title}
                </span>
              </button>
            </li>
          ))}
        </ol>
        <button type="button" className="btn plan it-go" onClick={onContinue} disabled={leaving} autoFocus>
          Начать работу
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 8h10M9 4l4 4-4 4" />
          </svg>
        </button>
      </footer>
    </div>
  )
}
