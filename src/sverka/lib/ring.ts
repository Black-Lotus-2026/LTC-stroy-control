import { reducedMotion } from './spring'
import { PARALLAX } from './wire'

/*
 * The name in solid letters standing on a ring round the drawing of the intro page, the tagline as a
 * low plate in front of them, and the site's kit left about them. Same camera as the wireframe in its
 * intro layout (wire.ts: distance 5, pitch 0.3, its unit, centre at 62 % / 47 %), so blocks and drawing
 * share one perspective; the canvas lies under the drawing's.
 *
 * Every letter is a stack of sprites from its back wall to its face, each set by the projection of its
 * own corners. Wall sprites are shaded from the outline's normals: tops catch the light from above,
 * left walls are half lit, right walls fall into shade. Every 9 s a light passes along the name and
 * carries the letters on to the next matte material, graphite → gold → ceramic. The floor mirrors the
 * whole blocks, softly. Shape and kit were chosen on docs/ui-concept/intro-sides.html.
 */

type V = number[]
type Mat = 'graphite' | 'gold' | 'ceramic'

const FONT_PX = 140, TAG_PX = 18, PAD = 10, LEVELS = 16
const WORD = 'СТРОЙ КОНТРОЛЬ', TAG = 'НАБЛЮДАЙТЕ ЗА ЭТАПАМИ СТРОЙКИ · ИЗ ЕДИНОЙ ТОЧКИ'
// the shape chosen for a 16:9 screen; on narrower ones the ring comes in so the name stays in view
const SHAPE = { R: 2.38, y: -0.75, center: -20, size: 0.26, depth: 0.18 }
/** Where the intro lays the drawing out right of centre (wire.ts, landscape); elsewhere the flat type stays. */
export const RING_MEDIA = '(min-width: 721px) and (min-aspect-ratio: 5/6)'

/* ── letters ── */

interface Material { face: [number, V][]; rim: V; rimK: number; top: V; side: V; shade: V; back: number; sheen: V; sheenA: number; glow: number; grain: number; refl: number }
/* Colours 0..1. `face` runs from the top of a face to its foot, `rim` is a thin chamfer of light along
   the upper outlines; walls take `top` where they face up, `side` where they face left, `shade` where
   they face away, darkening by `back` towards the back. `sheen` is a soft reflection sliding over a
   face as it turns to the camera, `glow` the passing light, `refl` the strength of the floor mirror. */
const MATS: Record<Mat, Material> = {
  graphite: { face: [[0, [0.24, 0.24, 0.25]], [1, [0.14, 0.14, 0.15]]], rim: [0.6, 0.59, 0.57], rimK: 0.3, top: [0.56, 0.56, 0.57], side: [0.2, 0.2, 0.21], shade: [0.05, 0.05, 0.06], back: 0.5, sheen: [1, 0.98, 0.94], sheenA: 0.05, glow: 0.16, grain: 0.035, refl: 0.2 },
  gold: { face: [[0, [0.62, 0.47, 0.22]], [1, [0.4, 0.28, 0.11]]], rim: [1, 0.88, 0.62], rimK: 0.32, top: [0.98, 0.83, 0.52], side: [0.44, 0.3, 0.11], shade: [0.15, 0.09, 0.03], back: 0.5, sheen: [1, 0.94, 0.8], sheenA: 0.07, glow: 0.2, grain: 0.03, refl: 0.2 },
  ceramic: { face: [[0, [0.74, 0.73, 0.71]], [1, [0.56, 0.55, 0.53]]], rim: [1, 1, 1], rimK: 0.28, top: [0.98, 0.97, 0.95], side: [0.46, 0.45, 0.44], shade: [0.2, 0.19, 0.18], back: 0.45, sheen: [1, 1, 1], sheenA: 0.06, glow: 0.18, grain: 0.025, refl: 0.18 },
}
// the order the passing light carries the letters through
const MAT_SEQ: Mat[] = ['graphite', 'gold', 'ceramic']

interface Metrics { c: CanvasRenderingContext2D; cap: number; base: number }
interface Mask { w: number; h: number; adv: number; mask: HTMLCanvasElement; A: Uint8ClampedArray }
interface Sprite { w: number; h: number; adv: number; walls: HTMLCanvasElement[]; face: HTMLCanvasElement }

