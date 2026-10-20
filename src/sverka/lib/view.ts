/*
 * Camera view check: is the camera still looking where it was approved to look?
 *
 * The comparison is the server's (backend/app/services/camera_view.py): the frame is reduced to
 * 64×36 and its edges (the gradient of brightness) are correlated with the reference's edges in
 * 4×3 tiles; the median of the tiles is the score, so the camera's clock in a corner or a truck in
 * front of the lens does not decide it. Edges hardly change with light, clouds or evening.
 * "match" is the score as the camera stands (a point of mast sway allowed); the best score over
 * shifts of ±8 × ±5 points says where the camera was turned.
 * Sharpness is measured at 256×144: at 64×36 a blurred lens still looks sharp.
 */
export const VIEW_W = 64
export const VIEW_H = 36
export const SHARP_W = 256
export const SHARP_H = 144
const MAX_DX = 8
const MAX_DY = 5
const TILES_X = 4
const TILES_Y = 3
const JITTER = 1

export interface ViewFeatures {
  mag: Float32Array
  w: number
  h: number
  mean: number
  std: number
  sharp: number
}
export interface ViewMatch {
  match: number
  best: number
  dx: number
  dy: number
}
export type ViewProblem = 'turned' | 'covered' | 'blurred' | 'different'
export interface ViewJudgement {
  verdict: 'ok' | 'bad' | 'unsure'
  problem?: ViewProblem
}

export function grayOf(rgba: Uint8ClampedArray): Float32Array {
  const g = new Float32Array(rgba.length / 4)
  for (let i = 0, j = 0; i < rgba.length; i += 4, j++) g[j] = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
  return g
}

function edges(g: Float32Array, w: number, h: number) {
  const ew = w - 2
  const eh = h - 2
  const mag = new Float32Array(ew * eh)
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const gx = g[y * w + x + 1] - g[y * w + x - 1]
      const gy = g[(y + 1) * w + x] - g[(y - 1) * w + x]
      mag[(y - 1) * ew + (x - 1)] = Math.hypot(gx, gy)
    }
  return { mag, w: ew, h: eh }
}

/** Fine detail per unit of contrast: the mean absolute Laplacian over the spread of brightness.
    Dusk lowers both, a blurred lens only the first. */
function sharpness(g: Float32Array, w: number, h: number) {
  let s = 0
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      s += Math.abs(4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w])
    }
  return s / ((w - 2) * (h - 2)) / (spread(g) + 1)
}
function spread(g: Float32Array) {
  let sum = 0
  for (const v of g) sum += v
  const mean = sum / g.length
  let sq = 0
  for (const v of g) sq += (v - mean) ** 2
  return Math.sqrt(sq / g.length)
}

/** small: 64×36 RGBA, big: 256×144 RGBA of the same frame. */
export function viewFeatures(small: Uint8ClampedArray, big: Uint8ClampedArray): ViewFeatures {
  const g = grayOf(small)
  let sum = 0
  for (const v of g) sum += v
  const e = edges(g, VIEW_W, VIEW_H)
  return { mag: e.mag, w: e.w, h: e.h, mean: sum / g.length, std: spread(g), sharp: sharpness(grayOf(big), SHARP_W, SHARP_H) }
}

/** Correlation of a's region [y0, y1) × [x0, x1) with b's region shifted by (dx, dy). */
function ncc(a: ViewFeatures, b: ViewFeatures, dx: number, dy: number, y0: number, y1: number, x0: number, x1: number) {
  const { w } = a
  let sa = 0
  let sb = 0
  const n = (y1 - y0) * (x1 - x0)
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      sa += a.mag[y * w + x]
      sb += b.mag[(y + dy) * w + x + dx]
    }
  const ma = sa / n
  const mb = sb / n
  let ab = 0
  let aa = 0
  let bb = 0
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const p = a.mag[y * w + x] - ma
      const q = b.mag[(y + dy) * w + x + dx] - mb
      ab += p * q
      aa += p * p
      bb += q * q
    }
  const den = Math.sqrt(aa * bb)
  return den > 1e-6 ? ab / den : 0
}

