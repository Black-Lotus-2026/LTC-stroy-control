/*
 * Dashed wireframes for the intro screen. Every subject is a set of 3D polylines (metres, y up,
 * facing +x). They are resampled into short dashes at one spacing, and every subject gets the
 * same number of slots, so any one can fly apart and reassemble into the next. Drawn on a 2D
 * canvas: a few thousand dashes bucketed by colour and depth, a few dozen strokes a frame.
 */

import { reducedMotion } from './spring'

type V2 = [number, number]
type V3 = [number, number, number]
interface Poly { pts: V3[]; closed: boolean }

const line = (...pts: V3[]): Poly => ({ pts, closed: false })
const loop = (...pts: V3[]): Poly => ({ pts, closed: true })

/** A side profile (x, y) extruded across z0..z1: both outlines and the edges between them. */
function prism(profile: V2[], z0: number, z1: number): Poly[] {
  const a = profile.map(([x, y]): V3 => [x, y, z0])
  const b = profile.map(([x, y]): V3 => [x, y, z1])
  return [loop(...a), loop(...b), ...a.map((p, i) => line(p, b[i]))]
}

const box = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
  prism([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], z0, z1)

/** Circle or arc. 'xy' is a side view (wheels), 'xz' lies on the ground (slabs, rings). */
function arc(c: V3, r: number, plane: 'xy' | 'xz', n = 24, a0 = 0, a1 = Math.PI * 2): Poly {
  const full = Math.abs(a1 - a0) >= Math.PI * 2 - 1e-6
  const pts: V3[] = []
  for (let i = 0; i < (full ? n : n + 1); i++) {
    const a = a0 + ((a1 - a0) * i) / n
    const u = Math.cos(a) * r
    const v = Math.sin(a) * r
    pts.push(plane === 'xy' ? [c[0] + u, c[1] + v, c[2]] : [c[0] + u, c[1], c[2] + v])
  }
  return { pts, closed: full }
}

/** A side-view centre line given a thickness: the outline of a boom or a stick. */
function thick(path: V2[], w: number[]): V2[] {
  const left: V2[] = []
  const right: V2[] = []
  path.forEach((p, i) => {
    const a = path[Math.max(0, i - 1)]
    const b = path[Math.min(path.length - 1, i + 1)]
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const nx = -(b[1] - a[1]) / l
    const ny = (b[0] - a[0]) / l
    left.push([p[0] + nx * w[i] / 2, p[1] + ny * w[i] / 2])
    right.push([p[0] - nx * w[i] / 2, p[1] - ny * w[i] / 2])
  })
  return [...left, ...right.reverse()]
}

/** Crawler track side profile: a loop around two wheels, with points along the runs for the shoes. */
function track(x0: number, x1: number, r: number, step = 0.42): V2[] {
  const xa = x0 + r
  const xb = x1 - r
  const n = Math.max(1, Math.round((xb - xa) / step))
  const pts: V2[] = []
  for (let i = 0; i < n; i++) pts.push([xa + ((xb - xa) * i) / n, 0])
  for (let i = 0; i < 8; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / 8
    pts.push([xb + Math.cos(a) * r, r + Math.sin(a) * r])
  }
  for (let i = 0; i < n; i++) pts.push([xb - ((xb - xa) * i) / n, 2 * r])
  for (let i = 0; i < 8; i++) {
    const a = Math.PI / 2 + (Math.PI * i) / 8
    pts.push([xa + Math.cos(a) * r, r + Math.sin(a) * r])
  }
  return pts
}

/** Square lattice mast of a tower crane: four chords, a brace zigzag on every face. */
function mast(cx: number, cz: number, s: number, y0: number, y1: number, step: number): Poly[] {
  const h = s / 2
  const c: V2[] = [[cx - h, cz - h], [cx + h, cz - h], [cx + h, cz + h], [cx - h, cz + h]]
  const out = c.map(([x, z]) => line([x, y0, z], [x, y1, z]))
  const n = Math.max(1, Math.round((y1 - y0) / step))
  for (let f = 0; f < 4; f++) {
    const [ax, az] = c[f]
    const [bx, bz] = c[(f + 1) % 4]
    const zig: V3[] = []
    for (let i = 0; i <= n; i++) {
      const y = y0 + ((y1 - y0) * i) / n
      zig.push(i % 2 ? [bx, y, bz] : [ax, y, az])
    }
    out.push(line(...zig))
  }
  return out
}

/** Triangular lattice jib along x at height y: two bottom chords, a top chord sloping to the tip, braces. */
function jib(x0: number, x1: number, y: number, w: number, h: number, step: number): Poly[] {
  const top = (t: number) => y + h * (1 - 0.6 * t)
  const n = Math.max(1, Math.round(Math.abs(x1 - x0) / step))
  const out = [line([x0, y, -w], [x1, y, -w]), line([x0, y, w], [x1, y, w]), line([x0, top(0), 0], [x1, top(1), 0])]
  for (const side of [-w, w]) {
    const zig: V3[] = []
    for (let i = 0; i <= n; i++) {
      const t = i / n
      const x = x0 + (x1 - x0) * t
      zig.push(i % 2 ? [x, top(t), 0] : [x, y, side])
    }
    out.push(line(...zig))
  }
  return out
}

