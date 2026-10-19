import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { UserProfile } from '../api'
import { fmtDayLong } from '../lib/format'
import { LetterRing } from '../lib/ring'
import { SUBJECTS, WireScene } from '../lib/wire'
import { ROLE_LABEL } from '../model'
import { SideSwitch, Sides, useSide, type Side } from './IntroSides'

const SceneCtx = createContext<WireScene | null>(null)

/**
 * The backdrop shared by sign-in and the intro page: the dashed wireframe turning on its stand.
 * It stays mounted from one to the other, so after signing in the same drawing glides from the
 * centre to its place on the intro page without restarting. Pages inside put their layers above
 * and below the canvas with z-index (the canvas is z 1).
 */
export function Showcase({ mode, leaving = false, onGone, children }: { mode: 'auth' | 'intro'; leaving?: boolean; onGone?: () => void; children: ReactNode }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [scene, setScene] = useState<WireScene | null>(null)
  const initial = useRef(mode)

  useEffect(() => {
    const s = new WireScene(canvas.current!, initial.current === 'intro' ? 1 : 0)
    s.start()
    setScene(s)
    return () => {
      s.stop()
      setScene(null)
    }
  }, [])

  useEffect(() => {
    scene?.setLayout(mode === 'intro' ? 1 : 0)
  }, [scene, mode])

  useEffect(() => {
    if (!leaving || !onGone) return
    // in case the exit animation never reports its end (hidden tab)
    const t = window.setTimeout(onGone, 1400)
    return () => clearTimeout(t)
  }, [leaving, onGone])

  return (
    <div
      className="intro"
      data-mode={mode}
      data-leaving={leaving || undefined}
      onAnimationEnd={(e) => {
        if (leaving && e.target === e.currentTarget && e.animationName === 'itOut') onGone?.()
      }}
    >
      <canvas className="intro-canvas" ref={canvas} aria-hidden="true" />
      <SceneCtx.Provider value={scene}>{children}</SceneCtx.Provider>
    </div>
  )
}

const WORDS = ['СТРОЙ', 'КОНТРОЛЬ']

/**
 * The page before the workspace, drawn over the Showcase: the product name behind the wireframe, the
 * tagline, the role at the bottom. On wide screens the name stands in solid letters on a ring round
 * the drawing, with the site's kit about them (lib/ring.ts), and the sides show the object: its
 * cameras, the stage's machinery, the site, its numbers or a drawing sheet (IntroSides.tsx), as
 * picked in the header. Elsewhere the name is set huge and flat.
 * Continuing mounts the workspace underneath while the Showcase leaves off the top.
 */
export function Intro({ user, leaving, onContinue }: { user: UserProfile; leaving: boolean; onContinue: () => void }) {
  const scene = useContext(SceneCtx)
  const type = useRef<HTMLDivElement>(null)
  const fills = useRef<(HTMLElement | null)[]>([])
  const ringCanvas = useRef<HTMLCanvasElement>(null)
  const ring = useRef<LetterRing | null>(null)
  const [ringReady, setRingReady] = useState(false)
  const [idx, setIdx] = useState(0)
  const [side, setSide] = useSide()
  const [switched, setSwitched] = useState(false)
  const aim = useRef({ x: 0, y: 0 })
  const pickSide = (s: Side) => {
    setSwitched(true)
    setSide(s)
  }

  useEffect(() => {
    const r = new LetterRing(ringCanvas.current!, () => setRingReady(true))
    ring.current = r
    r.start()
    return () => {
      r.stop()
      ring.current = null
    }
  }, [])

  useEffect(() => {
    if (!scene) return
    scene.on = {
      onIndex: setIdx,
      onTick: (i, p) =>
        fills.current.forEach((el, j) => {
          if (el) el.style.transform = `scaleX(${j < i ? 1 : j === i ? p.toFixed(4) : 0})`
        }),
      onParallax: (x, y) => {
        if (type.current) type.current.style.transform = `translate3d(${(-x * 14).toFixed(2)}px, ${(-y * 8).toFixed(2)}px, 0)`
        ring.current?.look(x, y)
        aim.current.x = x
        aim.current.y = y
      },
    }
    scene.on.onIndex?.(scene.current)
    return () => {
      scene.on = {}
    }
  }, [scene])

  useEffect(() => {
    if (leaving) return
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onContinue()
    }
    addEventListener('keydown', key)
    return () => removeEventListener('keydown', key)
  }, [leaving, onContinue])

  return (
    <>
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
      <Sides side={side} user={user} scene={scene} aim={aim} subject={SUBJECTS[idx]?.title ?? ''} switched={switched} />
      <canvas className="intro-ring" ref={ringCanvas} data-ready={ringReady || undefined} aria-hidden="true" />

      <header className="intro-top">
        <div className="brand" aria-hidden="true">
          СК
        </div>
        <span className="it-name">Строй-контроль</span>
        <SideSwitch side={side} onSide={pickSide} />
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
              <button type="button" aria-current={i === idx || undefined} data-gold={s.gold || undefined} onClick={() => scene?.show(i)}>
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
    </>
  )
}
