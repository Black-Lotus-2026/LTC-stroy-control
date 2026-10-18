import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CostBasis, InactionCurve } from '../api'
import { fmtDay, plural } from '../lib/format'
import { Spring, clamp, reducedMotion } from '../lib/spring'

/* Sums come from the server as decimal strings: the whole part goes through BigInt, never a float. */
function amount(v: string) {
  const [whole, frac = ''] = v.split('.')
  const tail = frac.replace(/0+$/, '').slice(0, 2)
  const neg = whole.startsWith('-')
  const n = new Intl.NumberFormat('ru-RU').format(BigInt(neg ? whole.slice(1) : whole))
  return `${neg ? '−' : ''}${n}${tail ? ',' + tail : ''}`
}
export const money = (v: string | null | undefined, currency = 'RUB') => (v == null ? '—' : `${amount(v)} ${currency === 'RUB' ? '₽' : currency}`)
const num = (v: string) => amount(v).replace(/,$/, '')

/** "8 рабочих часов", "7,5 рабочего часа" */
function workHours(v: string) {
  const h = Number(v)
  if (!Number.isInteger(h)) return `${num(v)} рабочего часа`
  return `${h} ${plural(h, 'рабочий час', 'рабочих часа', 'рабочих часов')}`
}

const PARTS: [keyof InactionCurve['points'][number], string][] = [
  ['idle_cost', 'Простой'],
  ['extension_cost', 'Продление графика'],
  ['intervention_cost', 'Вмешательство'],
  ['other_cost', 'Прочее'],
]

/**
 * What inaction would cost by this event's own scenario: the sum for a delay chosen on the curve
 * and, on request, what it is made of. A scenario estimate, never presented as actual damage.
 */