/** Two chords from a to b, side by side across z, braced with a zigzag: a luffing jib. */
function truss(a: V3, b: V3, w: number, step: number): Poly[] {
  const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / step))
  const at = (t: number, z: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t + z]
  const zig: V3[] = []
  for (let i = 0; i <= n; i++) zig.push(at(i / n, i % 2 ? w : -w))
  return [line(at(0, -w), at(1, -w)), line(at(0, w), at(1, w)), line(...zig)]
}

/* ── Subjects ───────────────────────────────────────────── */

function excavator(): Poly[] {
  const out: Poly[] = []
  const r = 0.475
  for (const s of [-1, 1]) {
    out.push(...prism(track(-2.2, 2.2, r), s * 0.95, s * 1.6))
    for (const x of [-1.15, -0.4, 0.4, 1.15]) out.push(arc([x, 0.3, s * 1.6], 0.2, 'xy', 10))
    out.push(arc([-1.725, r, s * 1.6], 0.32, 'xy', 14), arc([1.725, r, s * 1.6], 0.32, 'xy', 14))
  }
  out.push(...box(-1.3, 0.45, -0.95, 1.3, 0.95, 0.95))
  out.push(arc([0, 1.08, 0], 0.95, 'xz', 24))
  // house: engine and counterweight, the deck under the boom, the cab on the left
  out.push(...prism([[-2.7, 1.15], [0.3, 1.15], [0.3, 2.3], [-2.45, 2.3], [-2.7, 2.0]], -1.3, 1.3))
  out.push(line([-2.7, 1.6, -1.3], [-2.7, 1.6, 1.3]))
  for (const x of [-2.0, -1.6, -1.2]) out.push(line([x, 2.3, -1.1], [x, 2.3, -0.15]))
  out.push(...box(0.3, 1.15, -1.3, 1.35, 1.7, 0.3))
  out.push(...prism([[0.3, 1.15], [1.35, 1.15], [1.4, 2.35], [1.1, 3.35], [0.3, 3.35]], 0.45, 1.3))
  out.push(loop([0.45, 2.2, 1.3], [1.25, 2.2, 1.3], [1.05, 3.15, 1.3], [0.45, 3.15, 1.3]))
  out.push(loop([1.37, 2.45, 0.6], [1.37, 2.45, 1.15], [1.14, 3.2, 1.15], [1.14, 3.2, 0.6]))
  out.push(line([-1.6, 2.3, -0.7], [-1.6, 2.9, -0.7]))
  // boom, stick, bucket and the cylinders that move them
  out.push(...prism(thick([[0.8, 1.6], [3.2, 4.45], [5.7, 3.9]], [0.6, 0.72, 0.42]), -0.3, 0.3))
  out.push(...prism(thick([[5.45, 4.6], [5.75, 3.85], [6.55, 1.45]], [0.38, 0.42, 0.3]), -0.22, 0.22))
  out.push(...prism([[6.5, 1.55], [7.05, 1.3], [7.3, 0.75], [7.15, 0.2], [6.7, -0.02], [6.25, 0.35], [6.3, 1.05]], -0.55, 0.55))
  for (const z of [-0.4, -0.13, 0.13, 0.4]) out.push(line([6.7, -0.02, z], [6.95, -0.12, z]))
  for (const s of [-1, 1]) out.push(line([1.35, 1.55, s * 0.38], [2.75, 3.55, s * 0.38]))
  out.push(line([3.0, 5.0, 0], [5.4, 4.75, 0]), line([5.95, 3.75, 0], [6.75, 1.75, 0]))
  return out
}

