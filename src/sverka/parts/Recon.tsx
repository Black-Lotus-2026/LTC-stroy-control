import { useLayoutEffect, useRef, useState } from 'react'
import type { Evaluation, Observation, Profile, Slot, Stage } from '../model'
import { LV, stageDay } from '../model'
import { MACH, Sil, silHTML, type Code } from '../lib/machinery'
import { durShort, fmtDay } from '../lib/format'
import { Spring, clamp, lerp, reducedMotion } from '../lib/spring'

/* The fact lands on the plan: a white silhouette leaves the detection box on the frame and
   flies in an arc to its gold outline in the reconciliation list. */
export function flyToken(code: Code, from: DOMRect | null, toEl: Element | null, onLand: () => void, delay = 0) {
  if (reducedMotion() || !from || !toEl) {
    onLand()
    return
  }
  const to = toEl.getBoundingClientRect()
  const tok = document.createElement('div')
  tok.className = 'token'
  tok.innerHTML = `<div class="halo"></div>${silHTML(code, 'ink')}`
  document.body.appendChild(tok)
  const x0 = from.left + from.width / 2 - 32
  const y0 = from.top + from.height / 2 - 20
  const x1 = to.left + to.width / 2 - 32
  const y1 = to.top + to.height / 2 - 20
  const cx = lerp(x0, x1, 0.5)
  const cy = Math.min(y0, y1) - Math.max(60, Math.abs(x1 - x0) * 0.18)
  const s0 = clamp(Math.min(from.width / 64, from.height / 40), 0.6, 2.6)
  tok.style.opacity = '0'
  tok.style.transform = `translate(${x0}px,${y0}px) scale(${s0})`
  const run = () => {
    const sp = new Spring(0, {
      response: 0.62,
      damping: 0.86,
      rest: 0.002,
      onUpdate: (p) => {
        const q = clamp(p, 0, 1.08)
        const x = (1 - q) * (1 - q) * x0 + 2 * (1 - q) * q * cx + q * q * x1
        const y = (1 - q) * (1 - q) * y0 + 2 * (1 - q) * q * cy + q * q * y1
        tok.style.transform = `translate(${x}px,${y}px) scale(${lerp(s0, 1, clamp(p, 0, 1))})`
        tok.style.opacity = String(clamp(p * 5, 0, 1))
      },
      onRest: () => {
        tok.remove()
        onLand()
      },
    })
    sp.to(1)
  }
  if (delay) window.setTimeout(run, delay)
  else run()
}
function liftOff(code: Code, iconEl: Element | null) {
  if (reducedMotion() || !iconEl) return
  const r = iconEl.getBoundingClientRect()
  const tok = document.createElement('div')
  tok.className = 'token'
  tok.innerHTML = silHTML(code, 'ink')
  document.body.appendChild(tok)
  const sp = new Spring(0, {
    response: 0.6,
    damping: 1,
    rest: 0.002,
    onUpdate: (p) => {
      tok.style.transform = `translate(${r.left}px,${r.top - p * 26}px) scale(${(r.width / 64) * (1 + p * 0.12)})`
      tok.style.opacity = String(1 - p)
      tok.style.filter = `blur(${p * 3}px)`
    },
    onRest: () => tok.remove(),
  })
  sp.to(1)
}
const sourceRect = (code: Code, cams: { src: string }[]) => {
  const box = document.querySelector(`.frame[data-boxes="on"] [data-box="${code}"]`)
  if (box) return box.getBoundingClientRect()
  const tile = cams.length ? document.querySelector(`.tile[aria-pressed] ~ .tile, .tile`) : null
  return tile ? tile.getBoundingClientRect() : null
}

