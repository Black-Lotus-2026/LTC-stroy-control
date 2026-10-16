import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Incident } from '../../data'
import { isValidUuid } from '../../api/stroyControlApi'
import { managementApi, type InactionCurve, type InactionPoint, type CostBasis } from '../../api/managementApi'
import './incident-cost.css'

function number(value: string): string {
  const [whole, fraction = ''] = value.split('.')
  const tail = fraction.replace(/0+$/, '')
  return `${new Intl.NumberFormat('ru-RU').format(BigInt(whole))}${tail ? ',' + tail : ''}`
}
const money = (value: string | null, currency = 'RUB') => value === null ? 'Нет данных' : `${number(value)} ${currency === 'RUB' ? '₽' : currency}`

type CostCaseProps = { incidentId?: string; title: string; onOpenCase?: () => void }

export function IncidentCostButton({ incidentId, title, onOpenCase }: CostCaseProps) {
  const [open, setOpen] = useState(false)
  const close = useCallback(() => setOpen(false), [])
  return <>
    <button type="button" className="case-cost-button" onClick={event => { event.stopPropagation(); setOpen(true) }}>Цена бездействия</button>
    {open && <IncidentCostDialog incidentId={incidentId} title={title} onClose={close} onOpenCase={onOpenCase} />}
  </>
}

export function IncidentCostDialog(props: CostCaseProps & { onClose: () => void }) {
  return createPortal(<CostModal {...props} />, document.body)
}

export function CaseCostsPanel({ incidents, projectId, onOpenCase }: { incidents: Incident[]; projectId?: string; onOpenCase: (incident: Incident) => void }) {
  const cases = incidents.filter(item => item.projectId === projectId && item.severity !== 'NEUTRAL' && item.discrepancyType !== 'STREAM_ONLINE')
  return <section className="case-cost-list">
    <h2>Отклонения</h2>
    {cases.length ? <ul>{cases.map(item => <li key={item.uuid || item.id}>
      <div><strong>{item.title}</strong><span>{item.zone} · {item.time}</span></div>
      <IncidentCostButton incidentId={item.uuid} title={item.title} onOpenCase={() => onOpenCase(item)} />
    </li>)}</ul> : <p className="case-cost-empty">Отклонений пока нет.</p>}
  </section>
}