const mk = (w: number, h: number) => {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}
const ctx2d = (c: HTMLCanvasElement) => c.getContext('2d', { willReadFrequently: true })!
function measure(font: string): Metrics {
  const c = mk(1, 1).getContext('2d')!
  c.font = font
  const px = parseFloat(font.split(' ')[1])
  const m = c.measureText('Н')
  return { c, cap: m.actualBoundingBoxAscent, base: (px - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent }
}
const ramp = (stops: [number, V][], x: number, out: V) => {
  let k = 0
  while (k < stops.length - 2 && x > stops[k + 1][0]) k++
  const [x0, c0] = stops[k], [x1, c1] = stops[Math.min(k + 1, stops.length - 1)]
  const u = x1 > x0 ? Math.max(0, Math.min(1, (x - x0) / (x1 - x0))) : 0
  for (let c = 0; c < 3; c++) out[c] = c0[c] + (c1[c] - c0[c]) * u
  return out
}

// built once per page: fonts, sprites and meshes do not change
let met: Metrics | null = null, tagMet: Metrics | null = null, shadow: HTMLCanvasElement | null = null
const masks = new Map<string, Mask>()
const sprites = new Map<string, Sprite>()
let canFilter: boolean | null = null

// the letter's ink, white on clear, with its alpha; the kit finds its place on a letter from it
function glyphMask(ch: string): Mask {
  const hit = masks.get(ch)
  if (hit) return hit
  const adv = met!.c.measureText(ch).width
  const w = Math.ceil(adv) + PAD * 2, h = FONT_PX + PAD * 2
  const mask = mk(w, h), m = ctx2d(mask)
  m.font = `700 ${FONT_PX}px Stolzl`
  m.fillStyle = '#fff'
  m.fillText(ch, PAD, PAD + met!.base)
  const gm = { w, h, adv, mask, A: m.getImageData(0, 0, w, h).data }
  masks.set(ch, gm)
  return gm
}
// the ink's alpha softened by 4 px, for the outline's normals; by hand where canvas filters are missing
function softAlpha({ w, h, mask, A }: Mask): Float32Array {
  if (canFilter === null) {
    const t = mk(1, 1).getContext('2d')!
    t.filter = 'blur(1px)'
    canFilter = t.filter === 'blur(1px)'
  }
  const out = new Float32Array(w * h)
  if (canFilter) {
    const b = ctx2d(mk(w, h))
    b.filter = 'blur(4px)'
    b.drawImage(mask, 0, 0)
    const B = b.getImageData(0, 0, w, h).data
    for (let i = 0; i < out.length; i++) out[i] = B[i * 4 + 3]
    return out
  }
  // three box passes each way come close to a Gaussian
  for (let i = 0; i < out.length; i++) out[i] = A[i * 4 + 3]
  const tmp = new Float32Array(w * h), r = 4, d = 2 * r + 1
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0
        for (let k = -r; k <= r; k++) s += out[y * w + Math.min(w - 1, Math.max(0, x + k))]
        tmp[y * w + x] = s / d
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0
        for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]
        out[y * w + x] = s / d
      }
  }
  return out
}
// one letter in one material: walls at LEVELS depths and the face
function letterSprite(ch: string, mat: Mat): Sprite {
  const key = mat + ':' + ch
  const hit = sprites.get(key)
  if (hit) return hit
  const M = MATS[mat]
  const gm = glyphMask(ch), { w, h, adv, A } = gm
  const B = softAlpha(gm)
  const n = w * h, nx = new Float32Array(n), ny = new Float32Array(n), edge = new Float32Array(n)
  let gmax = 1e-6
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx = B[i + 1] - B[i - 1], gy = B[i + w] - B[i - w]
      const g = Math.hypot(gx, gy)
      // alpha grows inwards, so the outward normal is minus the gradient
      if (g > 0) {
        nx[i] = -gx / g
        ny[i] = -gy / g
      }
      edge[i] = g
      gmax = Math.max(gmax, g)
    }
  const yTop = PAD + met!.base - met!.cap
  const out = [0, 0, 0]
  const seed = ch.charCodeAt(0)
  const paint = (fn: (i: number, o: V) => void) => {
    const c = mk(w, h), x = c.getContext('2d')!, img = x.createImageData(w, h)
    for (let i = 0; i < n; i++) {
      const a = A[i * 4 + 3]
      if (!a) continue
      fn(i, out)
      const r = Math.sin(i * 12.9898 + seed) * 43758.5453, gn = (r - Math.floor(r) - 0.5) * M.grain
      img.data[i * 4] = Math.min(255, (out[0] + gn) * 255)
      img.data[i * 4 + 1] = Math.min(255, (out[1] + gn) * 255)
      img.data[i * 4 + 2] = Math.min(255, (out[2] + gn) * 255)
      img.data[i * 4 + 3] = a
    }
    x.putImageData(img, 0, 0)
    return c
  }
  const S = (i: number) => Math.min(1, edge[i] / (gmax * 0.3))
  const LX = -0.42, LY = -0.91 // light in image space: from above, a little from the left
  const walls: HTMLCanvasElement[] = []
  for (let lv = 0; lv < LEVELS; lv++) {
    const lf = lv / (LEVELS - 1)
    walls.push(
      paint((i, o) => {
        const s = S(i)
        // tops catch the light; undersides are never seen on the block itself, only in the floor
        // mirror, so they take the same light and the reflection keeps the block's volume
        const wt = Math.pow(Math.abs(ny[i]), 1.3), wl = Math.max(0, -nx[i]) * (1 - wt)
        for (let c = 0; c < 3; c++) {
          const v = M.shade[c] + (M.side[c] - M.shade[c]) * wl + (M.top[c] - M.shade[c]) * wt
          o[c] = (M.shade[c] * (1 - s) + v * s) * (1 - M.back * lf)
        }
      }),
    )
  }
  const face = paint((i, o) => {
    const s = S(i), yf = (Math.floor(i / w) - yTop) / met!.cap
    ramp(M.face, Math.max(0, Math.min(1, yf)), o)
    const rim = M.rimK * s * s * Math.max(0, nx[i] * LX + ny[i] * LY)
    for (let c = 0; c < 3; c++) o[c] = o[c] * (1 - rim) + M.rim[c] * rim
  })
  const sp = { w, h, adv, walls, face }
  sprites.set(key, sp)
  return sp
}
function tagSprite(ch: string): Sprite {
  const key = 'tag:' + ch
  const hit = sprites.get(key)
  if (hit) return hit
  const adv = tagMet!.c.measureText(ch).width
  const w = Math.ceil(adv) + 4, h = TAG_PX + 4, c = mk(w, h), x = c.getContext('2d')!
  x.font = `500 ${TAG_PX}px "Vela Sans"`
  x.fillStyle = '#b9b6b0'
  x.fillText(ch, 2, 2 + tagMet!.base)
  const sp = { w, h, adv, walls: [], face: c }
  sprites.set(key, sp)
  return sp
}
// reading a letter's ink: solid pixels, the top of it, the runs of ink on a row, its left and right edges
const solid = (gm: Mask, x: number, y: number) => x >= 0 && y >= 0 && x < gm.w && y < gm.h && gm.A[(y * gm.w + x) * 4 + 3] > 127
function inkTop(gm: Mask) {
  let y = 0
  find: for (; y < gm.h; y++) for (let x = 0; x < gm.w; x++) if (solid(gm, x, y)) break find
  let xa = gm.w, xb = -1
  for (let x = 0; x < gm.w; x++)
    if (solid(gm, x, y + 3)) {
      xa = Math.min(xa, x)
      xb = x
    }
  return { y, xa, xb }
}
const inkRuns = (gm: Mask, y: number) => {
  const r: [number, number][] = []
  let s = -1
  for (let x = 0; x <= gm.w; x++) {
    const on = solid(gm, x, y)
    if (on && s < 0) s = x
    else if (!on && s >= 0) {
      r.push([s, x - 1])
      s = -1
    }
  }
  return r
}
const inkEdge = (gm: Mask, fromRight: boolean) => {
  for (let k = 0; k < gm.w; k++) {
    const x = fromRight ? gm.w - 1 - k : k
    for (let y = 0; y < gm.h; y++) if (solid(gm, x, y)) return x
  }
  return fromRight ? gm.w - 1 : 0
}

/* ── the kit: a hard hat, bricks, a bucket of mortar, a road cone, a plumb bob, a spirit level, a spade ──
   Little meshes measured in letter heights (a letter is about 70 cm), drawn face by face from the back
   (painter's order) in the light of the letter they belong to. */