function stateText(s: Slot, names: Map<string, number>) {
  switch (s.state) {
    case 'seen': {
      const ns = s.cams.map((c) => names.get(c.src) ?? '?')
      return `замечен · ${ns.length > 1 ? 'источники' : 'источник'} ${ns.join(', ')}`
    }
    case 'unknown':
      return 'нет данных'
    case 'offshift':
      return 'вне смены'
    case 'gathering':
      return 'сбор техники после начала смены'
    case 'waiting':
      return <>не виден <span className="mono">{durShort(s.missFor ?? 0)}</span></>
    case 'missing':
      if (s.lvl === 'rec') return s.neverSeen ? 'не замечен за время наблюдения' : `не замечен ${durShort(s.missFor ?? 0)}`
      return (
        <>
          нет <span className="mono">{durShort(s.missFor ?? 0)}</span>
          {s.limited ? ' · не все камеры в работе' : ''}
        </>
      )
  }
}
function Arc({ s }: { s: Slot }) {
  if (!(s.state === 'waiting' || (s.state === 'missing' && s.lvl === 'req')) || s.missFor == null) return null
  const toWarn = s.missFor < s.warnAfter * 1000
  const frac = toWarn ? s.missFor / (s.warnAfter * 1000) : clamp((s.missFor - s.warnAfter * 1000) / ((s.errAfter - s.warnAfter) * 1000), 0, 1)
  const col = toWarn ? 'var(--fg-3)' : s.sev === 'err' ? 'var(--err)' : 'var(--warn)'
  const L = 2 * Math.PI * 9
  return (
    <svg className="s-arc" viewBox="0 0 22 22" aria-hidden="true">
      <circle cx="11" cy="11" r="9" stroke="var(--track)" />
      <circle cx="11" cy="11" r="9" stroke={col} strokeDasharray={L} strokeDashoffset={L * (1 - frac)} transform="rotate(-90 11 11)" strokeLinecap="round" />
    </svg>
  )
}