export function CostOfInaction({ curve }: { curve: InactionCurve }) {
  const pts = curve.points.filter((p) => p.cost != null)
  const [i, setI] = useState(pts.length - 1)
  const [why, setWhy] = useState(false)
  const id = useId()
  const svg = useRef<SVGSVGElement>(null)
  const mark = useRef<SVGGElement>(null)
  // drawn at its real width, so points stay round at any width of the case
  const [W, setW] = useState(320)
  const H = 72
  useLayoutEffect(() => {
    const el = svg.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(Math.max(160, Math.round(el.clientWidth))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const maxH = Math.max(...pts.map((p) => Number(p.work_hours)), 1)
  const maxC = Math.max(...pts.map((p) => Number(p.cost)), 1)
  const X = (h: string) => (Number(h) / maxH) * (W - 8) + 4
  const Y = (c: string) => H - 6 - (Number(c) / maxC) * (H - 16)
  // the marker travels to the chosen point on a spring, so the eye follows the sum it reads
  const sx = useRef<Spring | null>(null)
  useEffect(() => {
    const p = pts[i]
    if (!p || !mark.current) return
    const x = X(p.work_hours)
    const y = Y(p.cost!)
    const g = mark.current
    const put = (v: number) => g.setAttribute('transform', `translate(${v} 0)`)
    const dot = g.querySelector('circle')
    if (dot) dot.setAttribute('cy', String(y))
    if (!sx.current || reducedMotion()) {
      sx.current = new Spring(x, { response: 0.32, damping: 0.86, rest: 0.2, onUpdate: put })
      put(x)
    } else sx.current.to(x)
  })
  if (!pts.length) return null
  const p = pts[clamp(i, 0, pts.length - 1)]
  const pick = (clientX: number) => {
    const r = svg.current!.getBoundingClientRect()
    const h = ((clientX - r.left) / r.width) * maxH
    let best = 0
    pts.forEach((q, k) => Math.abs(Number(q.work_hours) - h) < Math.abs(Number(pts[best].work_hours) - h) && (best = k))
    setI(best)
  }
  const line = pts.map((q) => `${X(q.work_hours).toFixed(1)},${Y(q.cost!).toFixed(1)}`).join(' ')
  const doubtful = curve.status === 'partial' || curve.evidence_supported === false
  const parts = PARTS.filter(([k]) => p[k] != null && Number(p[k]) !== 0)
  return (
    <div className="cost">
      <div className="c-line">
        Если не вмешаться {workHours(p.work_hours)} — около <b className="c-sum">{money(p.cost, curve.currency)}</b>
      </div>
      <div className="c-sub">
        Сценарная оценка{curve.as_of ? ` на ${fmtDay(new Date(curve.as_of).getTime())}` : ''}, не фактический ущерб
        {curve.data_mode === 'demo' ? ' · демо-данные' : ''}
        {doubtful && <span className="c-doubt"> · основания требуют проверки</span>}
      </div>
      <svg
        ref={svg}
        className="c-chart"
        viewBox={`0 0 ${W} ${H}`}
        role="slider"
        tabIndex={0}
        aria-label="Задержка в рабочих часах"
        aria-valuemin={0}
        aria-valuemax={maxH}
        aria-valuenow={Number(p.work_hours)}
        aria-valuetext={`${workHours(p.work_hours)}: ${money(p.cost, curve.currency)}`}
        onPointerDown={(e) => pick(e.clientX)}
        onPointerMove={(e) => (e.buttons || e.pointerType === 'mouse') && pick(e.clientX)}
        onKeyDown={(e) => {
          const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
          if (!d) return
          e.preventDefault()
          setI((k) => clamp(k + d, 0, pts.length - 1))
        }}
      >
        <polygon points={`4,${H - 6} ${line} ${W - 4},${H - 6}`} className="c-area" />
        <polyline points={line} className="c-curve" />
        {pts.map((q) => (
          <circle key={q.work_hours} cx={X(q.work_hours)} cy={Y(q.cost!)} r={1.6} className="c-pt" />
        ))}
        <g ref={mark} className="c-mark">
          <line x1={0} x2={0} y1={4} y2={H - 6} />
          <circle cx={0} cy={0} r={3.6} />
        </g>
      </svg>
      <div className="c-axis" aria-hidden="true">
        <span>0 ч</span>
        <span>{num(curve.horizon_work_hours ?? pts[pts.length - 1].work_hours)} ч задержки</span>
      </div>
      <button type="button" className="link-plain c-why" aria-expanded={why} aria-controls={id} onClick={() => setWhy(!why)}>
        {why ? 'Скрыть расчёт' : 'Из чего сумма'}
      </button>
      {why && (
        <div className="c-basis" id={id}>
          {parts.length > 0 && (
            <p>
              {parts.map(([k, l], n) => (
                <span key={k}>
                  {n ? ' · ' : ''}
                  {l} {money(p[k] as string, curve.currency)}
                </span>
              ))}
            </p>
          )}
          {(p.basis || []).map((b, n) => (
            <Basis key={n} b={b} />
          ))}
          <small>
            Горизонт задан сценарием{curve.horizon_source ? ` «${curve.horizon_source}»` : ''}
            {curve.observed_since ? ` · отсчёт от ${fmtDay(new Date(curve.observed_since).getTime())}` : ''}. Расчёт ведёт калькулятор на сервере, модель в нём не участвует.
          </small>
        </div>
      )}
    </div>
  )
}

const UNIT: Record<string, string> = { work_hour: 'раб. ч', hour: 'ч', day: 'день', shift: 'смену' }
const CONFIRMED: Record<string, string> = { demo: 'демо-вход', confirmed: 'подтверждено', assumed: 'допущение' }

function Basis({ b }: { b: CostBasis }) {
  const rate = b.rate ? `${money(b.rate, b.currency)}${b.unit ? ` за ${UNIT[b.unit] ?? b.unit}` : ''}` : null
  const how = [rate, b.units ? `× ${num(b.units)}` : null, b.multiplier && Number(b.multiplier) !== 1 ? `× ${num(b.multiplier)}` : null].filter(Boolean).join(' ')
  return (
    <div className="c-b">
      <span>{b.title}</span>
      <b>{money(b.amount, b.currency)}</b>
      <small>{[how, b.source, b.confirmation && (CONFIRMED[b.confirmation] ?? b.confirmation)].filter(Boolean).join(' · ')}</small>
    </div>
  )
}

/** The case's answer when the server has nothing to calculate from: what is missing, in one line. */
export function CostMissing({ curve }: { curve: InactionCurve }) {
  const needs = (curve.needs || []).map((n) => n.charAt(0).toLowerCase() + n.slice(1))
  const who = curve.responsible || curve.project_owner
  return (
    <p className="cost-none">
      Цена бездействия не рассчитана{needs.length ? `: нужны ${needs.join(', ')}` : ''}.{who ? ` Подготовить их может ${who}.` : ''}
    </p>
  )
}