type Finish = 'plastic' | 'paint' | 'matte' | 'brass' | 'metal'
interface Face { p: V[]; n: V; c: V; m: Finish; grp: number; body: number; cl?: V }
const FINISH: Record<Finish, { amb: number; dif: number; spec: number; shin: number }> = {
  plastic: { amb: 0.22, dif: 0.85, spec: 0.34, shin: 20 },
  paint: { amb: 0.22, dif: 0.85, spec: 0.12, shin: 12 },
  matte: { amb: 0.22, dif: 0.85, spec: 0, shin: 1 },
  brass: { amb: 0.2, dif: 0.75, spec: 0.75, shin: 40 },
  metal: { amb: 0.24, dif: 0.72, spec: 0.5, shin: 18 },
}
// red: on sites the hard hat of a master or a foreman, the role the intro shows
const HAT: V = [0.7, 0.11, 0.08]
const BRICK = [0.36, 0.09, 0.17] // 250 × 65 × 120 mm
const norm = (v: V) => {
  const n = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / n, v[1] / n, v[2] / n]
}
const cross = (a: V, b: V) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: V, b: V) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const avg = (ps: V[]) => {
  const o = [0, 0, 0]
  for (const q of ps) for (let k = 0; k < 3; k++) o[k] += q[k] / ps.length
  return o
}
const mul3 = (A: V[], B: V[]) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]))
const app3 = (M: V[], q: V) => M.map((r) => r[0] * q[0] + r[1] * q[1] + r[2] * q[2])
// turned about the vertical (yaw, front towards the right), then the depth axis (roll), then the length (pitch)
function rotM(yaw = 0, roll = 0, pitch = 0) {
  const c = Math.cos, s = Math.sin
  return mul3(mul3([[c(yaw), 0, s(yaw)], [0, 1, 0], [-s(yaw), 0, c(yaw)]], [[c(roll), -s(roll), 0], [s(roll), c(roll), 0], [0, 0, 1]]), [[1, 0, 0], [0, c(pitch), -s(pitch)], [0, s(pitch), c(pitch)]])
}
// faces carry their outward normal; `grp` is drawn over lower groups (what rests on what, seen from
// above), `body` keeps a part's faces together when they are sorted
function box(out: Face[], x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, c: V, m: Finish, grp = 0, body = 0) {
  const v = (i: number, j: number, k: number) => [i ? x1 : x0, j ? y1 : y0, k ? z1 : z0]
  const f = (p: V[], n: V) => out.push({ p, n, c, m, grp, body })
  f([v(0, 0, 1), v(1, 0, 1), v(1, 1, 1), v(0, 1, 1)], [0, 0, 1])
  f([v(1, 0, 0), v(0, 0, 0), v(0, 1, 0), v(1, 1, 0)], [0, 0, -1])
  f([v(0, 1, 1), v(1, 1, 1), v(1, 1, 0), v(0, 1, 0)], [0, 1, 0])
  f([v(0, 0, 0), v(1, 0, 0), v(1, 0, 1), v(0, 0, 1)], [0, -1, 0])
  f([v(1, 0, 1), v(1, 0, 0), v(1, 1, 0), v(1, 1, 1)], [1, 0, 0])
  f([v(0, 0, 0), v(0, 0, 1), v(0, 1, 1), v(0, 1, 0)], [-1, 0, 0])
  return out
}
function placed(faces: Face[], M: V[], t: V, out: Face[]) {
  for (const f of faces) out.push({ ...f, p: f.p.map((q) => app3(M, q).map((x, k) => x + t[k])), n: app3(M, f.n) })
  return out
}
// a body of revolution round the vertical from a profile of [radius, height] running from the top down
function lathe(out: Face[], prof: V[], seg: number, colOf: (i: number) => V, m: Finish, grp = 0, body = 0) {
  const P = (r: number, y: number, a: number) => [r * Math.sin(a), y, r * Math.cos(a)]
  for (let i = 0; i < prof.length - 1; i++) {
    const [r0, y0] = prof[i], [r1, y1] = prof[i + 1]
    const l = Math.hypot(r1 - r0, y1 - y0) || 1, nr = (y0 - y1) / l, ny = (r1 - r0) / l
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * 2 * Math.PI, a1 = ((k + 1) / seg) * 2 * Math.PI, am = (a0 + a1) / 2
      out.push({ p: [P(r0, y0, a0), P(r1, y1, a0), P(r1, y1, a1), P(r0, y0, a1)], n: [nr * Math.sin(am), ny, nr * Math.cos(am)], c: colOf(i), m, grp, body })
    }
  }
  return out
}
// a hard hat: a tall shell with a crest and two ribs from front to back, a brim all round that turns
// down at the back into a gutter, and a peak sloping down in front
function hatMesh() {
  const out: Face[] = [], a = 0.145, c = 0.17, H = 0.17, N = 44, NR = 11
  const th = (s: number) => 2 * Math.PI * s - 0.34 * Math.sin(4 * Math.PI * s) // denser at the front and back, where the crest runs
  const shell = (t: number, f: number) => {
    const sf = Math.sin(f), r = Math.pow(Math.cos(f), 0.62), x = a * Math.sin(t) * r
    const ribs = 0.04 * Math.exp(-((x / 0.024) ** 2)) * Math.pow(sf, 0.9) + 0.016 * (Math.exp(-(((x - 0.072) / 0.016) ** 2)) + Math.exp(-(((x + 0.072) / 0.016) ** 2))) * sf * sf
    return [x, H * Math.pow(sf, 0.9) + ribs, c * Math.cos(t) * r - 0.012 * sf]
  }
  const reach = (t: number) => {
    const k = Math.cos(t)
    return 0.016 + 0.1 * Math.pow(Math.max(0, k), 1.7) + 0.034 * Math.pow(Math.max(0, -k), 2)
  }
  const rim = (t: number) => [a * Math.sin(t), 0, c * Math.cos(t)]
  const edge = (t: number, dy = 0) => {
    const n = norm([Math.sin(t) / a, 0, Math.cos(t) / c]), e = reach(t)
    return [a * Math.sin(t) + n[0] * e, dy - 0.3 * e - 0.02 * Math.pow(Math.max(0, -Math.cos(t)), 1.5), c * Math.cos(t) + n[2] * e]
  }
  const raw: { p: V[]; grp: number; body: number }[] = []
  for (let i = 0; i < N; i++) {
    const t0 = th(i / N), t1 = th((i + 1) / N)
    for (let j = 0; j < NR; j++) {
      const f0 = ((j / NR) * Math.PI) / 2, f1 = (((j + 1) / NR) * Math.PI) / 2
      raw.push({ p: [shell(t0, f0), shell(t1, f0), shell(t1, f1), shell(t0, f1)], grp: 1, body: 1 })
    }
    raw.push({ p: [rim(t0), rim(t1), edge(t1), edge(t0)], grp: 0, body: 0 })
    raw.push({ p: [edge(t0), edge(t1), edge(t1, -0.008), edge(t0, -0.008)], grp: 0, body: 0 })
  }
  // normals from the faces, turned away from a point well under the hat
  for (const { p, grp, body } of raw) {
    const n = norm(cross(sub(p[2], p[0]), sub(p[3], p[1])))
    out.push({ p, n: dot(n, sub(avg(p), [0, -1, 0])) < 0 ? n.map((x) => -x) : n, c: HAT, m: 'plastic', grp, body })
  }
  return out
}
const rnd = (i: number) => {
  const r = Math.sin(i * 91.7 + 3.1) * 43758.5453
  return r - Math.floor(r)
}
// a brick of fired clay; every one a little different, every side of it a little different
function brick(out: Face[], x: number, y: number, z: number, yaw: number, i: number, grp: number, half = false) {
  const [l, h, w] = BRICK, L = half ? l / 2 : l, f = rnd(i)
  const faces = box([], -L / 2, 0, -w / 2, L / 2, h, w / 2, [0.56 + 0.1 * f, 0.25 + 0.05 * f, 0.16 + 0.04 * f], 'matte', grp, i)
  faces.forEach((fc, k) => {
    const d = 0.93 + 0.12 * rnd(i * 7 + k)
    fc.c = fc.c.map((x) => x * d)
  })
  return placed(faces, rotM(yaw), [x, y, z], out)
}
// a little pile: three bricks, two across them, one more on top
function stackMesh() {
  const out: Face[] = [], [, h, w] = BRICK, d = w + 0.012, e = d / 2
  ;[-d, 0, d].forEach((z, i) => brick(out, 0, 0, z, 0, 11 + i, 0))
  brick(out, e, h, 0, Math.PI / 2, 21, 1)
  brick(out, -e, h, 0, Math.PI / 2, 22, 1)
  brick(out, 0.01, 2 * h, 0.02, 0.38, 23, 2)
  return out
}
// a road cone: black square foot, orange body with two white bands
function coneMesh() {
  const out: Face[] = [], or = [0.93, 0.38, 0.07], wh = [0.9, 0.9, 0.88]
  box(out, -0.15, 0, -0.15, 0.15, 0.024, 0.15, [0.07, 0.07, 0.08], 'matte', 0, 0)
  const y0 = 0.024, y1 = 0.49, r = (y: number) => 0.11 + ((0.022 - 0.11) * (y - y0)) / (y1 - y0)
  lathe(out, [[0, y1 + 0.006], [0.022, y1], ...[0.39, 0.325, 0.27, 0.2].map((y) => [r(y), y]), [0.11, y0]], 20, (i) => (i === 2 || i === 4 ? wh : or), 'paint', 1, 1)
  return out
}
// a brass plumb bob, its top at the thread
const plumbMesh = () => lathe([], [[0, 0.006], [0.01, 0.006], [0.014, 0], [0.034, -0.011], [0.042, -0.03], [0.042, -0.098], [0.034, -0.112], [0, -0.21]], 16, () => [0.86, 0.66, 0.32], 'brass')
// a spirit level: yellow body on black rubber ends, the green vial seen from the front and from above
function levelMesh(len: number) {
  const out: Face[] = [], hl = len / 2, H = 0.075, D = 0.045, e = 0.035, k = [0.07, 0.07, 0.08], g = [0.36, 0.8, 0.2]
  box(out, -hl + e, 0.003, -D / 2, hl - e, H + 0.003, D / 2, [0.95, 0.74, 0.14], 'paint', 0, 0)
  box(out, -hl, 0, -D / 2 - 0.004, -hl + e, H + 0.006, D / 2 + 0.004, k, 'matte', 1, 1)
  box(out, hl - e, 0, -D / 2 - 0.004, hl, H + 0.006, D / 2 + 0.004, k, 'matte', 1, 2)
  const z = D / 2 + 0.0015, y = H + 0.0045
  out.push({ p: [[-0.055, 0.02, z], [0.055, 0.02, z], [0.055, 0.058, z], [-0.055, 0.058, z]], n: [0, 0, 1], c: g, m: 'plastic', grp: 2, body: 3 })
  out.push({ p: [[-0.045, y, 0.011], [0.045, y, 0.011], [0.045, y, -0.011], [-0.045, y, -0.011]], n: [0, 1, 0], c: g, m: 'plastic', grp: 2, body: 4 })
  out.push({ p: [[-0.012, 0.032, z + 0.0005], [0.012, 0.032, z + 0.0005], [0.012, 0.046, z + 0.0005], [-0.012, 0.046, z + 0.0005]], n: [0, 0, 1], c: [0.84, 0.96, 0.78], m: 'plastic', grp: 3, body: 5 })
  return out
}
// a small spade, point down: a flat steel blade, the socket, a wooden handle with a crossbar grip
function spadeMesh() {
  const out: Face[] = [], st = [0.46, 0.48, 0.51], wood = [0.6, 0.43, 0.26], T = 0.004
  const ol = [[0, 0], [0.05, 0.02], [0.08, 0.07], [0.08, 0.2], [-0.08, 0.2], [-0.08, 0.07], [-0.05, 0.02]]
  out.push({ p: ol.map(([x, y]) => [x, y, T]), n: [0, 0, 1], c: st, m: 'metal', grp: 0, body: 0 })
  out.push({ p: ol.map(([x, y]) => [x, y, -T]).reverse(), n: [0, 0, -1], c: st, m: 'metal', grp: 0, body: 0 })
  ol.forEach(([x0, y0], i) => {
    const [x1, y1] = ol[(i + 1) % ol.length]
    out.push({ p: [[x0, y0, T], [x1, y1, T], [x1, y1, -T], [x0, y0, -T]], n: norm([y1 - y0, x0 - x1, 0]), c: st, m: 'metal', grp: 0, body: 0 })
  })
  lathe(out, [[0.016, 0.27], [0.022, 0.2]], 10, () => st, 'metal', 1, 1)
  lathe(out, [[0.014, 0.7], [0.014, 0.27]], 10, () => wood, 'matte', 1, 2)
  box(out, -0.045, 0.7, -0.012, 0.045, 0.724, 0.012, wood, 'matte', 2, 3)
  return out
}
// a zinc bucket of mortar: the inside over the rim, the mortar, the wall, the rolled rim (the handle is a wire, drawn as a line)
function bucketMesh() {
  const out: Face[] = [], zn = [0.62, 0.64, 0.66], rb = 0.075, rt = 0.098, h = 0.165, N = 20
  lathe(out, [[rb - 0.003, 0.012], [rt - 0.006, h]], N, () => [0.36, 0.37, 0.38], 'metal', 0, 0) // profile upwards: normals face in
  lathe(out, [[0, 0.115], [rb + (rt - rb) * (0.115 / h) - 0.005, 0.115]], N, () => [0.58, 0.56, 0.53], 'matte', 1, 1)
  lathe(out, [[rt, h], [rb, 0]], N, () => zn, 'metal', 2, 2)
  lathe(out, [[rt - 0.006, h], [rt - 0.002, h + 0.005], [rt + 0.004, h + 0.002], [rt + 0.004, h - 0.006]], N, () => zn, 'metal', 3, 3)
  return out
}
const bucketHandle = (a: number) => [-0.098 * Math.cos(a), 0.17 + 0.09 * Math.sin(a), 0]
type FloorKind = 'stack' | 'brick' | 'half' | 'cone' | 'bucket' | 'spade'
const MESH: Record<FloorKind | 'hat' | 'plumb', () => Face[]> = {
  hat: hatMesh,
  stack: stackMesh,
  brick: () => brick([], 0, 0, 0, 0, 7, 0),
  half: () => brick([], 0, 0, 0, 0, 9, 0, true),
  cone: coneMesh,
  bucket: bucketMesh,
  spade: spadeMesh,
  plumb: plumbMesh,
}
const meshes = new Map<string, Face[]>()
const mesh = (kind: keyof typeof MESH | 'level', len = 0) => {
  const key = kind + len
  let m = meshes.get(key)
  if (!m) meshes.set(key, (m = kind === 'level' ? levelMesh(len) : MESH[kind]()))
  return m
}
// contact shadows of the floor kit: across, deep, strength
const KIT_SHADOW: Record<FloorKind, [number, number, number]> = { stack: [0.56, 0.7, 0.75], brick: [0.48, 0.3, 0.7], half: [0.3, 0.28, 0.65], cone: [0.44, 0.44, 0.7], bucket: [0.32, 0.32, 0.75], spade: [0.24, 0.14, 0.5] }