export function Recon({
  ev,
  stage,
  prof,
  obs,
  loading,
  infer,
  onRule,
  onFocus,
}: {
  ev: Evaluation
  stage: Stage | null
  prof: Profile | null
  obs: Observation
  loading: boolean
  infer: Stage | null
  onRule: (code: Code, el: HTMLElement) => void
  onFocus: (code: Code | null) => void
}) {
  const root = useRef<HTMLElement>(null)
  const prev = useRef<{ stage: string; states: Map<Code, string> } | null>(null)
  const [holding, setHolding] = useState<Set<Code>>(new Set())
  const booted = useRef<string | null>(null)
  const names = new Map(obs.sources.map((s) => [s.id, s.n]))

  useLayoutEffect(() => {
    if (!stage || !prof) return
    const now = new Map(ev.slots.map((s) => [s.code, s.state]))
    const was = prev.current
    prev.current = { stage: stage.id, states: now }
    const firstForStage = booted.current !== stage.id
    const arrivals: Code[] = []
    for (const s of ev.slots) {
      const before = was && was.stage === stage.id ? was.states.get(s.code) : undefined
      if (s.state === 'seen' && ((before && before !== 'seen') || (firstForStage && ev.covered))) arrivals.push(s.code)
      if (before === 'seen' && s.state !== 'seen') liftOff(s.code, root.current?.querySelector(`.slot[data-code="${s.code}"] .s-icon`) ?? null)
    }
    if (firstForStage && ev.covered) booted.current = stage.id
    if (!arrivals.length) return
    setHolding((h) => new Set([...h, ...arrivals]))
    arrivals.forEach((code, i) => {
      const slot = ev.slots.find((x) => x.code === code)!
      queueMicrotask(() =>
        flyToken(
          code,
          sourceRect(code, slot.cams),
          root.current?.querySelector(`.slot[data-code="${code}"] .s-icon`) ?? null,
          () => {
            setHolding((h) => {
              const n = new Set(h)
              n.delete(code)
              return n
            })
            const el = root.current?.querySelector(`.slot[data-code="${code}"]`)
            if (el) {
              el.classList.remove('flash')
              void (el as HTMLElement).offsetWidth
              el.classList.add('flash')
              const icon = el.querySelector('.s-icon') as HTMLElement | null
              if (icon && !reducedMotion()) new Spring(0.86, { response: 0.4, damping: 0.55, rest: 0.002, onUpdate: (x) => (icon.style.transform = `scale(${x})`) }).to(1)
            }
          },
          i * 160,
        ),
      )
    })
  })

  if (!stage)
    return (
      <section className="panel recon" aria-labelledby="reconTitle">
        <div className="recon-head">
          <div>
            <span className="kicker">Сверка</span>
            <h2 id="reconTitle">Нет активного этапа</h2>
            <p>На {fmtDay(ev.t)} в плане нет работ, сверка не выполняется.</p>
          </div>
        </div>
      </section>
    )
  const day = stageDay(stage, ev.t)
  return (
    <section className="panel recon" aria-labelledby="reconTitle" ref={root} onPointerLeave={() => onFocus(null)}>
      <div className="recon-head">
        <div>
          <span className="kicker">Сверка · этап {stage.n}</span>
          <h2 id="reconTitle">{stage.name}</h2>
          <p>
            {fmtDay(stage.start)} – {fmtDay(stage.end)}
          </p>
        </div>
        <div className="stage-day">
          <span className="kicker">День</span>
          <div className="day-n">
            {day}
            <span> из {stage.days}</span>
          </div>
        </div>
      </div>
      <div className="stage-progress" aria-hidden="true">
        <i style={{ width: `${clamp(day / stage.days, 0, 1) * 100}%` }} />
      </div>
      {loading || !prof ? (
        <div className="skeleton" aria-label="Загружаем профиль техники">
          <i />
          <i />
          <i />
        </div>
      ) : (
        <>
          <div className="slots">
            {ev.slots.map((s, i) => {
              const hold = holding.has(s.code)
              const ink = s.state === 'seen' && !hold ? 'ink' : s.state === 'unknown' ? 'dim' : 'ghost'
              return (
                <button
                  key={s.code}
                  type="button"
                  className="slot"
                  data-code={s.code}
                  data-state={hold ? 'waiting' : s.state}
                  data-sev={s.sev}
                  onClick={(e) => onRule(s.code, e.currentTarget)}
                  onPointerEnter={() => onFocus(s.code)}
                  onFocus={() => onFocus(s.code)}
                  aria-label={`${MACH[s.code].name}, ${LV[s.lvl].label.toLowerCase()}. Открыть правило`}
                >
                  <span className="s-icon">
                    <Sil code={s.code} ink={ink} draw={booted.current !== stage.id} delay={i * 90} />
                  </span>
                  <span className="s-body">
                    <span className="s-name">
                      {MACH[s.code].name}
                      <span className="s-req">
                        {LV[s.lvl].label.toLowerCase()}
                        {s.edited && (
                          <>
                            {' · '}
                            <span className="edited">изменено</span>
                          </>
                        )}
                      </span>
                    </span>
                    <span className="s-state">{hold ? 'ищем на кадрах…' : stateText(s, names)}</span>
                  </span>
                  <span className="s-arcw">
                    <Arc s={s} />
                  </span>
                </button>
              )
            })}
            {!ev.slots.length && <p className="recon-note">Для этапа нет обязательной или рекомендуемой техники.</p>}
          </div>
          <div className="extra">
            <div className="extra-row">
              <span>Не по этапу</span>
              <div className="oop-tray">
                {ev.oop.length ? (
                  ev.oop.map((o) => (
                    <button key={o.code} type="button" className="oop-chip" data-code={o.code} onClick={(e) => onRule(o.code, e.currentTarget)} onPointerEnter={() => onFocus(o.code)}>
                      <Sil code={o.code} ink="oop" />
                      {MACH[o.code].name}
                    </button>
                  ))
                ) : (
                  <span className="oop-none">{ev.covered ? 'нет' : 'нет данных'}</span>
                )}
              </div>
            </div>
            {ev.allowed.length > 0 && (
              <div className="extra-row">
                <span>Допустимы</span>
                <span>
                  {ev.allowed.map((a, i) => (
                    <span key={a.code}>
                      {i > 0 && ', '}
                      <button type="button" data-code={a.code} onClick={(e) => onRule(a.code, e.currentTarget)}>
                        {MACH[a.code].lower}
                      </button>
                    </span>
                  ))}
                </span>
              </div>
            )}
            {ev.stationary.length > 0 && (
              <div className="extra-row">
                <span>Не учитываются</span>
                <span>
                  {ev.stationary.map((a, i) => (
                    <span key={a.code}>
                      {i > 0 && ', '}
                      <button type="button" data-code={a.code} onClick={(e) => onRule(a.code, e.currentTarget)}>
                        {MACH[a.code].lower}
                      </button>
                    </span>
                  ))}
                </span>
              </div>
            )}
          </div>
          {infer && (
            <div className="infer">
              <strong>Набор техники похож на этап {infer.n}</strong>
              Замеченная техника характерна для «{infer.name}» ({fmtDay(infer.start)} – {fmtDay(infer.end)}).
            </div>
          )}
        </>
      )}
    </section>
  )
}