function dumpTruck(): Poly[] {
  const out: Poly[] = []
  const R = 0.58
  for (const x of [-2.9, -1.5, 2.5]) {
    for (const s of [-1, 1]) {
      out.push(arc([x, R, s * 1.0], R, 'xy', 20), arc([x, R, s * 1.4], R, 'xy', 20), arc([x, R, s * 1.42], 0.24, 'xy', 10))
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4
        out.push(line([x + Math.cos(a) * R, R + Math.sin(a) * R, s * 1.0], [x + Math.cos(a) * R, R + Math.sin(a) * R, s * 1.4]))
      }
    }
    out.push(line([x, R, -1.0], [x, R, 1.0]))
  }
  for (const z of [-0.55, 0.55]) out.push(line([-3.9, 1.05, z], [3.7, 1.05, z]), line([-3.9, 0.85, z], [3.7, 0.85, z]))
  for (const x of [-3.5, -2.2, -0.8, 0.6, 1.9]) out.push(line([x, 0.95, -0.55], [x, 0.95, 0.55]))
  // cab-over cab
  out.push(...prism([[2.0, 1.05], [4.05, 1.05], [4.05, 2.05], [3.85, 3.05], [2.1, 3.1]], -1.2, 1.2))
  out.push(loop([4.0, 2.2, -1.05], [4.0, 2.2, 1.05], [3.88, 2.92, 1.05], [3.88, 2.92, -1.05]))
  for (const s of [-1, 1]) {
    out.push(loop([2.4, 2.15, s * 1.2], [3.75, 2.15, s * 1.2], [3.62, 2.9, s * 1.2], [2.4, 2.9, s * 1.2]))
    out.push(arc([2.5, R, s * 1.25], 0.8, 'xy', 10, 0.1, Math.PI - 0.1))
    out.push(arc([4.07, 1.55, s * 0.95], 0.12, 'xy', 8))
  }
  for (const y of [1.35, 1.55, 1.75]) out.push(line([4.06, y, -0.7], [4.06, y, 0.7]))
  out.push(...box(4.05, 0.75, -1.25, 4.3, 1.05, 1.25))
  out.push(line([2.0, 1.1, 1.05], [2.0, 3.4, 1.05]))
  // dump body with ribs, a visor over the cab and a heap of soil
  const bottom: V3[] = [[-3.9, 1.2, -1.05], [1.85, 1.2, -1.05], [1.85, 1.2, 1.05], [-3.9, 1.2, 1.05]]
  const top: V3[] = [[-4.25, 2.75, -1.28], [1.95, 2.75, -1.28], [1.95, 2.75, 1.28], [-4.25, 2.75, 1.28]]
  out.push(loop(...bottom), loop(...top), ...bottom.map((p, i) => line(p, top[i])))
  for (const x of [-3.1, -2.1, -1.1, -0.1, 0.9]) for (const s of [-1, 1]) out.push(line([x, 1.2, s * 1.05], [x - 0.05, 2.75, s * 1.28]))
  out.push(loop([1.95, 2.75, -1.28], [1.95, 2.75, 1.28], [3.0, 3.3, 1.2], [3.0, 3.3, -1.2]), line([1.95, 2.75, 0], [3.0, 3.3, 0]))
  const heap = (x: number) => 2.75 + 0.62 * Math.sin((Math.PI * (x + 3.9)) / 5.6)
  out.push(line(...Array.from({ length: 13 }, (_, i): V3 => { const x = -3.9 + (5.6 * i) / 12; return [x, heap(x), 0] })))
  for (const x of [-3.0, -1.6, -0.2, 1.1]) out.push(line(...Array.from({ length: 9 }, (_, i): V3 => { const z = -1.2 + (2.4 * i) / 8; return [x, 2.75 + (heap(x) - 2.75) * Math.cos((Math.PI * z) / 2.6), z] })))
  return out
}

function highRise(): Poly[] {
  const out: Poly[] = []
  const X = 3
  const Z = 2.25
  const built = 10
  const rect = (y: number, x0 = -X, x1 = X) => loop([x0, y, -Z], [x1, y, -Z], [x1, y, Z], [x0, y, Z])
  // finished floors: slabs and a facade grid of columns
  for (let k = 0; k <= built; k++) out.push(rect(k))
  for (const x of [-3, -2, -1, 0, 1, 2, 3]) for (const z of [-Z, Z]) out.push(line([x, 0, z], [x, built, z]))
  for (const z of [-0.75, 0.75]) for (const x of [-X, X]) out.push(line([x, 0, z], [x, built, z]))
  // the frame going up: bare columns, one more slab, half a slab, rebar sticking out
  const cols: V2[] = [[-3, -Z], [-1, -Z], [1, -Z], [3, -Z], [-3, Z], [-1, Z], [1, Z], [3, Z], [-3, -0.75], [-3, 0.75], [3, -0.75], [3, 0.75]]
  for (const [x, z] of cols) out.push(line([x, built, z], [x, built + 1, z]))
  out.push(rect(built + 1))
  for (const [x, z] of cols) {
    if (x < 0) out.push(line([x, built + 1, z], [x, built + 2, z]), line([x, built + 2, z], [x, built + 2.45, z]))
    else out.push(line([x, built + 1, z], [x, built + 1.45, z]))
  }
  out.push(rect(built + 2, -X, 0))
  out.push(...box(-0.7, built, -0.7, 0.7, built + 3.2, 0.7))
  // tower crane beside the building
  const mx = 4.1
  const my = built + 5
  out.push(...mast(mx, 0, 0.6, 0, my, 1))
  out.push(...jib(mx, -5.5, my, 0.3, 0.7, 0.8))
  out.push(line([mx, my, -0.3], [7.6, my, -0.3]), line([mx, my, 0.3], [7.6, my, 0.3]))
  for (const x of [4.9, 5.7, 6.5]) out.push(line([x, my, -0.3], [x, my, 0.3]))
  out.push(...box(6.6, my - 0.9, -0.45, 7.5, my, 0.45))
  for (const [x, z] of [[mx - 0.3, -0.3], [mx + 0.3, -0.3], [mx + 0.3, 0.3], [mx - 0.3, 0.3]]) out.push(line([x, my, z], [mx, my + 2.4, 0]))
  out.push(line([mx, my + 2.4, 0], [-2.5, my + 0.48, 0]), line([mx, my + 2.4, 0], [7.3, my, 0]))
  out.push(...box(mx + 0.3, my - 0.9, 0.3, mx + 1.0, my - 0.1, 0.9))
  out.push(line([-1.2, my, 0], [-1.2, built + 2.9, 0]))
  out.push(...box(-1.8, built + 2.55, -0.35, -0.6, built + 2.9, 0.35))
  return out
}