/* Places, in letter heights: u along the text from a letter's middle, v up from the floor, w out of the
   face (wd in block depths, wc in letter heights). What sits on or hangs from a letter goes with its
   block; what stands on the floor has its own place along the run. */
interface OnLetter { kind: 'hat' | 'level' | 'plumb'; u: number; v: number; wd: number; wc: number; yaw: number; len: number }
interface OnFloor { kind: FloorKind; at: number; wd: number; wc: number; yaw: number; roll: number }
interface Glyph { at: number; sp: Sprite; sps: Partial<Record<Mat, Sprite>>; idx: number; sc: number; base: number; pad: number; rOff: number; block: boolean; top: OnLetter[]; mid: OnLetter[]; oc: HTMLCanvasElement[] }

function placeKit(at: number[], byCi: Record<number, Glyph>, floor: OnFloor[]) {
  const cap = met!.cap, gm = (ci: number) => glyphMask(WORD[ci])
  const U = (ci: number, x: number) => (x - PAD - gm(ci).adv / 2) / cap, V = (y: number) => (PAD + met!.base - y) / cap
  const onFloor = (kind: FloorKind, at: number, wd: number, wc: number, yaw: number, roll = 0) => floor.push({ kind, at, wd, wc, yaw, roll })
  // the hat on top of the Т of СТРОЙ, turned a little as if just put down
  const t1 = inkTop(gm(1))
  byCi[1].top.push({ kind: 'hat', u: U(1, (t1.xa + t1.xb) / 2), v: V(t1.y), wd: -0.5, wc: 0, yaw: 0.3, len: 0 })
  // masonry by the С: a pile of bricks, a bucket of mortar; a brick and a half left lying in front
  const c0 = U(0, inkEdge(gm(0), false))
  onFloor('stack', at[0] + (c0 - 0.42) * cap, -0.5, 0, 0.15)
  onFloor('bucket', at[0] + (c0 + 0.02) * cap, 0, 0.32, -0.9)
  onFloor('brick', at[1] + 0.2 * cap, 0, 0.25, -0.5)
  onFloor('half', at[2] + 0.1 * cap, 0, 0.3, 0.4)
  // the cone in the gap between the words, a step forward
  onFloor('cone', at[5], 0, 0.14, 0.35)
  // the plumb bob hangs from the underside of the right arm of the Т of КОНТРОЛЬ
  const T9 = gm(9), t9 = inkTop(T9), stem = inkRuns(T9, Math.round(t9.y + cap * 0.4))
  const sb = stem.length ? stem[stem.length - 1][1] : (t9.xa + t9.xb) / 2, xh = Math.round(sb + (t9.xb - sb) * 0.55)
  let yh = 0
  while (yh < T9.h && !solid(T9, xh, yh)) yh++
  while (yh < T9.h && solid(T9, xh, yh)) yh++
  byCi[9].mid.push({ kind: 'plumb', u: U(9, xh), v: V(yh), wd: -0.3, wc: 0, yaw: 0, len: 0 })
  // the level along the top of the Л
  const t12 = inkTop(gm(12))
  byCi[12].top.push({ kind: 'level', u: U(12, (t12.xa + t12.xb) / 2), v: V(t12.y), wd: -0.45, wc: 0, yaw: -0.07, len: +Math.max(0.5, Math.min(0.85, ((t12.xb - t12.xa) / cap) * 1.1)).toFixed(2) })
  // the spade leaning on the end of the name, its handle on the side of the Ь
  onFloor('spade', at[13] + (U(13, inkEdge(gm(13), true)) + 0.3) * cap, -0.35, 0, 0.35, 0.42)
}

