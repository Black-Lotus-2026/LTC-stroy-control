import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Spring, VelocityTracker, capture, clamp, lerp, project, reducedMotion } from '../lib/spring'
import { CloseIcon } from './common'
import { CameraViewImage } from './CameraViewImage'

interface Photo { url: string; camera: string }

/*
 * A frame on the whole screen. It grows out of the photo that was clicked (the crop morphs from
 * the case file's "cover" frame to the full picture), follows the finger when dragged, and a
 * downward throw sends it back into the case file carrying the hand's velocity.
 */
export function Lightbox({ photos, index, caption, source, onIndex, onClose }: { photos: Photo[]; index: number; caption: string; source: () => DOMRect | null; onIndex: (i: number) => void; onClose: () => void }) {
  const frame = useRef<HTMLDivElement>(null)
  const scrim = useRef<HTMLDivElement>(null)
  const chrome = useRef<HTMLDivElement>(null)
  const img = useRef<HTMLImageElement>(null)
  const [aspect, setAspect] = useState(16 / 9)
  const from = useRef<DOMRect>(source() || new DOMRect(innerWidth / 2 - 80, innerHeight / 2 - 45, 160, 90))
  const closing = useRef(false)
  const geo = useRef({ p: 0, dx: 0, dy: 0 })

  const target = () => {
    const pad = innerWidth < 860 ? 12 : 56
    const W = innerWidth - pad * 2
    const H = innerHeight - pad * 2 - 60
    const w = Math.min(W, H * aspect)
    const h = w / aspect
    return { left: (innerWidth - w) / 2, top: (innerHeight - 60 - h) / 2 + 10, width: w, height: h }
  }
  const paint = () => {
    const f = frame.current
    if (!f) return
    const { p, dx, dy } = geo.current
    const T = target()
    const S = from.current
    const k = clamp(p, 0, 1.06)
    const shrink = 1 - clamp(Math.abs(dy) / innerHeight, 0, 1) * 0.35
    const w = lerp(S.width, T.width, k) * shrink
    const h = lerp(S.height, T.height, k) * shrink
    const cx = lerp(S.left + S.width / 2, T.left + T.width / 2, k) + dx
    const cy = lerp(S.top + S.height / 2, T.top + T.height / 2, k) + dy
    Object.assign(f.style, { left: cx - w / 2 + 'px', top: cy - h / 2 + 'px', width: w + 'px', height: h + 'px', borderRadius: lerp(4, 6, clamp(k, 0, 1)) + 'px' })
    const fade = clamp(p, 0, 1) * (1 - clamp(Math.abs(dy) / 360, 0, 0.85))
    if (scrim.current) scrim.current.style.opacity = String(fade)
    if (chrome.current) chrome.current.style.opacity = String(clamp((fade - 0.4) / 0.6, 0, 1))
  }
  const sp = useRef<Spring | null>(null)
  const sx = useRef<Spring | null>(null)
  const sy = useRef<Spring | null>(null)
  if (!sp.current) {
    sp.current = new Spring(0, { response: 0.42, damping: 0.88, rest: 0.002, onUpdate: (v) => ((geo.current.p = v), paint()) })
    sx.current = new Spring(0, { response: 0.4, damping: 0.86, rest: 0.3, onUpdate: (v) => ((geo.current.dx = v), paint()) })
    sy.current = new Spring(0, { response: 0.4, damping: 0.86, rest: 0.3, onUpdate: (v) => ((geo.current.dy = v), paint()) })
  }
  useLayoutEffect(() => {
    paint()
    sp.current!.to(1)
    const back = document.activeElement as HTMLElement | null
    chrome.current?.querySelector<HTMLElement>('.lb-close')?.focus({ preventScroll: true })
    return () => back?.focus?.({ preventScroll: true })
    // opening runs once
  }, [])
  useLayoutEffect(() => paint(), [aspect])

  const close = (v = { x: 0, y: 0 }) => {
    if (closing.current) return
    closing.current = true
    from.current = source() || from.current
    sx.current!.to(0, { velocity: v.x })
    sy.current!.to(0, { velocity: v.y })
    sp.current!.to(0, { damping: 1, onRest: onClose })
  }
  const go = (d: number) => {
    if (photos.length < 2) return
    const i = (index + d + photos.length) % photos.length
    onIndex(i)
    if (!reducedMotion()) img.current?.animate([{ opacity: 0.2, transform: `translateX(${d * 28}px)` }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.7,.2,1)' })
  }
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopImmediatePropagation()
        close()
      }
      if (e.key === 'ArrowRight') go(1)
      if (e.key === 'ArrowLeft') go(-1)
    }
    // capture phase: Escape closes the photo, not the case file underneath
    addEventListener('keydown', k, true)
    return () => removeEventListener('keydown', k, true)
  })

  /* drag anywhere on the photo; a downward throw dismisses */
  const drag = useRef<{ x: number; y: number; id: number } | null>(null)
  const vt = useRef(new VelocityTracker())
  const down = (e: React.PointerEvent) => {
    if (e.button || closing.current) return
    drag.current = { x: e.clientX - geo.current.dx, y: e.clientY - geo.current.dy, id: e.pointerId }
    sx.current!.stop()
    sy.current!.stop()
    vt.current.reset()
    vt.current.add(e.clientX, e.clientY)
    capture(e.currentTarget, e.pointerId)
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    vt.current.add(e.clientX, e.clientY)
    sx.current!.set((e.clientX - d.x) * 0.6)
    sy.current!.set(e.clientY - d.y)
  }
  const up = () => {
    if (!drag.current) return
    drag.current = null
    const v = vt.current.get()
    const projected = geo.current.dy + project(v.y, 0.99)
    if (Math.abs(projected) > 160) close(v)
    else {
      sx.current!.to(0, { velocity: v.x, damping: 0.8 })
      sy.current!.to(0, { velocity: v.y, damping: 0.8 })
    }
  }

  const ph = photos[index]
  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label={`Кадр: ${ph.camera}`}>
      <div className="lb-scrim" ref={scrim} onClick={() => close()} style={{ opacity: 0 }} />
      <div className="lb-frame" ref={frame} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={() => close()}>
        <CameraViewImage imageRef={img} url={ph.url} alt={`Кадр: ${ph.camera}`} draggable={false} onLoad={(e) => e.currentTarget.naturalWidth && setAspect(e.currentTarget.naturalWidth / e.currentTarget.naturalHeight)} />
      </div>
      <div className="lb-chrome" ref={chrome} style={{ opacity: 0 }}>
        <div className="lb-cap">
          <b>{ph.camera}</b>
          <span>{caption}</span>
        </div>
        {photos.length > 1 && (
          <div className="lb-nav">
            <button type="button" onClick={() => go(-1)} aria-label="Предыдущий кадр">
              ‹
            </button>
            <span className="mono">
              {index + 1} / {photos.length}
            </span>
            <button type="button" onClick={() => go(1)} aria-label="Следующий кадр">
              ›
            </button>
          </div>
        )}
        <span className="lb-hint">Смахните вниз или Esc, чтобы закрыть</span>
        <button type="button" className="close-x lb-close" onClick={() => close()} aria-label="Закрыть кадр">
          <CloseIcon />
        </button>
      </div>
    </div>
  )
}