function medianNcc(a: ViewFeatures, b: ViewFeatures, dx: number, dy: number) {
  const { w, h } = a
  const vals: number[] = []
  for (let i = 0; i < TILES_Y; i++)
    for (let j = 0; j < TILES_X; j++) {
      const ty0 = Math.round((h * i) / TILES_Y)
      const ty1 = Math.round((h * (i + 1)) / TILES_Y)
      const tx0 = Math.round((w * j) / TILES_X)
      const tx1 = Math.round((w * (j + 1)) / TILES_X)
      const y0 = Math.max(ty0, -dy)
      const y1 = Math.min(ty1, h - dy)
      const x0 = Math.max(tx0, -dx)
      const x1 = Math.min(tx1, w - dx)
      if ((y1 - y0) * (x1 - x0) < 0.6 * (ty1 - ty0) * (tx1 - tx0)) continue
      vals.push(ncc(a, b, dx, dy, y0, y1, x0, x1))
    }
  if (!vals.length) return 0
  vals.sort((p, q) => p - q)
  const m = vals.length >> 1
  return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2
}

/** ref[y, x] against cur[y + dy, x + dx]: dx > 0 means the picture moved right, the camera turned left. */
export function compareViews(ref: ViewFeatures, cur: ViewFeatures): ViewMatch {
  let match = -1
  let best = -1
  let bdx = 0
  let bdy = 0
  for (let dy = -MAX_DY; dy <= MAX_DY; dy++)
    for (let dx = -MAX_DX; dx <= MAX_DX; dx++) {
      const s = medianNcc(ref, cur, dx, dy)
      if (Math.abs(dx) <= JITTER && Math.abs(dy) <= JITTER) match = Math.max(match, s)
      if (s > best) {
        best = s
        bdx = dx
        bdy = dy
      }
    }
  return { match, best, dx: bdx, dy: bdy }
}

/** One frame's verdict. A turn is told by the frame matching only when shifted. */
export function judgeView(ref: ViewFeatures, cur: ViewFeatures, m: ViewMatch, ok: number, bad: number): ViewJudgement {
  // a hand, a cloth or a dark lens: almost no picture where the reference had one
  if (ref.std > 18 && (cur.std < 7 || (cur.mean < 30 && cur.std < 14))) return { verdict: 'bad', problem: 'covered' }
  if (ref.sharp > 0.02 && cur.sharp < ref.sharp * 0.4) return { verdict: 'bad', problem: 'blurred' }
  const shifted = m.best >= 0.7 && (Math.abs(m.dx) >= 2 || Math.abs(m.dy) >= 2)
  if (shifted && (m.match < bad || (m.match < ok && m.best - m.match >= 0.25))) return { verdict: 'bad', problem: 'turned' }
  if (m.match < bad) return { verdict: 'bad', problem: 'different' }
  if (m.match >= ok) return { verdict: 'ok' }
  return { verdict: 'unsure' }
}

/** A camera turned away or being moved says nothing about the site: its frames are not used. */
export const viewBlocked = (s: { view?: { state: string } }) => s.view?.state === 'changed' || s.view?.state === 'move'

/** Where the camera was turned, in words: «влево и вниз примерно на 10 %». */
export function turnWords(m: { dx?: number; dy?: number }) {
  const dx = m.dx ?? 0
  const dy = m.dy ?? 0
  const parts: string[] = []
  if (Math.abs(dx) >= 2) parts.push(dx > 0 ? 'влево' : 'вправо')
  if (Math.abs(dy) >= 2) parts.push(dy > 0 ? 'вверх' : 'вниз')
  if (!parts.length) return ''
  const pct = Math.round(Math.max(Math.abs(dx) / (VIEW_W - 2), Math.abs(dy) / (VIEW_H - 2)) * 100)
  return `${parts.join(' и ')} примерно на ${Math.max(5, Math.round(pct / 5) * 5)} %`
}

export const PROBLEM_WORD: Record<ViewProblem, string> = {
  turned: 'камеру повернули',
  covered: 'объектив закрыт',
  blurred: 'изображение размыто',
  different: 'камера смотрит на другую сцену',
}