const LIGHT = norm([0.15, 0.45, -0.88])
const LETTERS = [...new Set(WORD.replace(' ', ''))]

/** The ring on its canvas. `start` waits for the fonts, prepares the letters a few at a time, calls
 * `onReady` and draws every frame until `stop`. */
export class LetterRing {
  private ctx: CanvasRenderingContext2D
  private refl = mk(1, 1)
  private xc = this.refl.getContext('2d')!
  private raf = 0
  private t0 = 0
  private live = false
  private glyphs: Glyph[] = []
  private floor: OnFloor[] = []
  private shape = { ...SHAPE, s: 0, total: 0 }
  private laidOut = ''
  private media = matchMedia(RING_MEDIA)
  private reduce = reducedMotion()
  private aim = { x: 0, y: 0 }

  constructor(private canvas: HTMLCanvasElement, private onReady?: () => void) {
    this.ctx = canvas.getContext('2d')!
  }

  /** The pointer's pull on the camera, as the wireframe smooths it. */
  look(x: number, y: number) {
    this.aim.x = x
    this.aim.y = y
  }

  start() {
    this.live = true
    Promise.all([document.fonts.load(`700 ${FONT_PX}px Stolzl`), document.fonts.load(`500 ${TAG_PX}px "Vela Sans"`)])
      .catch(() => undefined)
      .then(() => {
        if (!this.live) return
        met ||= measure(`700 ${FONT_PX}px Stolzl`)
        tagMet ||= measure(`500 ${TAG_PX}px "Vela Sans"`)
        // a letter in a material takes a few milliseconds; spread them so the page keeps moving
        const jobs = (this.reduce ? MAT_SEQ.slice(0, 1) : MAT_SEQ).flatMap((mt) => LETTERS.map((ch) => () => letterSprite(ch, mt)))
        const work = () => {
          if (!this.live) return
          const t = performance.now()
          while (jobs.length && performance.now() - t < 8) jobs.shift()!()
          if (jobs.length) return void setTimeout(work, 0)
          this.t0 = performance.now()
          this.onReady?.()
          this.raf = requestAnimationFrame(this.frame)
        }
        work()
      })
  }

  stop() {
    this.live = false
    cancelAnimationFrame(this.raf)
  }

