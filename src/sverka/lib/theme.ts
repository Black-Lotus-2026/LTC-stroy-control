import { useSyncExternalStore } from 'react'
import { reducedMotion } from './spring'

/*
 * Light and dark. The choice belongs to the viewer and stays in this browser; «авто» follows the
 * system and keeps following it. The theme in force sits on <html data-theme>: the stylesheet
 * switches its colour tokens on it, the canvases of the intro read their palette from it.
 */

export type ThemePref = 'auto' | 'light' | 'dark'
export type Theme = 'light' | 'dark'
type V3 = [number, number, number]

const KEY = 'sverka:theme'
const system = matchMedia('(prefers-color-scheme: light)')
const subs = new Set<() => void>()
const notify = () => subs.forEach((f) => f())
const subscribe = (f: () => void) => {
  subs.add(f)
  return () => void subs.delete(f)
}

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'light' || v === 'dark' ? v : 'auto'
  } catch {
    return 'auto'
  }
}
const resolve = (p: ThemePref): Theme => (p === 'auto' ? (system.matches ? 'light' : 'dark') : p)
/** The theme in force now. */
export const theme = (): Theme => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')

// the browser's own chrome (mobile address bar) takes the colour of the page
const CHROME: Record<Theme, string> = { dark: '#0c0e11', light: '#eeece6' }
function apply(t: Theme) {
  document.documentElement.dataset.theme = t
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', CHROME[t])
}

type ViewTransition = { ready: Promise<void> }
/**
 * Changes the theme behind a view transition: the new colours spread in a circle from where the
 * choice was made, or simply come up over the old ones. Without the API or with reduced motion
 * they change at once.
 */
function change(t: Theme, from?: { x: number; y: number }) {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => ViewTransition }
  if (!doc.startViewTransition || reducedMotion() || document.visibilityState !== 'visible') {
    apply(t)
    return
  }
  const vt = doc.startViewTransition(() => apply(t))
  vt.ready
    .then(() => {
      const opts = { duration: from ? 620 : 420, easing: 'cubic-bezier(0.23, 1, 0.32, 1)', pseudoElement: '::view-transition-new(root)' }
      if (!from) return void document.documentElement.animate({ opacity: [0, 1] }, opts)
      const r = Math.hypot(Math.max(from.x, innerWidth - from.x), Math.max(from.y, innerHeight - from.y))
      document.documentElement.animate({ clipPath: [`circle(0px at ${from.x}px ${from.y}px)`, `circle(${r}px at ${from.x}px ${from.y}px)`] }, opts)
    })
    .catch(() => undefined)
}

/** Sets the theme before the first paint and follows the system while the choice is «авто». */
export function initTheme() {
  apply(resolve(themePref()))
  system.addEventListener('change', () => {
    if (themePref() !== 'auto') return
    change(resolve('auto'))
    notify()
  })
}

/** Remembers the choice and changes the theme; `from` is where on the screen the choice was made. */
export function setThemePref(p: ThemePref, from?: { x: number; y: number }) {
  try {
    if (p === 'auto') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, p)
  } catch {
    // storage unavailable: the choice lasts until reload
  }
  const t = resolve(p)
  if (t !== theme()) change(t, from)
  notify()
}

export function useThemePref() {
  return useSyncExternalStore(subscribe, themePref)
}

/* ── colours of the canvases (the stylesheet has its own) ── */

export interface Palette {
  /** the fact: dashes of machinery, the drawing's lines */
  ink: V3
  /** the plan: dashes of buildings */
  gold: V3
  /** the subject's name tag over the drawing */
  tagBg: string
  tagFg: string
  /** the tagline lying in front of the letters */
  plate: string
  /** the plumb bob's thread */
  thread: string
  /** contact shadows under the letters and the kit, at the strongest */
  shadow: number
  /** floodlights of the site */
  beam: V3
  lamp: string
}

const PALETTE: Record<Theme, Palette> = {
  dark: { ink: [242, 239, 233], gold: [232, 189, 102], tagBg: 'rgba(12,14,17,0.72)', tagFg: 'rgb(242,239,233)', plate: '#b9b6b0', thread: 'rgb(212,206,194)', shadow: 0.7, beam: [255, 236, 200], lamp: '#ffe9c4' },
  // graphite on drawing paper; the gold goes darker so the plan still reads on white
  light: { ink: [30, 31, 34], gold: [166, 112, 24], tagBg: 'rgba(253,252,250,0.86)', tagFg: 'rgb(23,25,28)', plate: '#55565b', thread: 'rgb(98,94,86)', shadow: 0.42, beam: [214, 158, 56], lamp: '#d99a2b' },
}
export const palette = (t: Theme = theme()) => PALETTE[t]
export const rgba = (c: V3, a: number) => `rgba(${c[0]},${c[1]},${c[2]},${a.toFixed(3)})`