function tower(): Poly[] {
  const out: Poly[] = []
  const N = 22
  const F = 0.62
  const built = 17
  const R = (k: number) => 3.0 - (1.0 * k) / N
  const at = (k: number, a: number, r = R(k) * (1 + 0.1 * Math.cos(5 * a))): V3 => {
    const t = a + k * 0.045
    return [Math.cos(t) * r, k * F, Math.sin(t) * r]
  }
  const plate = (k: number, a0 = 0, a1 = Math.PI * 2, n = 40) => Array.from({ length: n + (a1 - a0 < 6 ? 1 : 0) }, (_, i) => at(k, a0 + ((a1 - a0) * i) / n))
  // slabs of a five-lobed plan, each turned a little further, and the ribs that follow the twist
  for (let k = 0; k <= built; k++) out.push(loop(...plate(k)))
  for (let j = 0; j < 10; j++) out.push(line(...Array.from({ length: built + 1 }, (_, k) => at(k, (j * Math.PI) / 5))))
  // going up: columns at the lobes, one more slab, half a slab
  for (let j = 0; j < 10; j += 2) out.push(line(at(built, (j * Math.PI) / 5), at(built + 1, (j * Math.PI) / 5), at(built + 2, (j * Math.PI) / 5)))
  out.push(loop(...plate(built + 1)), line(...plate(built + 2, 0, Math.PI, 20)))
  // core with climbing formwork, a luffing crane on top
  const yc = (built + 4.2) * F
  for (const k of [built, built + 1, built + 2, built + 3]) out.push(arc([0, k * F, 0], 0.9, 'xz', 20))
  for (let j = 0; j < 6; j++) {
    const a = (j * Math.PI) / 3
    out.push(line([Math.cos(a) * 0.9, built * F, Math.sin(a) * 0.9], [Math.cos(a) * 0.9, (built + 3.4) * F, Math.sin(a) * 0.9]))
  }
  out.push(arc([0, (built + 3.4) * F, 0], 1.15, 'xz', 24), arc([0, yc, 0], 1.15, 'xz', 24))
  for (let j = 0; j < 8; j++) {
    const a = (j * Math.PI) / 4
    out.push(line([Math.cos(a) * 1.15, (built + 3.4) * F, Math.sin(a) * 1.15], [Math.cos(a) * 1.15, yc, Math.sin(a) * 1.15]))
  }
  out.push(...mast(0, 0, 0.45, yc, yc + 1.6, 0.55))
  out.push(...truss([0, yc + 1.6, 0], [4.0, yc + 2.7, 0], 0.22, 0.5))
  out.push(line([0, yc + 1.6, -0.22], [-1.6, yc + 1.6, -0.22]), line([0, yc + 1.6, 0.22], [-1.6, yc + 1.6, 0.22]))
  out.push(...box(-1.7, yc + 0.9, -0.35, -1.1, yc + 1.6, 0.35))
  out.push(line([0, yc + 2.6, 0], [4.0, yc + 2.7, 0]), line([4.0, yc + 2.7, 0], [4.0, (built + 2.6) * F, 0]))
  return out
}

/** The intro cycles machine → building → machine → building. Gold is the plan, white the fact. */
export const SUBJECTS = [
  { title: 'Экскаватор', gold: false, build: excavator },
  { title: 'Монолитный каркас', gold: true, build: highRise },
  { title: 'Самосвал', gold: false, build: dumpTruck },
  { title: 'Высотная башня', gold: true, build: tower },
] as const

/* ── Sampling ───────────────────────────────────────────── */

const SPACING = 0.024 // between dash centres, in fitted units (the model is about 2 wide)
const DASH = 0.52 // share of the spacing that is ink

interface Raw { p: number[]; t: number[]; n: number; ground: number; reach: number }