  // the run of letters, the tagline and the kit for this screen
  private layout(w: number, h: number) {
    const unit = Math.min(w * 0.36, h * 0.45)
    const fit = Math.min(2.4, Math.max(1.4, (w * 0.52) / (unit * 0.9)))
    const R = Math.min(SHAPE.R, fit + 0.1), k = R / SHAPE.R
    const sh = (this.shape = { ...SHAPE, R, size: SHAPE.size * k, depth: SHAPE.depth * k, s: 0, total: 0 })
    const s = (sh.s = sh.size / met!.cap)
    const sTag = Math.max(0.026, sh.size * 0.13) / tagMet!.cap
    const adv = (ch: string) => met!.c.measureText(ch).width * (ch === ' ' ? 1.5 : 1)
    const wordLen = [...WORD].reduce((a, ch) => a + adv(ch), 0)
    const mats = this.reduce ? MAT_SEQ.slice(0, 1) : MAT_SEQ
    this.glyphs = []
    this.floor = []
    let cum = 0, bi = 0
    const at: number[] = [], byCi: Record<number, Glyph> = {}
    for (const ch of WORD) {
      const a = adv(ch)
      if (ch !== ' ') {
        const sps: Partial<Record<Mat, Sprite>> = {}
        for (const mt of mats) sps[mt] = letterSprite(ch, mt)
        this.glyphs.push((byCi[at.length] = { at: cum + a / 2, sp: sps[mats[0]]!, sps, idx: bi++, sc: s, base: met!.base, pad: PAD, rOff: 0, block: true, top: [], mid: [], oc: [] }))
      }
      at.push(cum + a / 2)
      cum += a
    }
    placeKit(at, byCi, this.floor)
    // the tagline, a low plate on the ground in front of the blocks, spread to the length of the name
    const tAdv = [...TAG].map((ch) => tagMet!.c.measureText(ch).width * (ch === ' ' ? 1.6 : 1))
    const spread = wordLen / (tAdv.reduce((x, y) => x + y, 0) * (sTag / s))
    let tc = 0
    ;[...TAG].forEach((ch, j) => {
      const pos = (tc + tAdv[j] / 2) * (sTag / s) * spread
      tc += tAdv[j]
      if (ch !== ' ') {
        const sp = tagSprite(ch)
        this.glyphs.push({ at: pos, sp, sps: {}, idx: 0, sc: sTag, base: tagMet!.base, pad: 2, rOff: -(0.12 + sh.size * 0.25), block: false, top: [], mid: [], oc: [] })
      }
    })
    sh.total = wordLen
    if (!shadow) {
      shadow = mk(128, 128)
      const x = shadow.getContext('2d')!, g = x.createRadialGradient(64, 64, 0, 64, 64, 64)
      g.addColorStop(0, 'rgba(0,0,0,.7)')
      g.addColorStop(0.55, 'rgba(0,0,0,.32)')
      g.addColorStop(1, 'rgba(0,0,0,0)')
      x.fillStyle = g
      x.fillRect(0, 0, 128, 128)
    }
  }

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame)
    const { canvas, ctx: rc, refl, xc, reduce } = this
    const w = canvas.clientWidth, h = canvas.clientHeight, dpr = Math.min(2, devicePixelRatio || 1)
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }
    rc.setTransform(1, 0, 0, 1, 0, 0)
    rc.clearRect(0, 0, canvas.width, canvas.height)
    if (!this.media.matches || !w || !h) return
    if (this.laidOut !== `${w}x${h}`) {
      this.layout(w, h)
      this.laidOut = `${w}x${h}`
    }
    rc.imageSmoothingQuality = 'high'
    const unit = Math.min(w * 0.36, h * 0.45), D = 5, f = unit * D, cx = w * 0.62, cy = h * 0.47
    const yaw = this.aim.x * PARALLAX.yaw, pitch = 0.3 + this.aim.y * PARALLAX.pitch
    const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), spt = Math.sin(pitch)
    const cam = (p: V) => {
      const xr = p[0] * cyw - p[2] * syw, zr = p[0] * syw + p[2] * cyw
      return [xr, p[1] * cp + zr * spt, -p[1] * spt + zr * cp]
    }
    const proj = (p: V) => {
      const q = cam(p), m = f / (D + q[2])
      return [cx + q[0] * m, cy - q[1] * m, q[2]]
    }
    // a sprite whose top-left corner sits at world point O, its rows along U and its columns down along V (world per sprite px)
    const affine = (sw: number, shh: number, O: V, U: V, Vv: V, k = dpr): [number, number, number, number, number, number] => {
      const p0 = proj(O), p1 = proj([O[0] + U[0] * sw, O[1] + U[1] * sw, O[2] + U[2] * sw]), p2 = proj([O[0] + Vv[0] * shh, O[1] + Vv[1] * shh, O[2] + Vv[2] * shh])
      return [(k * (p1[0] - p0[0])) / sw, (k * (p1[1] - p0[1])) / sw, (k * (p2[0] - p0[0])) / shh, (k * (p2[1] - p0[1])) / shh, k * p0[0], k * p0[1]]
    }
    const put = (img: HTMLCanvasElement, O: V, U: V, Vv: V, alpha = 1, c = rc, k = dpr) => {
      c.setTransform(...affine(img.width, img.height, O, U, Vv, k))
      c.globalAlpha = alpha
      c.drawImage(img, 0, 0)
    }
    const t = (now - this.t0) / 1000
    const { R, s, depth, size } = this.shape
    const onRing = (phi: number, r = R) => [r * Math.sin(phi), SHAPE.y, r * Math.cos(phi)]
    // the band on the ground the blocks stand on: a line under the faces and one behind the back walls
    rc.setTransform(dpr, 0, 0, dpr, 0, 0)
    rc.globalAlpha = 1
    rc.lineWidth = 1
    rc.setLineDash([3, 6])
    for (const [r, a] of [[R - 0.03, 0.16], [R + depth + 0.03, 0.09]]) {
      rc.strokeStyle = `rgba(242,239,233,${a})`
      rc.beginPath()
      for (let k = 0; k <= 160; k++) {
        const q = proj(onRing((k / 160) * 2 * Math.PI, r))
        if (k) rc.lineTo(q[0], q[1])
        else rc.moveTo(q[0], q[1])
      }
      rc.stroke()
    }
    rc.setLineDash([])
    const start = (SHAPE.center * Math.PI) / 180 - (this.shape.total * s) / R / 2
    // a light passing along the name every 9 s carries the letters on to the next material
    const sweep = reduce ? 9 : (((t - 2) % 9) + 9) % 9
    const nL = Math.max(10, Math.min(64, Math.round(depth / 0.004)))
    const cyc = Math.floor((t - 2) / 9), mod = (x: number) => ((x % 3) + 3) % 3
    const fromMat = reduce ? MAT_SEQ[0] : MAT_SEQ[mod(cyc)], toMat = reduce ? MAT_SEQ[0] : MAT_SEQ[mod(cyc + 1)]

    // the frame of a place on the run: the point on the ring, the text's direction, the face's normal.
    // Blocks stand upright and level, and the face looks at the axis, so at the camera on the far side
    interface Frame { P: V; tan: V; nIn: V }
    const frameAt = (pos: number, rOff = 0): Frame => {
      const phi = start + (pos * s) / R
      const sn = Math.sin(phi), cs = Math.cos(phi)
      return { P: onRing(phi, R + rOff), tan: [cs, 0, -sn], nIn: [-sn, 0, -cs] }
    }
    // fading out as a face turns away from the camera
    const facing = (pt: V, nIn: V) => {
      const Oc = cam(pt)
      return Math.max(0, Math.min(1, (dot(cam(nIn), norm([-Oc[0], -Oc[1], -D - Oc[2]])) - 0.12) * 5))
    }
    interface Item { g?: Glyph; fp?: OnFloor; fr: Frame; origin: V; vis: number; pass: number; w: number; M: V[]; z: number }
    const list: Item[] = []
    for (const g of this.glyphs) {
      const fr = frameAt(g.at, g.rOff), { P, tan, nIn } = fr
      const x = (g.pad + g.sp.adv / 2) * g.sc
      const origin = [P[0] - tan[0] * x, P[1] + (g.pad + g.base) * g.sc, P[2] - tan[2] * x]
      const vis = facing(origin, nIn)
      if (vis === 0) continue
      // where the passing light is on this letter: -0.3 before it, 1.3 past it
      const pass = g.block ? (sweep - g.idx * 0.13) / 0.55 : 0
      list.push({ g, fr, origin, vis, pass, w: 0, M: [], z: cam(P)[2] })
    }
    for (const fp of this.floor) {
      const fr = frameAt(fp.at), vis = facing(fr.P, fr.nIn)
      if (vis === 0) continue
      const wv = fp.wd * depth + fp.wc * size
      list.push({ fp, fr, origin: fr.P, vis, pass: 0, w: wv, M: rotM(fp.yaw, fp.roll), z: cam([fr.P[0] + fr.nIn[0] * wv, fr.P[1], fr.P[2] + fr.nIn[2] * wv])[2] })
    }
    list.sort((a, b) => b.z - a.z) // farther first

    const mirror = (O: V, yg: number) => [O[0], 2 * yg - O[1], O[2]]
    // walls from the back to the front; with `yg` the same walls mirrored in the floor at that height
    const walls = (sp: Sprite, origin: V, nIn: V, U: V, Vv: V, alpha: number, step: number, yg?: number, c = rc, k = dpr) => {
      for (let j = nL; j >= 1; j -= step) {
        const dz = (j / nL) * depth
        const lv = Math.min(LEVELS - 1, Math.round((j / nL) * (LEVELS - 1)))
        const O = [origin[0] - nIn[0] * dz, origin[1] - nIn[1] * dz, origin[2] - nIn[2] * dz]
        put(sp.walls[lv], yg === undefined ? O : mirror(O, yg), U, Vv, alpha, c, k)
      }
    }
    // the face composed off-screen: less light where it turns from the lamp, the soft reflection
    // sliding across as the face turns to the camera, the glint of the passing light
    const compose = (g: Glyph, slot: number, sp: Sprite, M: Material, light: number, Nc: V, pass: number, keepAfter?: number) => {
      const oc = g.oc[slot] || (g.oc[slot] = mk(sp.w, sp.h))
      const ox = oc.getContext('2d')!
      ox.globalCompositeOperation = 'source-over'
      ox.clearRect(0, 0, sp.w, sp.h)
      ox.drawImage(sp.face, 0, 0)
      ox.globalCompositeOperation = 'source-atop'
      ox.fillStyle = `rgba(0,0,0,${(0.4 * (1 - light)).toFixed(3)})`
      ox.fillRect(0, 0, sp.w, sp.h)
      const col = M.sheen.map((x) => Math.round(x * 255)).join(',')
      const band = (pos: number, a: number, wd: number) => {
        if (a <= 0.005 || pos < -wd || pos > 1 + wd) return
        const gr = ox.createLinearGradient(0, 0, sp.w, sp.h * 0.4)
        gr.addColorStop(Math.max(0, Math.min(1, pos - wd)), `rgba(${col},0)`)
        gr.addColorStop(Math.max(0, Math.min(1, pos)), `rgba(${col},${a.toFixed(3)})`)
        gr.addColorStop(Math.max(0, Math.min(1, pos + wd)), `rgba(${col},0)`)
        ox.fillStyle = gr
        ox.fillRect(0, 0, sp.w, sp.h)
      }
      band(0.5 + 1.9 * Nc[0], M.sheenA, 0.35)
      if (pass > -0.4 && pass < 1.4) band(pass, M.glow, 0.3)
      if (keepAfter !== undefined) {
        // the old material fades out across the light instead of ending on a hard line
        ox.globalCompositeOperation = 'destination-in'
        const gr = ox.createLinearGradient(0, 0, sp.w, sp.h * 0.4)
        gr.addColorStop(Math.max(0, Math.min(1, keepAfter - 0.14)), 'rgba(0,0,0,0)')
        gr.addColorStop(Math.max(0, Math.min(1, keepAfter + 0.14)), 'rgba(0,0,0,1)')
        ox.fillStyle = gr
        ox.fillRect(0, 0, sp.w, sp.h)
      }
      return oc
    }
    // the half of a letter the light has already crossed (before) or not yet (after), along the glint's slant
    const clipSide = (sp: Sprite, origin: V, U: V, Vv: V, pass: number, before: boolean) => {
      rc.setTransform(...affine(sp.w, sp.h, origin, U, Vv))
      const ax = sp.w, ay = sp.h * 0.4, len = Math.hypot(ax, ay), ux = ax / len, uy = ay / len, big = 6 * Math.max(sp.w, sp.h)
      const px = ax * pass, py = ay * pass, dx = -uy * big, dy = ux * big, sx = (before ? -ux : ux) * big, sy = (before ? -uy : uy) * big
      rc.beginPath()
      rc.moveTo(px + dx, py + dy)
      rc.lineTo(px - dx, py - dy)
      rc.lineTo(px - dx + sx, py - dy + sy)
      rc.lineTo(px + dx + sx, py + dy + sy)
      rc.closePath()
      rc.clip()
    }

    // a point of a frame in the world: u along the text, h up from the floor, w out of the face
    const inFrame = (fr: Frame, u: number, hh: number, wv: number) => [fr.P[0] + fr.tan[0] * u + fr.nIn[0] * wv, fr.P[1] + hh, fr.P[2] + fr.tan[2] * u + fr.nIn[2] * wv]
    // the camera's turn as a matrix, the same as cam()
    const CM = [[cyw, 0, -syw], [syw * spt, cp, cyw * spt], [syw * cp, -spt, cyw * cp]]
    /* A piece of kit: its faces (in letter heights) turned by M and set at o of a letter's frame, lit
       like the letter, from above, a little from the left and from the front. `yg` mirrors it in the
       floor at that height, `ao` darkens it near what it stands on (a height in letter heights). The
       chain piece → frame → world → camera is one matrix A and an offset T. */
    const kit = (faces: Face[], fr: Frame, o: V, M: V[], alpha: number, { c = rc, k = dpr, yg, ao }: { c?: CanvasRenderingContext2D; k?: number; yg?: number; ao?: number } = {}) => {
      const my = yg === undefined ? 1 : -1
      const A = mul3(CM, mul3([[fr.tan[0], 0, fr.nIn[0]], [0, my, 0], [fr.tan[2], 0, fr.nIn[2]]], M))
      const O = inFrame(fr, o[0], o[1], o[2])
      if (yg !== undefined) O[1] = 2 * yg - O[1]
      const T = cam(O), Lc = cam(norm([-0.42 * fr.tan[0] + 0.38 * fr.nIn[0], 0.82, -0.42 * fr.tan[2] + 0.38 * fr.nIn[2]]))
      const [a0, a1, a2] = A, M1 = M[1], h0 = o[1] / size
      const out: { pts: number[]; z: number; grp: number; body: number; bz: number; col: string; a: number }[] = []
      const bodies = new Map<number, { z: number; n: number }>()
      for (const fc of faces) {
        const ce = fc.cl || (fc.cl = avg(fc.p)), n = fc.n
        const qx = T[0] + size * (a0[0] * ce[0] + a0[1] * ce[1] + a0[2] * ce[2]), qy = T[1] + size * (a1[0] * ce[0] + a1[1] * ce[1] + a1[2] * ce[2]), qz = T[2] + size * (a2[0] * ce[0] + a2[1] * ce[1] + a2[2] * ce[2])
        const nx = a0[0] * n[0] + a0[1] * n[1] + a0[2] * n[2], ny = a1[0] * n[0] + a1[1] * n[1] + a1[2] * n[2], nz = a2[0] * n[0] + a2[1] * n[1] + a2[2] * n[2]
        const vl = Math.hypot(qx, qy, D + qz), vx = -qx / vl, vy = -qy / vl, vz = (-D - qz) / vl
        if (nx * vx + ny * vy + nz * vz <= 0) continue
        const fin = FINISH[fc.m], hy = Math.abs(h0 + M1[0] * ce[0] + M1[1] * ce[1] + M1[2] * ce[2])
        let lum = fin.amb * (0.72 + 0.28 * my * (M1[0] * n[0] + M1[1] * n[1] + M1[2] * n[2])) + fin.dif * Math.max(0, nx * Lc[0] + ny * Lc[1] + nz * Lc[2])
        if (ao !== undefined) lum *= 0.62 + 0.38 * Math.min(1, Math.max(0, (hy - ao) / 0.09))
        let gl = 0
        if (fin.spec) {
          const hx = Lc[0] + vx, hv = Lc[1] + vy, hz = Lc[2] + vz, hl = Math.hypot(hx, hv, hz) || 1
          gl = fin.spec * Math.pow(Math.max(0, (nx * hx + ny * hv + nz * hz) / hl), fin.shin)
        }
        const fa = yg === undefined ? 1 : 0.9 - hy / 0.85
        if (fa <= 0.02) continue
        const pts: number[] = []
        for (const p of fc.p) {
          const x = T[0] + size * (a0[0] * p[0] + a0[1] * p[1] + a0[2] * p[2]), y = T[1] + size * (a1[0] * p[0] + a1[1] * p[1] + a1[2] * p[2]), z = T[2] + size * (a2[0] * p[0] + a2[1] * p[1] + a2[2] * p[2])
          const m = f / (D + z)
          pts.push(cx + x * m, cy - y * m)
        }
        const ch = (x: number) => Math.round(255 * Math.min(1, x * lum + gl))
        out.push({ pts, z: qz, grp: fc.grp, body: fc.body, bz: 0, col: `rgb(${ch(fc.c[0])},${ch(fc.c[1])},${ch(fc.c[2])})`, a: Math.min(1, fa) })
        const b = bodies.get(fc.body) || { z: 0, n: 0 }
        b.z += qz
        b.n++
        bodies.set(fc.body, b)
      }
      // what rests on something comes after it, then parts and faces from the back; in the mirror the other way up
      for (const fc of out) {
        const b = bodies.get(fc.body)!
        fc.bz = b.z / b.n
      }
      out.sort((p, q) => my * (p.grp - q.grp) || q.bz - p.bz || q.z - p.z)
      c.setTransform(k, 0, 0, k, 0, 0)
      c.lineJoin = 'round'
      c.lineWidth = 0.7
      const seams = yg === undefined && alpha > 0.98
      for (const fc of out) {
        const p = fc.pts
        c.globalAlpha = alpha * fc.a
        c.beginPath()
        c.moveTo(p[0], p[1])
        for (let i = 2; i < p.length; i += 2) c.lineTo(p[i], p[i + 1])
        c.closePath()
        c.fillStyle = fc.col
        c.fill()
        // the face's own colour round it closes the hairlines antialiasing leaves between faces
        if (seams) {
          c.strokeStyle = fc.col
          c.stroke()
        }
      }
    }
    // a soft shadow on a level surface at o, du across and dw deep along the turned piece
    const kitShadow = (fr: Frame, o: V, yw: number, du: number, dw: number, alpha: number) => {
      const c = Math.cos(yw), sn = Math.sin(yw)
      const X = [fr.tan[0] * c - fr.nIn[0] * sn, 0, fr.tan[2] * c - fr.nIn[2] * sn], Z = [fr.tan[0] * sn + fr.nIn[0] * c, 0, fr.tan[2] * sn + fr.nIn[2] * c]
      const C = inFrame(fr, o[0], o[1], o[2])
      put(shadow!, [C[0] - (X[0] * du + Z[0] * dw) / 2, C[1], C[2] - (X[2] * du + Z[2] * dw) / 2], X.map((x) => (x * du) / 128), Z.map((x) => (x * dw) / 128), alpha)
    }
    // a thin line through points of a frame: a thread, a wire
    const wire = (fr: Frame, pts: V[], col: string, width: number, alpha: number) => {
      rc.setTransform(dpr, 0, 0, dpr, 0, 0)
      rc.globalAlpha = alpha
      rc.strokeStyle = col
      rc.lineWidth = width
      rc.lineCap = 'round'
      rc.beginPath()
      pts.forEach((p, i) => {
        const q = proj(inFrame(fr, p[0], p[1], p[2]))
        if (i) rc.lineTo(q[0], q[1])
        else rc.moveTo(q[0], q[1])
      })
      rc.stroke()
    }
    // a piece on the floor; the bucket's handle stands up over its rim
    const floorKit = ({ fp, fr, vis, w: wv, M }: Item) => {
      kit(mesh(fp!.kind), fr, [0, 0, wv], M, vis, { ao: 0 })
      if (fp!.kind === 'bucket')
        wire(fr, Array.from({ length: 17 }, (_, i) => app3(M, bucketHandle((i / 16) * Math.PI)).map((x, k) => x * size + (k === 2 ? wv : 0))), 'rgb(158,160,164)', 1.1, vis)
    }
    // the kit of one letter: `mid` between its walls and its face (the face hides where a thread is
    // tied under an arm), `top` over it all
    const onLetter = ({ fr, vis }: Item, pr: OnLetter) => {
      const o = [pr.u * size, pr.v * size, pr.wd * depth + pr.wc * size]
      if (pr.kind === 'hat') {
        kitShadow(fr, o, pr.yaw, 0.46 * size, 0.4 * size, vis * 0.5)
        // it rests on the tip of its peak and the gutter at the back
        kit(mesh('hat'), fr, [o[0], o[1] + 0.04 * size, o[2]], rotM(pr.yaw), vis, { ao: pr.v })
      } else if (pr.kind === 'level') {
        kitShadow(fr, o, pr.yaw, (pr.len + 0.1) * size, 0.13 * size, vis * 0.45)
        kit(mesh('level', pr.len), fr, o, rotM(pr.yaw), vis, { ao: pr.v })
      } else {
        // swinging slowly along the letter and a little in and out of it
        const ph = (t * 2 * Math.PI) / 3.4, M = rotM(0, reduce ? 0 : 0.1 * Math.sin(ph), reduce ? 0 : 0.035 * Math.sin(ph + 1.2))
        const d = app3(M, [0, -0.36 * size, 0]), bob = [o[0] + d[0], o[1] + d[1], o[2] + d[2]]
        wire(fr, [o, bob], 'rgb(212,206,194)', 0.8, vis * 0.85)
        kit(mesh('plumb'), fr, bob, M, vis)
      }
    }

    // 1. the floor mirror: whole blocks, walls and face, upside down under their bases, fading with
    //    depth; drawn at a third of the size and blown up, so the matte floor gives a soft reflection
    const RS = 3, kk = dpr / RS
    const rw = Math.max(1, Math.round(canvas.width / RS)), rh = Math.max(1, Math.round(canvas.height / RS))
    if (refl.width !== rw || refl.height !== rh) {
      refl.width = rw
      refl.height = rh
    }
    xc.setTransform(1, 0, 0, 1, 0, 0)
    xc.globalCompositeOperation = 'source-over'
    xc.clearRect(0, 0, rw, rh)
    for (const it of list) {
      if (it.fp) {
        kit(mesh(it.fp.kind), it.fr, [0, 0, it.w], it.M, it.vis * 0.22, { c: xc, k: kk, yg: it.fr.P[1] })
        continue
      }
      const g = it.g!
      if (!g.block) continue
      const { fr, origin, vis, pass } = it, yg = fr.P[1]
      const U = fr.tan.map((x) => x * g.sc), Vm = [0, g.sc, 0]
      const fw = fromMat === toMat ? 1 : Math.max(0, Math.min(1, pass))
      for (const [mat, a] of [[fromMat, 1 - fw], [toMat, fw]] as [Mat, number][]) {
        const sp = g.sps[mat]
        if (a < 0.01 || !sp) continue
        walls(sp, origin, fr.nIn, U, Vm, vis * a * MATS[mat].refl, 2, yg, xc, kk)
        put(sp.face, mirror(origin, yg), U, Vm, vis * a * MATS[mat].refl, xc, kk)
      }
      const sp = g.sp, yb = g.pad + g.base
      xc.save()
      xc.setTransform(...affine(sp.w, sp.h, mirror(origin, yg), U, Vm, kk))
      xc.globalCompositeOperation = 'destination-out'
      xc.globalAlpha = 1
      const gr = xc.createLinearGradient(0, yb, 0, yb - met!.cap * 0.85)
      gr.addColorStop(0, 'rgba(0,0,0,0.1)')
      gr.addColorStop(1, 'rgba(0,0,0,1)')
      xc.fillStyle = gr
      xc.fillRect(-sp.w * 0.5, yb - sp.h * 3, sp.w * 2, sp.h * 3)
      xc.restore()
    }
    rc.setTransform(1, 0, 0, 1, 0, 0)
    rc.globalAlpha = 1
    rc.imageSmoothingEnabled = true
    rc.drawImage(refl, 0, 0, canvas.width, canvas.height)

    // 2. shadows and blocks; a letter the light is crossing shows the new material behind the glint.
    //    The floor kit's shadows go down first, so no block standing behind a piece is darkened by them
    for (const it of list) {
      if (!it.fp) continue
      const [du, dw, a] = KIT_SHADOW[it.fp.kind]
      kitShadow(it.fr, [0, 0, it.w], it.fp.yaw, du * size, dw * size, it.vis * a)
    }
    for (const it of list) {
      if (it.fp) {
        floorKit(it)
        continue
      }
      const g = it.g!, { fr, origin, vis, pass } = it, { P, tan, nIn } = fr
      const U = tan.map((x) => x * g.sc), Vv = [0, -g.sc, 0]
      if (!g.block) {
        put(g.sp.face, origin, U, Vv, vis)
        continue
      }
      const wW = g.sp.adv * g.sc * 1.4, front = 0.05, back = depth + 0.15 * size
      const o = [0, 1, 2].map((k) => P[k] - tan[k] * wW * 0.5 + nIn[k] * front)
      put(shadow!, o, tan.map((x) => (x * wW) / 128), nIn.map((x) => (-x * (front + back)) / 128), vis * 0.85)
      const Nc = cam(nIn), light = Math.max(0, dot(nIn, LIGHT))
      const W = 0.3
      const one = fromMat === toMat || pass >= 1 + W ? toMat : pass <= -W ? fromMat : null
      const a = g.sps[fromMat]!, b = g.sps[toMat]!
      if (one) walls(g.sps[one]!, origin, nIn, U, Vv, vis, 1)
      else {
        rc.save()
        clipSide(g.sp, origin, U, Vv, pass, false)
        walls(a, origin, nIn, U, Vv, vis, 1)
        rc.restore()
        rc.save()
        clipSide(g.sp, origin, U, Vv, pass, true)
        walls(b, origin, nIn, U, Vv, vis, 1)
        rc.restore()
      }
      for (const pr of g.mid) onLetter(it, pr)
      if (one) put(compose(g, 0, g.sps[one]!, MATS[one], light, Nc, pass), origin, U, Vv, vis)
      else {
        put(compose(g, 1, b, MATS[toMat], light, Nc, pass), origin, U, Vv, vis)
        put(compose(g, 0, a, MATS[fromMat], light, Nc, pass, pass), origin, U, Vv, vis)
      }
      for (const pr of g.top) onLetter(it, pr)
    }
    rc.globalAlpha = 1
    rc.globalCompositeOperation = 'source-over'
  }
}