function CostModal({ incidentId, title, onClose, onOpenCase }: CostCaseProps & { onClose: () => void }) {
  const [data, setData] = useState<InactionCurve | null>(null)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const [infoPinned, setInfoPinned] = useState(false)
  const info = useRef<HTMLSpanElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const dialog = useRef<HTMLDivElement>(null)
  const infoId = useId()
  const headingId = useId()
  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      setError('')
      setData(null)
      setSelected(null)
      if (!incidentId || !isValidUuid(incidentId)) { setError('Случай ещё не сохранён.'); return }
      try {
        const curve = await managementApi.inactionCost(incidentId, controller.signal)
        if (!controller.signal.aborted) setData(curve)
      } catch {
        if (!controller.signal.aborted) setError('Не удалось получить расчёт.')
      }
    }
    void load()
    return () => controller.abort()
  }, [incidentId])
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeButton.current?.focus()
    function keydown(event: KeyboardEvent) {
      if (event.key === 'Escape') { event.preventDefault(); onClose() }
      if (event.key === 'Tab') {
        const elements = dialog.current?.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]')
        if (!elements?.length) return
        const first = elements[0], last = elements[elements.length - 1]
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      document.body.style.overflow = overflow
      document.removeEventListener('keydown', keydown)
      if (previous?.isConnected) previous.focus()
    }
  }, [onClose])
  const point = data?.points[selected ?? data.points.length - 1]
  const ready = !error && data?.status === 'complete' && point?.cost !== null && Boolean(point)
  const basis = point ? breakdown(point, data?.currency) : ''
  const zone = data?.timezone || 'Europe/Moscow'
  const asOf = dateTime(data?.as_of, zone)
  const displayTitle = data?.data_mode === 'demo' ? title.replace(/^Демо\s*[·:—-]\s*/i, '').replace(/^./, first => first.toUpperCase()) : title
  const closeInfo = () => { setInfoOpen(false); setInfoPinned(false) }
  return <div className="case-cost-backdrop" onClick={event => { event.stopPropagation(); if (event.target === event.currentTarget) onClose() }}>
    <div ref={dialog} className="case-cost-modal" role="dialog" aria-modal="true" aria-labelledby={headingId}
      onClickCapture={event => { if (!info.current?.contains(event.target as Node)) closeInfo() }}>
      <header><h2 id={headingId}>Цена бездействия</h2><button ref={closeButton} type="button" className="case-cost-close" aria-label="Закрыть расчёт" onClick={onClose}>×</button></header>
      {onOpenCase ? <a className="case-cost-title case-cost-link" href={`#report-item-${data?.incident_code || incidentId || ''}`} aria-label={`Открыть случай: ${title}`}
        onClick={event => { event.preventDefault(); onClose(); onOpenCase() }}>{displayTitle} ↗</a> : <p className="case-cost-title">{displayTitle}</p>}
      {ready && data && point ? <>
        <p className="case-cost-kind">Сценарная оценка{data.data_mode === 'demo' ? ' · демо' : ''}</p>
        <div className="case-cost-total"><strong aria-live="polite">{money(point.cost, data.currency)}</strong>
          <span ref={info} className="case-cost-info" onPointerEnter={event => { if (event.pointerType !== 'touch') setInfoOpen(true) }} onPointerLeave={() => { if (!infoPinned) setInfoOpen(false) }}
            onKeyDown={event => { if (event.key === 'Escape' && infoOpen) { event.preventDefault(); event.stopPropagation(); closeInfo() } }}>
            <button type="button" aria-label="Из чего сложилась сумма" aria-expanded={infoOpen} aria-describedby={infoOpen ? infoId : undefined}
              onFocus={() => setInfoOpen(true)} onBlur={() => { if (!infoPinned) setInfoOpen(false) }}
              onClick={() => { setInfoPinned(!infoPinned); setInfoOpen(!infoPinned) }}><span aria-hidden="true">i</span></button>
            {infoOpen && <span role="tooltip" id={infoId}>
              <strong>{basis}</strong>
              <BasisDetails basis={point.basis || []} timezone={zone} />
              <span className="case-cost-info-meta">Горизонт: {number(data.horizon_work_hours || '0')} раб. ч, задан сценарием.{point.delay_work_hours !== null ? ` Сдвиг контрольной точки: ${number(point.delay_work_hours)} раб. ч.` : ''}</span>
            </span>}
          </span>
        </div>
        <p className="case-cost-duration">Если задержка составит {number(point.work_hours)} раб. ч</p>
        {!data.evidence_supported && <p className="case-cost-warning">Основания требуют проверки</p>}
        {data.points.length > 1 ? <>
          <p className="case-cost-chart-hint">Выберите время на графике</p>
          <CostChart points={data.points} currency={data.currency || 'RUB'} selected={selected ?? data.points.length - 1} onSelect={setSelected} />
        </> : <p className="case-cost-empty">Период задержки не задан.</p>}
        <p className="case-cost-caption">Отсчёт расчёта: {asOf}</p>
      </> : <div className="case-cost-empty" role="status">
        <p>{error || (data ? data.message || 'Для оценки не хватает данных.' : 'Загружаем расчёт…')}</p>
        {!error && data && <>
          {!!data.needs?.length && <ul aria-label="Что нужно для расчёта">{data.needs.map(need => <li key={need}>{need}</li>)}</ul>}
          <p className="case-cost-next">{data.responsible ? `Передайте данные ответственному: ${data.responsible}.` : data.project_owner ? `Передайте данные владельцу объекта: ${data.project_owner}.` : 'Передайте эти данные ответственному за случай.'}</p>
        </>}
      </div>}
    </div>
  </div>
}

function breakdown(point: InactionPoint, currency = 'RUB'): string {
  const parts: [string, string | null][] = [['Простой', point.idle_cost], ['Продление графика', point.extension_cost], ['Разовые затраты', point.intervention_cost], ['Прочие затраты', point.other_cost]]
  const used = parts.filter(([, value]) => value !== null && Number(value) !== 0)
  return used.length ? used.map(([name, value]) => `${name}: ${money(value, currency)}`).join('; ') + '.' : 'Дополнительные затраты не возникают.'
}