/** Centre on the vertical axis, fit into reach 1 and height 1.5, cut every polyline into dashes. */
function sample(polys: Poly[]): Raw {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity
  for (const { pts } of polys)
    for (const [x, y, z] of pts) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x)
      y0 = Math.min(y0, y); y1 = Math.max(y1, y)
      z0 = Math.min(z0, z); z1 = Math.max(z1, z)
    }
  const cx = (x0 + x1) / 2
  const cy = (y0 + y1) / 2
  const cz = (z0 + z1) / 2
  let reach = 0
  for (const { pts } of polys) for (const [x, , z] of pts) reach = Math.max(reach, Math.hypot(x - cx, z - cz))
  const k = Math.min(1 / reach, 1.5 / (y1 - y0))
  const p: number[] = []
  const t: number[] = []
  for (const poly of polys) {
    const pts = poly.pts.map(([x, y, z]): V3 => [(x - cx) * k, (y - cy) * k, (z - cz) * k])
    if (poly.closed) pts.push(pts[0])
    const seg: number[] = []
    let len = 0
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2])
      seg.push(l)
      len += l
    }
    if (len < 1e-6) continue
    const count = Math.max(1, Math.round(len / SPACING))
    const half = ((len / count) * DASH) / 2
    let si = 0
    let acc = 0
    for (let j = 0; j < count; j++) {
      const s = ((j + 0.5) * len) / count
      while (si < seg.length - 1 && acc + seg[si] < s) acc += seg[si++]
      const a = pts[si]
      const b = pts[si + 1]
      const u = seg[si] ? (s - acc) / seg[si] : 0
      p.push(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u)
      const l = seg[si] || 1
      t.push(((b[0] - a[0]) / l) * half, ((b[1] - a[1]) / l) * half, ((b[2] - a[2]) / l) * half)
    }
  }
  return { p, t, n: p.length / 3, ground: (y0 - cy) * k, reach: reach * k }
}

export interface Shape {
  title: string
  gold: number
  pos: Float32Array
  tan: Float32Array
  /** 1 where the slot carries its own dash; 0 where it doubles a neighbour and stays hidden. */
  vis: Float32Array
  ground: number
  reach: number
}

/**
 * Same slot count for all subjects. Dashes are ordered bottom to top (and around the axis within a
 * band), and slot i takes the dash at the same rank in every subject: the base of one becomes the
 * base of the next, so the morph reads as rebuilding rather than noise.
 */
export function buildShapes(): { shapes: Shape[]; slots: number } {
  const raws = SUBJECTS.map((s) => sample(s.build()))
  const slots = Math.max(...raws.map((r) => r.n))
  const shapes = raws.map((r, si): Shape => {
    const order = Array.from({ length: r.n }, (_, i) => i)
    const key = (i: number) => Math.floor((r.p[i * 3 + 1] + 1) * 24) + (Math.atan2(r.p[i * 3 + 2], r.p[i * 3]) + Math.PI) / (2 * Math.PI + 1e-3)
    const keys = order.map(key)
    order.sort((a, b) => keys[a] - keys[b])
    const pos = new Float32Array(slots * 3)
    const tan = new Float32Array(slots * 3)
    const vis = new Float32Array(slots)
    let prev = -1
    for (let i = 0; i < slots; i++) {
      const j = Math.floor((i * r.n) / slots)
      const src = order[j]
      for (let c = 0; c < 3; c++) {
        pos[i * 3 + c] = r.p[src * 3 + c]
        tan[i * 3 + c] = r.t[src * 3 + c]
      }
      vis[i] = j !== prev ? 1 : 0
      prev = j
    }
    return { title: SUBJECTS[si].title, gold: SUBJECTS[si].gold ? 1 : 0, pos, tan, vis, ground: r.ground, reach: r.reach }
  })
  return { shapes, slots }
}

/* ── Scene ──────────────────────────────────────────────── */

const HOLD = 6.2 // seconds a subject stays assembled
const SPREAD = 0.85 // bottom-to-top stagger of a morph
const JITTER = 0.3
const FLIGHT = 1.3 // one dash's flight
const MORPH = SPREAD + JITTER + FLIGHT
const ENTRY_SPREAD = 1.1
const ENTRY_FLIGHT = 1.05
const FADE = 0.9 // reduced motion: cross-fade instead of flight
const SPIN = 0.16 // rad/s, a turn in about 40 s
const PITCH = 0.3
const DIST = 5

const INK: V3 = [242, 239, 233]
const GOLD: V3 = [232, 189, 102]
const GL = 5 // colour steps between ink and gold
const AL = 6 // alpha steps

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)
const smooth = (dt: number, rate: number) => 1 - Math.exp(-dt * rate)

export interface SceneEvents {
  /** The subject being assembled changed (also fires for the first one). */
  onIndex?: (i: number) => void
  /** Share of the current subject's turn that has passed, every frame. */
  onTick?: (i: number, progress: number) => void
  /** Smoothed pointer offset from the centre, -1..1 on both axes. */
  onParallax?: (x: number, y: number) => void
}

