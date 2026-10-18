/*
 * Springs with Apple's two designer parameters: damping ratio and response (seconds).
 * k = (2π/response)², c = 4π·ζ/response, mass = 1.
 * Every animation starts from the current presentation value and can be retargeted mid-flight,
 * carrying its velocity, so a gesture can grab and reverse anything at any time.
 */

export const reducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

type Stepper = { step(dt: number): void; settle(): void }

const loop = {
  set: new Set<Stepper>(),
  raf: 0,
  last: 0,
  add(s: Stepper) {
    this.set.add(s)
    if (!this.raf) {
      this.last = performance.now()
      this.raf = requestAnimationFrame(tick)
    }
  },
}
function tick(now: number) {
  const dt = Math.min(0.05, (now - loop.last) / 1000)
  loop.last = now
  for (const s of [...loop.set]) s.step(dt)
  loop.raf = loop.set.size ? requestAnimationFrame(tick) : 0
}
// If frames stop (background tab, thumbnail capture) settle every spring at its target,
// so the interface is never left frozen half-way through a transition.
if (typeof window !== 'undefined') {
  window.setInterval(() => {
    if (!loop.set.size || performance.now() - loop.last < 600) return
    for (const s of [...loop.set]) s.settle()
    cancelAnimationFrame(loop.raf)
    loop.raf = 0
  }, 400)
}

export interface SpringOptions {
  response?: number
  damping?: number
  rest?: number
  onUpdate?: (x: number) => void
  onRest?: () => void
}

export class Spring implements Stepper {
  x: number
  v = 0
  target: number
  response: number
  damping: number
  rest: number
  onUpdate?: (x: number) => void
  onRest?: () => void

  constructor(value = 0, o: SpringOptions = {}) {
    this.x = value
    this.target = value
    this.response = o.response ?? 0.35
    this.damping = o.damping ?? 1
    this.rest = o.rest ?? 0.01
    this.onUpdate = o.onUpdate
    this.onRest = o.onRest
  }

  to(target: number, o: { velocity?: number; response?: number; damping?: number; onRest?: () => void; instant?: boolean } = {}) {
    if (o.response) this.response = o.response
    if (o.damping) this.damping = o.damping
    if (o.velocity !== undefined) this.v = o.velocity
    if (o.onRest !== undefined) this.onRest = o.onRest
    this.target = target
    if (reducedMotion() || o.instant) {
      this.set(target)
      this.onRest?.()
      return this
    }
    loop.add(this)
    return this
  }

  set(value: number) {
    this.x = value
    this.target = value
    this.v = 0
    loop.set.delete(this)
    this.onUpdate?.(value)
    return this
  }

  stop() {
    loop.set.delete(this)
    this.v = 0
    return this
  }

  get moving() {
    return loop.set.has(this)
  }

  settle() {
    this.x = this.target
    this.v = 0
    loop.set.delete(this)
    this.onUpdate?.(this.x)
    this.onRest?.()
  }

  step(dt: number) {
    const k = (2 * Math.PI / this.response) ** 2
    const c = (4 * Math.PI * this.damping) / this.response
    const n = Math.max(1, Math.ceil(dt / (1 / 240)))
    const h = dt / n
    for (let i = 0; i < n; i++) {
      const a = -k * (this.x - this.target) - c * this.v
      this.v += a * h
      this.x += this.v * h
    }
    if (Math.abs(this.v) < this.rest * 8 && Math.abs(this.x - this.target) < this.rest) {
      this.settle()
      return
    }
    this.onUpdate?.(this.x)
  }
}

/** Animate 0 → 1 once; convenient for one-shot transitions driven by a spring. */
export function springOnce(o: SpringOptions & { from?: number; to?: number }) {
  const s = new Spring(o.from ?? 0, { rest: 0.002, ...o })
  s.to(o.to ?? 1)
  return s
}

/* Momentum projection, exactly as in the Designing Fluid Interfaces sample code. */
export const project = (velocity: number, deceleration = 0.998) =>
  ((velocity / 1000) * deceleration) / (1 - deceleration)

/* Rubber-banding past a boundary: the further you pull, the less it follows. */
export const rubber = (overshoot: number, dimension: number, c = 0.55) =>
  (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot))

export class VelocityTracker {
  private s: { x: number; y: number; t: number }[] = []
  reset() {
    this.s = []
  }
  add(x: number, y: number) {
    const t = performance.now()
    this.s.push({ x, y, t })
    while (this.s.length && t - this.s[0].t > 100) this.s.shift()
  }
  get() {
    if (this.s.length < 2) return { x: 0, y: 0 }
    const a = this.s[0]
    const b = this.s[this.s.length - 1]
    const dt = Math.max(1, b.t - a.t) / 1000
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt }
  }
}

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)

export function capture(el: Element, pointerId: number) {
  try {
    el.setPointerCapture(pointerId)
  } catch {
    // the pointer may already be gone (synthetic events, fast release)
  }
}