function dateTime(value?: string | null, timezone = 'Europe/Moscow'): string {
  if (!value) return 'не указано'
  return new Intl.DateTimeFormat('ru-RU', { timeZone: timezone, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) + (timezone === 'Europe/Moscow' ? ' МСК' : ` (${timezone})`)
}

function BasisDetails({ basis, timezone }: { basis: CostBasis[]; timezone: string }) {
  const rates = basis.filter((row, index) => row.rate !== null && basis.findIndex(other => other.title === row.title && other.rate === row.rate && other.unit === row.unit && other.multiplier === row.multiplier && other.source === row.source) === index)
  const sources = [...new Set(basis.map(row => row.source))]
  return <>
    {rates.map((row, index) => <span className="case-cost-rate" key={index}>{row.confirmation === 'demo' ? row.title.replace(/ \(условный оплачиваемый ресурс\)/, '') : row.title}: {money(row.rate, row.currency)}/{row.unit === 'work_hour' ? 'раб. ч' : row.unit === 'work_day' ? 'раб. день' : 'кал. день'}{row.multiplier && Number(row.multiplier) !== 1 ? ` × ${number(row.multiplier)}` : ''}
      {rates.some(other => other.title === row.title && other.rate !== row.rate) && <small>{dateTime(row.period_start, timezone)} — {dateTime(row.period_end, timezone)}</small>}
    </span>)}
    {sources.map(source => <span className="case-cost-source" key={source}>Источник: {source.replace(/^demo:[^ ]+\s*—\s*/, '')}</span>)}
    {basis.some(row => row.confirmation === 'user_assumption') && <span className="case-cost-source">Ставки заданы как допущение.</span>}
  </>
}

function CostChart({ points, currency, selected, onSelect }: { points: InactionPoint[]; currency: string; selected: number; onSelect: (index: number) => void }) {
  const gradientId = useId()
  const width = 480, height = 225, left = 54, right = 16, top = 26, bottom = 38
  const chartW = width - left - right, chartH = height - top - bottom
  // Number is used for drawing coordinates only. Displayed amounts remain Decimal strings.
  const maxTime = Math.max(...points.map(p => Number(p.work_hours))) || 1
  const maxCost = Math.max(...points.map(p => Number(p.cost)), 1)
  const x = (p: InactionPoint) => left + Number(p.work_hours) / maxTime * chartW
  const y = (p: InactionPoint) => top + chartH - Number(p.cost) / maxCost * chartH
  const line = points.map(p => `${x(p)},${y(p)}`).join(' ')
  const point = points[selected]
  const axisMoney = (value: number) => new Intl.NumberFormat('ru-RU', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  return <svg className="case-cost-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Дополнительные затраты при разной длительности задержки" tabIndex={0}
    onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onSelect(Math.max(0, Math.min(points.length - 1, selected + (event.key === 'ArrowRight' ? 1 : -1)))) } }}
    onPointerDown={event => {
      const rect = event.currentTarget.getBoundingClientRect()
      const target = ((event.clientX - rect.left) / rect.width * width - left) / chartW * maxTime
      onSelect(points.reduce((best, p, index) => Math.abs(Number(p.work_hours) - target) < Math.abs(Number(points[best].work_hours) - target) ? index : best, 0))
    }}
    onPointerMove={event => {
      const rect = event.currentTarget.getBoundingClientRect()
      const target = ((event.clientX - rect.left) / rect.width * width - left) / chartW * maxTime
      const nearest = points.reduce((best, p, index) => Math.abs(Number(p.work_hours) - target) < Math.abs(Number(points[best].work_hours) - target) ? index : best, 0)
      onSelect(nearest)
    }}>
    <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#cf9d3d" stopOpacity=".2" /><stop offset="100%" stopColor="#cf9d3d" stopOpacity="0" /></linearGradient></defs>
    <text x={left} y={13} className="case-cost-axis">Доп. затраты, {currency === 'RUB' ? '₽' : currency}</text>
    {[0, .5, 1].map(ratio => <g key={ratio}><line className="case-cost-grid" x1={left} x2={width - right} y1={top + chartH * (1 - ratio)} y2={top + chartH * (1 - ratio)} /><text x={left - 9} y={top + chartH * (1 - ratio) + 4} textAnchor="end" className="case-cost-axis">{axisMoney(maxCost * ratio)}</text></g>)}
    <polygon points={`${left},${top + chartH} ${line} ${x(points[points.length - 1])},${top + chartH}`} fill={`url(#${gradientId})`} />
    <polyline points={line} fill="none" stroke="#d4ab57" strokeWidth="2.5" strokeLinejoin="round" />
    {[0, .25, .5, .75, 1].map(ratio => <text key={ratio} x={left + chartW * ratio} y={height - 20} textAnchor="middle" className="case-cost-axis">{new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(maxTime * ratio)}</text>)}
    <text x={width - right} y={height - 2} textAnchor="end" className="case-cost-axis">Задержка, раб. ч</text>
    <line x1={x(point)} x2={x(point)} y1={top} y2={top + chartH} stroke="#d4ab57" strokeDasharray="3 4" opacity=".4" />
    <circle cx={x(point)} cy={y(point)} r="4" fill="#d4ab57" stroke="#1c1e22" strokeWidth="2" />
  </svg>
}
