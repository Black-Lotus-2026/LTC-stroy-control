/*
 * A recording played in a loop instead of the live camera.
 *
 * A live site never repeats itself to the pixel: even when an excavator works in cycles, people,
 * trucks, the soil and the light are elsewhere the next time round. A loop does: one period later
 * the whole frame comes back, differing only by compression noise and the camera's clock.
 *
 * Each frame is kept for 30 minutes as 96×54 brightness. A new frame is compared with every frame
 * older than 30 s: the closest one is a candidate repeat, and the period is how long ago it was.
 * The closeness is measured against the motion of the moment: the difference to the closest old
 * frame over the difference to the frame two seconds ago. A loop gives a few per cent (the frames
 * are taken up to a second off the previous pass); a live work cycle gives tens of per cent.
 * Of the last LOOP_DEFAULTS.window frames, at least `need` must repeat at one period (±4 s, or a
 * multiple of it) with a median closeness of `maxMedian`, and `needExact` of them must be near-exact
 * copies: on test streams a loop gave 12 of 12, a live work cycle none. Frames without motion say nothing and are skipped: a still
 * scene cannot be told from a still recording.
 */
export const LOOP_W = 96
export const LOOP_H = 54

export const LOOP_DEFAULTS = {
  keepMs: 30 * 60_000,
  /** shorter loops are not looked for */
  minPeriod: 30_000,
  window: 12,
  need: 9,
  periodTol: 4_000,
  /** a frame repeats when its closest old frame differs this much of the motion, at most */
  maxRatio: 0.35,
  /** and the repeats of a loop are this close in the median; a live work cycle stays near 0.5 and above */
  maxMedian: 0.2,
  /** a near-exact copy: a loop has many of them, a live scene almost none even in a steady work cycle */
  exact: 0.08,
  needExact: 4,
  /** RMS brightness change between frames (0–255) below which the scene counts as still */
  minMotion: 1,
}
export type LoopOptions = typeof LOOP_DEFAULTS

export interface LoopState {
  looped: boolean
  /** how long one pass of the recording is */
  period?: number
  /** observation time the repetition was first seen */
  since?: number
  /** the earlier frame that the current one repeats */
  then?: { at: number; snap?: string }
  /** the median closeness of the repeats, 0 is an exact copy */
  closeness?: number
}

interface Frame {
  at: number
  g: Uint8ClampedArray
  mean: number
  snap?: string
}
interface Step {
  at: number
  ratio: number
  period: number
  then: Frame
}

/** RGBA → brightness bytes and their mean. */
export function loopGray(rgba: Uint8ClampedArray) {
  const g = new Uint8ClampedArray(rgba.length / 4)
  let sum = 0
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) {
    g[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
    sum += g[j]
  }
  return { g, mean: sum / g.length }
}

/** RMS difference with the overall brightness taken out, so a cloud does not count as change. */
function rms(a: Frame, b: Frame) {
  const off = a.mean - b.mean
  let s = 0
  for (let i = 0; i < a.g.length; i++) {
    const d = a.g[i] - b.g[i] - off
    s += d * d
  }
  return Math.sqrt(s / a.g.length)
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

export class LoopDetector {
  private o: LoopOptions
  private frames: Frame[] = []
  private steps: (Step | null)[] = []
  private quiet = 0
  state: LoopState = { looped: false }

  constructor(options: Partial<LoopOptions> = {}) {
    this.o = { ...LOOP_DEFAULTS, ...options }
  }

  push(at: number, gray: { g: Uint8ClampedArray; mean: number }, snap?: string): LoopState {
    const o = this.o
    const cur: Frame = { at, g: gray.g, mean: gray.mean, snap }
    const prev = this.frames[this.frames.length - 1]
    const motion = prev ? rms(cur, prev) : 0
    if (prev && motion >= o.minMotion) {
      let best = Infinity
      const ds: number[] = []
      for (const f of this.frames) {
        if (at - f.at < o.minPeriod) break
        const d = rms(cur, f)
        ds.push(d)
        if (d < best) best = d
      }
      // every pass of a loop matches about as well: the most recent of them gives the period
      let then: Frame | null = null
      for (let i = ds.length - 1; i >= 0; i--)
        if (ds[i] <= Math.max(best * 1.6, best + 0.3)) {
          then = this.frames[i]
          best = ds[i]
          break
        }
      this.steps.push(then ? { at, ratio: best / motion, period: at - then.at, then } : null)
      if (this.steps.length > o.window) this.steps.shift()
      this.judge()
    }
    this.frames.push(cur)
    while (this.frames.length && at - this.frames[0].at > o.keepMs) this.frames.shift()
    return this.state
  }

  private judge() {
    const o = this.o
    const reps = this.steps.filter((s): s is Step => !!s && s.ratio <= o.maxRatio)
    let found: { period: number; closeness: number; then: Frame; from: number } | null = null
    if (reps.length >= o.need) {
      // a frame may repeat two or three passes back: periods are multiples of one
      const base = Math.min(...reps.map((s) => s.period))
      const same = reps.filter((s) => {
        const k = Math.max(1, Math.round(s.period / base))
        return Math.abs(s.period - k * base) <= o.periodTol * k
      })
      const closeness = same.length ? median(same.map((s) => s.ratio)) : 1
      const p = median(same.map((s) => s.period / Math.max(1, Math.round(s.period / base))))
      const exact = same.filter((s) => s.ratio <= o.exact).length
      if (same.length >= o.need && closeness <= o.maxMedian && exact >= o.needExact) found = { period: p, closeness, then: same[same.length - 1].then, from: same[0].at }
    }
    if (found) {
      this.quiet = 0
      const was = this.state
      this.state = {
        looped: true,
        period: found.period,
        since: was.looped ? was.since : found.from,
        then: { at: found.then.at, snap: found.then.snap },
        closeness: found.closeness,
      }
    } else if (this.state.looped && ++this.quiet >= o.window) this.state = { looped: false }
  }
}