export class WireScene {
  private ctx: CanvasRenderingContext2D
  private shapes: Shape[]
  private n: number
  private cp: Float32Array; private ct: Float32Array; private ca: Float32Array; private cg: Float32Array
  private sp: Float32Array; private st: Float32Array; private sa: Float32Array; private sg: Float32Array
  private jit: Float32Array
  private xy: Float32Array
  private bucket: Uint8Array
  private order: Int32Array
  private styles: string[] = []
  private idx = 0
  private phase: 'morph' | 'hold' = 'morph'
  private clock = 0
  private hold = 0
  private flights = 0
  private swirl = 0
  private entry = true
  private ring = { g: 0, r: 0, g0: 0, r0: 0 }
  private yaw = -0.55
  private aim = { x: 0, y: 0, sx: 0, sy: 0 }
  private frame = { x0: 0, y0: 0, x1: 0, y1: 0, a: 0, set: false }
  private w = 0
  private h = 0
  private dpr = 1
  private raf = 0
  private last = 0
  private dt = 1 / 60
  private ro: ResizeObserver
  private reduce = reducedMotion()

  constructor(private canvas: HTMLCanvasElement, private on: SceneEvents = {}) {
    this.ctx = canvas.getContext('2d')!
    const { shapes, slots } = buildShapes()
    this.shapes = shapes
    this.n = slots
    const f = (k: number) => new Float32Array(slots * k)
    this.cp = f(3); this.ct = f(3); this.ca = f(1); this.cg = f(1)
    this.sp = f(3); this.st = f(3); this.sa = f(1); this.sg = f(1)
    this.xy = f(4)
    this.jit = f(1)
    for (let i = 0; i < slots; i++) {
      const v = Math.sin(i * 12.9898) * 43758.5453
      this.jit[i] = v - Math.floor(v)
    }
    this.bucket = new Uint8Array(slots)
    this.order = new Int32Array(slots)
    for (let g = 0; g < GL; g++)
      for (let a = 0; a < AL; a++) {
        const m = g / (GL - 1)
        const c = INK.map((v, i) => Math.round(v + (GOLD[i] - v) * m))
        this.styles.push(`rgba(${c[0]},${c[1]},${c[2]},${((a + 1) / AL).toFixed(3)})`)
      }
    // the first subject grows out of its own footprint
    const s0 = shapes[0]
    this.cp.set(s0.pos)
    for (let i = 0; i < slots; i++) this.cp[i * 3 + 1] = s0.ground
    this.ct.set(s0.tan)
    this.cg.fill(s0.gold)
    this.ring.g = this.ring.g0 = s0.ground
    this.ring.r = this.ring.r0 = s0.reach * 1.12
    this.ro = new ResizeObserver(() => this.resize())
    this.ro.observe(canvas)
  }

  start() {
    this.resize()
    this.begin(0, true)
    if (matchMedia('(hover: hover) and (pointer: fine)').matches && !this.reduce) addEventListener('pointermove', this.point)
    this.last = performance.now()
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - this.last) / 1000)
      this.last = now
      this.dt = dt
      this.step(dt)
      this.draw()
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  stop() {
    cancelAnimationFrame(this.raf)
    removeEventListener('pointermove', this.point)
    this.ro.disconnect()
  }

  /** Reassemble into subject i now, from wherever the dashes are. */
  show(i: number) {
    if (i === this.idx && this.phase === 'morph') return
    this.begin(i, false)
  }

  private begin(i: number, entry: boolean) {
    this.sp.set(this.cp); this.st.set(this.ct); this.sa.set(this.ca); this.sg.set(this.cg)
    this.ring.g0 = this.ring.g
    this.ring.r0 = this.ring.r
    this.idx = i
    this.entry = entry
    this.phase = 'morph'
    this.clock = 0
    this.hold = 0
    this.swirl = entry ? 0 : (this.flights++ % 2 ? -1.1 : 1.1)
    this.on.onIndex?.(i)
  }

  private point = (e: PointerEvent) => {
    this.aim.x = (e.clientX / innerWidth - 0.5) * 2
    this.aim.y = (e.clientY / innerHeight - 0.5) * 2
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect()
    this.dpr = Math.min(2, devicePixelRatio || 1)
    this.w = r.width
    this.h = r.height
    this.canvas.width = Math.round(r.width * this.dpr)
    this.canvas.height = Math.round(r.height * this.dpr)
  }

  private get span() {
    if (this.reduce) return FADE
    return this.entry ? ENTRY_SPREAD + JITTER + ENTRY_FLIGHT : MORPH
  }

  private step(dt: number) {
    const sh = this.shapes[this.idx]
    const n = this.n
    if (!this.reduce) this.yaw += dt * SPIN
    const k = smooth(dt, 3)
    this.aim.sx += (this.aim.x - this.aim.sx) * k
    this.aim.sy += (this.aim.y - this.aim.sy) * k
    this.on.onParallax?.(this.aim.sx, this.aim.sy)

    if (this.phase === 'morph') {
      this.clock += dt
      const win = this.span
      const ge = easeInOut(Math.min(1, this.clock / win))
      this.ring.g = this.ring.g0 + (sh.ground - this.ring.g0) * ge
      this.ring.r = this.ring.r0 + (sh.reach * 1.12 - this.ring.r0) * ge
      if (this.reduce) {
        // cross-fade: the old drawing goes out where it stands, the new one comes in
        const e = Math.min(1, this.clock / FADE)
        const out = e < 0.5
        this.cp.set(out ? this.sp : sh.pos)
        this.ct.set(out ? this.st : sh.tan)
        for (let i = 0; i < n; i++) {
          this.ca[i] = out ? this.sa[i] * (1 - 2 * e) : sh.vis[i] * (2 * e - 1)
          this.cg[i] = out ? this.sg[i] : sh.gold
        }
      } else {
        const spread = this.entry ? ENTRY_SPREAD : SPREAD
        const flight = this.entry ? ENTRY_FLIGHT : FLIGHT
        const { sp, st, sa, sg, cp, ct, ca, cg, jit } = this
        const dp = sh.pos
        const dtn = sh.tan
        for (let i = 0; i < n; i++) {
          const p = Math.min(1, Math.max(0, (this.clock - (i / n) * spread - jit[i] * JITTER) / flight))
          const e = easeInOut(p)
          const s = Math.sin(Math.PI * e)
          const j = i * 3
          let x = sp[j] + (dp[j] - sp[j]) * e
          const y = sp[j + 1] + (dp[j + 1] - sp[j + 1]) * e + 0.06 * s * (this.swirl ? 1 : 0)
          let z = sp[j + 2] + (dp[j + 2] - sp[j + 2]) * e
          if (this.swirl) {
            const a = this.swirl * s
            const c = Math.cos(a)
            const si = Math.sin(a)
            const r = 1 + 0.2 * s
            const xr = (x * c - z * si) * r
            z = (x * si + z * c) * r
            x = xr
          }
          cp[j] = x; cp[j + 1] = y; cp[j + 2] = z
          const shrink = 1 - 0.7 * s
          ct[j] = (st[j] + (dtn[j] - st[j]) * e) * shrink
          ct[j + 1] = (st[j + 1] + (dtn[j + 1] - st[j + 1]) * e) * shrink
          ct[j + 2] = (st[j + 2] + (dtn[j + 2] - st[j + 2]) * e) * shrink
          ca[i] = sa[i] + (sh.vis[i] - sa[i]) * e
          cg[i] = sg[i] + (sh.gold - sg[i]) * e
        }
      }
      if (this.clock >= win) {
        this.phase = 'hold'
        this.cp.set(sh.pos); this.ct.set(sh.tan); this.ca.set(sh.vis); this.cg.fill(sh.gold)
      }
    } else {
      this.hold += dt
      if (this.hold >= HOLD) this.begin((this.idx + 1) % this.shapes.length, false)
    }
    const turn = this.span + HOLD
    this.on.onTick?.(this.idx, Math.min(1, (this.phase === 'morph' ? this.clock : this.span + this.hold) / turn))
  }

  private draw() {
    const { ctx, w, h, dpr, n, cp, ct, ca, cg, xy, bucket, order } = this
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (!w || !h) return
    // landscape: large and right of centre, clear of СТРОЙ; portrait: centred between the words
    const portrait = h > w * 1.2
    const unit = portrait ? Math.min(w * 0.42, h * 0.36) : Math.min(w * 0.36, h * 0.45)
    const cx = portrait ? w / 2 : w * 0.62
    const cy = h * 0.47
    const f = unit * DIST
    const yaw = this.yaw + this.aim.sx * 0.35
    const pitch = PITCH + this.aim.sy * 0.08
    const cyw = Math.cos(yaw), syw = Math.sin(yaw), cpt = Math.cos(pitch), spt = Math.sin(pitch)
    // world → screen; returns depth for fading the far side
    let sx = 0, sy = 0
    const project = (x: number, y: number, z: number) => {
      const xr = x * cyw - z * syw
      const zr = x * syw + z * cyw
      const y2 = y * cpt + zr * spt
      const z2 = -y * spt + zr * cpt
      const d = f / (DIST + z2)
      sx = cx + xr * d
      sy = cy - y2 * d
      return z2
    }

    // turntable under the subject
    ctx.lineWidth = 1
    ctx.strokeStyle = 'rgba(242,239,233,0.14)'
    ctx.beginPath()
    const { g, r } = this.ring
    for (let i = 0; i < 120; i++) {
      const a0 = (i / 120) * Math.PI * 2
      const a1 = a0 + Math.PI / 130
      project(Math.cos(a0) * r, g, Math.sin(a0) * r)
      ctx.moveTo(sx, sy)
      project(Math.cos(a1) * r, g, Math.sin(a1) * r)
      ctx.lineTo(sx, sy)
    }
    for (let i = 0; i < 36; i++) {
      const a = (i / 36) * Math.PI * 2
      const l = i % 9 === 0 ? 1.1 : 1.045
      project(Math.cos(a) * r * 1.015, g, Math.sin(a) * r * 1.015)
      ctx.moveTo(sx, sy)
      project(Math.cos(a) * r * l, g, Math.sin(a) * r * l)
      ctx.lineTo(sx, sy)
    }
    project(-0.05, g, 0); ctx.moveTo(sx, sy); project(0.05, g, 0); ctx.lineTo(sx, sy)
    project(0, g, -0.05); ctx.moveTo(sx, sy); project(0, g, 0.05); ctx.lineTo(sx, sy)
    ctx.stroke()

    // dashes: project, bucket by colour and depth-faded alpha, one stroke per bucket
    const counts = new Int32Array(GL * AL + 1)
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity
    for (let i = 0; i < n; i++) {
      const a = ca[i]
      if (a < 0.02) {
        bucket[i] = GL * AL
        counts[GL * AL]++
        continue
      }
      const j = i * 3
      const z2 = project(cp[j] - ct[j], cp[j + 1] - ct[j + 1], cp[j + 2] - ct[j + 2])
      xy[i * 4] = sx
      xy[i * 4 + 1] = sy
      project(cp[j] + ct[j], cp[j + 1] + ct[j + 1], cp[j + 2] + ct[j + 2])
      xy[i * 4 + 2] = sx
      xy[i * 4 + 3] = sy
      if (a > 0.6) {
        bx0 = Math.min(bx0, sx); bx1 = Math.max(bx1, sx)
        by0 = Math.min(by0, sy); by1 = Math.max(by1, sy)
      }
      const depth = 1 - 0.62 * Math.min(1, Math.max(0, (z2 + 1) / 2))
      const al = Math.min(AL - 1, Math.max(0, Math.round(a * depth * AL) - 1))
      const gl = Math.round(cg[i] * (GL - 1))
      const b = gl * AL + al
      bucket[i] = b
      counts[b]++
    }
    const start = new Int32Array(GL * AL + 2)
    for (let b = 0; b <= GL * AL; b++) start[b + 1] = start[b] + counts[b]
    const fill = start.slice()
    for (let i = 0; i < n; i++) order[fill[bucket[i]]++] = i
    ctx.lineWidth = 1.25
    ctx.lineCap = 'butt'
    for (let b = 0; b < GL * AL; b++) {
      if (start[b] === start[b + 1]) continue
      ctx.strokeStyle = this.styles[b]
      ctx.beginPath()
      for (let k = start[b]; k < start[b + 1]; k++) {
        const q = order[k] * 4
        ctx.moveTo(xy[q], xy[q + 1])
        ctx.lineTo(xy[q + 2], xy[q + 3])
      }
      ctx.stroke()
    }

    this.drawFrame(bx0, by0, bx1, by1)
  }

  /** Viewfinder corners that lock onto the subject once it is assembled, like the boxes on a camera frame. */
  private drawFrame(x0: number, y0: number, x1: number, y1: number) {
    const fr = this.frame
    const dt = this.dt
    const want = this.phase === 'hold' && this.hold > 0.15 && Number.isFinite(x0) ? 1 : 0
    const pad = 16
    if (Number.isFinite(x0)) {
      if (!fr.set || fr.a < 0.02) {
        // acquire from a little wider, then tighten
        fr.x0 = x0 - pad - 26; fr.y0 = y0 - pad - 26; fr.x1 = x1 + pad + 26; fr.y1 = y1 + pad + 26
        fr.set = true
      }
      const k = this.reduce ? 1 : smooth(dt, 7)
      fr.x0 += (x0 - pad - fr.x0) * k; fr.y0 += (y0 - pad - fr.y0) * k
      fr.x1 += (x1 + pad - fr.x1) * k; fr.y1 += (y1 + pad - fr.y1) * k
    }
    fr.a += (want - fr.a) * (this.reduce ? 1 : smooth(dt, want ? 4 : 12))
    if (fr.a < 0.02) return
    const { ctx } = this
    const sh = this.shapes[this.idx]
    const col = sh.gold ? GOLD : INK
    const L = 12
    ctx.globalAlpha = fr.a * 0.85
    ctx.strokeStyle = `rgb(${col[0]},${col[1]},${col[2]})`
    ctx.lineWidth = 1.5
    ctx.beginPath()
    for (const [x, y, dx, dy] of [[fr.x0, fr.y0, 1, 1], [fr.x1, fr.y0, -1, 1], [fr.x0, fr.y1, 1, -1], [fr.x1, fr.y1, -1, -1]]) {
      ctx.moveTo(x + dx * L, y)
      ctx.lineTo(x, y)
      ctx.lineTo(x, y + dy * L)
    }
    ctx.stroke()
    ctx.font = '500 12px "Vela Sans", system-ui, sans-serif'
    const tw = ctx.measureText(sh.title).width
    const lx = fr.x0
    const ly = fr.y0 - 8 - 20
    ctx.fillStyle = 'rgba(12,14,17,0.72)'
    ctx.beginPath()
    ctx.roundRect(lx, ly, tw + 16, 20, 4)
    ctx.fill()
    if (sh.gold) {
      ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`
      ctx.fillRect(lx, ly, 2, 20)
    }
    ctx.fillStyle = 'rgb(242,239,233)'
    ctx.textBaseline = 'middle'
    ctx.fillText(sh.title, lx + 8, ly + 10.5)
    ctx.globalAlpha = 1
  }
}
