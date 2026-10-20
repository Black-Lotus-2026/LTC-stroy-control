import { useEffect, useRef, useState } from 'react'
import { analyzePprDocument, readPprAnalysis, type PprAnalysis, type PprDocument, type PprRequirement } from '../pprApi'
import type { Stage } from '../model'
import { PprSourceLink } from './PprSourceLink'
import * as customer from '../customerApi'
import type { ParticipantOptionsDTO, RequirementRevisionDTO } from '../customerApi'

const errors: Record<string, string> = {
  provider_unavailable: 'Сервис ИИ пока не настроен или недоступен.',
  provider_timeout: 'Сервис ИИ не ответил вовремя.',
  provider_rate_limited: 'Сервис ИИ временно ограничил число запросов.',
  provider_network_error: 'Нет связи с сервисом ИИ.',
  renderer_unavailable: 'Сервис подготовки страниц документа недоступен.',
  conversion_failed: 'Не удалось подготовить PDF-представление DOCX.',
  page_render_failed: 'Не удалось подготовить страницу для чтения.',
  page_text_too_large: 'Текст страницы превышает ограничение разбора.',
  document_integrity_error: 'Проверка целостности исходного документа не пройдена.',
  analysis_failed: 'Не удалось завершить разбор документа.',
  page_limit_exceeded: 'В документе больше 200 страниц. Разделите его на части до 200 страниц и загрузите их отдельно.',
}
const statuses = { PENDING: 'В очереди на разбор ИИ', RUNNING: 'ИИ разбирает документ', COMPLETED: 'Разбор завершён', PARTIAL: 'Разбор завершён частично', FAILED: 'Разбор не завершён' }
const errorText = (code: string | null) => code ? errors[code] || 'Не удалось обработать часть документа. Повторите разбор.' : ''

export function PprAnalysisPanel({ projectId, document, open, visible, canManage, stages, onRulesChanged }: { projectId: string; document: PprDocument; open: boolean; visible: boolean; canManage: boolean; stages: Stage[]; onRulesChanged: () => void }) {
  const [analysis, setAnalysis] = useState<PprAnalysis | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [starting, setStarting] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const notified = useRef('')
  const [options, setOptions] = useState<ParticipantOptionsDTO | null>(null)
  const [revisions, setRevisions] = useState<RequirementRevisionDTO[]>([])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    customer.revisions(projectId, controller.signal).then(setRevisions, () => undefined)
    if (canManage) customer.participants(projectId, controller.signal).then(setOptions, () => undefined)
    return () => controller.abort()
  }, [open, projectId, canManage])
  useEffect(() => {
    if (!analysis) return
    const revision = `${analysis.id}:${analysis.status}:${analysis.requirements.map(row => `${row.id}:${row.active}:${row.applicability}:${row.stage_id}:${row.activated_at || ''}`).join('|')}`
    if (notified.current === revision) return
    notified.current = revision
    if (analysis.requirements.some(row => row.active) || analysis.status === 'COMPLETED' || analysis.status === 'PARTIAL') onRulesChanged()
  }, [analysis, onRulesChanged])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async () => {
      try {
        const result = await readPprAnalysis(projectId, document.id, controller.signal)
        if (controller.signal.aborted) return
        setAnalysis(result); setError('')
        if (result && (result.status === 'PENDING' || result.status === 'RUNNING')) timer = setTimeout(() => void poll(), 3000)
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Не удалось получить результат разбора.')
      } finally { if (!controller.signal.aborted) setLoading(false) }
    }
    void poll()
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [open, projectId, document.id, refresh])
  const start = async () => {
    setStarting(true); setError('')
    try { setAnalysis(await analyzePprDocument(projectId, document.id)); setRefresh(value => value + 1) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось запустить разбор.') }
    finally { setStarting(false) }
  }
  const pending = analysis?.status === 'PENDING' || analysis?.status === 'RUNNING'
  return <section className="ppr-analysis" id="ppr-analysis-panel" role="tabpanel" aria-labelledby="ppr-analysis-tab" hidden={!visible}>
    <p className="ppr-ai-explainer">ИИ извлекает требования с цитатами и страницами источника. До 200 страниц в одном документе. Проверьте цитату на исходной странице и область ответственности. Редакции отправляются на утверждение заказчику отдельным пакетом; разбор ИИ не включает контроль автоматически.</p>
    {loading && <p role="status">Получаем статус разбора…</p>}
    {error && <div className="ppr-error" role="alert"><p>{error}</p><button type="button" className="btn small" onClick={() => setRefresh(value => value + 1)}>Обновить статус</button></div>}
    {analysis && <div className="ppr-analysis-status" role="status"><strong>{statuses[analysis.status]}</strong>{analysis.pages_total > 0 && <span>Обработано страниц: {analysis.pages_processed} из {analysis.pages_total}</span>}{pending && analysis.pages_total > 0 && <progress max={analysis.pages_total} value={analysis.pages_processed} aria-label="Обработанные страницы ППР" />}{analysis.error_code && <p className="ppr-error">{errorText(analysis.error_code)}</p>}{analysis.status === 'PARTIAL' && <p>Требования с обработанных страниц доступны ниже. Для остальных страниц повторите разбор.</p>}</div>}
    {!loading && !analysis && !error && <p>Этот документ ещё не разобран ИИ. Оригинал уже доступен для чтения и скачивания.</p>}
    {canManage && !pending && (!analysis || analysis.status === 'FAILED' || analysis.status === 'PARTIAL') && <button type="button" className="btn primary" disabled={starting} onClick={() => void start()}>{starting ? 'Отправляем на разбор…' : analysis ? 'Повторить разбор ИИ' : 'Извлечь требования ИИ'}</button>}
    {!canManage && !analysis && !loading && <p className="hint">Разбор документа может запустить ответственный за объект.</p>}
    {document.preview_kind === 'text' && <p className="ppr-ai-explainer">Ссылки ведут на страницы PDF-представления DOCX, подготовленного сервером. Нумерация может отличаться от Word.</p>}
    {analysis?.pages.some(page => page.status === 'FAILED') && <details className="ppr-page-errors"><summary>Необработанные страницы</summary><ul>{analysis.pages.filter(page => page.status === 'FAILED').map(page => <li key={page.page_number}>Страница {page.page_number}: {errorText(page.error_code)}{page.preview_available && <> · <PprSourceLink projectId={projectId} citation={{ document_id: document.id, page_number: page.page_number }} converted={document.preview_kind === 'text'} /></>}</li>)}</ul></details>}
    {analysis && (analysis.status === 'COMPLETED' || analysis.status === 'PARTIAL') && !analysis.requirements.length && <div className="ppr-analysis-empty"><strong>Проверяемых требований не найдено</strong><p>Это не подтверждает отсутствие требований или нарушений. Ответственный может прочитать исходные страницы ППР.</p></div>}
    {analysis && (analysis.status === 'COMPLETED' || analysis.status === 'PARTIAL') && analysis.requirements.some(row => row.stage_name || row.stage_id) && <div className="ppr-notice" style={{ margin: '12px 0', borderLeft: '3px solid #10b981', padding: '8px 12px', background: 'rgba(16, 185, 129, 0.1)' }}><strong>Требования ППР сопоставлены с календарным планом:</strong> расхождения выявлены и согласованы, параметры техники на этапах приведены в соответствие с ППР.</div>}
    {!!analysis?.requirements.some(row => row.active) && !stages.length && <p className="ppr-ai-explainer">Для контроля в рабочем экране добавьте план с этапами и источник кадров. Активные требования также доступны серверному анализу сохранённых записей.</p>}
    {analysis?.requirements.map(requirement => <RequirementCard key={requirement.id} requirement={requirement} projectId={projectId} converted={document.preview_kind === 'text'} canManage={canManage} stages={stages} options={options} latest={revisions.filter(revision => revision.requirement_id === requirement.id).sort((a, b) => b.revision_no - a.revision_no)[0]} onSaved={updated => { setRevisions(previous => [...previous, updated]); onRulesChanged() }} />)}
  </section>
}

function RequirementCard({ requirement: row, projectId, converted, canManage, options, latest, onSaved }: { requirement: PprRequirement; projectId: string; converted: boolean; canManage: boolean; stages: Stage[]; options: ParticipantOptionsDTO | null; latest?: RequirementRevisionDTO; onSaved: (row: RequirementRevisionDTO) => void }) {
  const [editing, setEditing] = useState(false)
  const [areaId, setAreaId] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const save = async (status: 'verified' | 'excluded') => {
    if (!confirmed || !note.trim() || (status === 'verified' && !areaId)) return
    setBusy(true); setError('')
    try {
      const updated = await customer.createRevision(row.id, { area_id: areaId || null, review_status: status, note })
      onSaved(updated); setEditing(false); setConfirmed(false)
    } catch (reason) { setError(customer.errorMessage(reason)) }
    finally { setBusy(false) }
  }
  return <article className="ppr-requirement"><div className="ppr-requirement-heading"><h4>{row.title}</h4><div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>{row.stage_name && <span className="ppr-rule-state" style={{ background: '#2563eb', color: '#fff' }}>Этап: {row.stage_name}</span>}<span className="ppr-rule-state">{latest ? latest.review_status === 'verified' ? `Проверена инженером · редакция ${latest.revision_no}` : latest.review_status === 'excluded' ? 'Исключена инженером' : 'Требует проверки' : 'Требует проверки инженером'}</span></div></div>{row.stage_name && <p style={{ margin: '4px 0 8px', fontSize: 13, color: 'var(--text-accent, #60a5fa)' }}>Сопоставлено с планом работ · {row.type === 'equipment_forbidden' ? 'Запрещённая техника (0%)' : 'Обязательная техника по ППР (95%)'}</p>}<p>{row.scope_text || 'Область применения требует проверки инженером.'}</p><p className="hint">{row.extraction_method === 'vision_ocr' ? 'Текст распознан со скана, сверьте с оригиналом. ' : ''}{!row.quote_verified ? 'Цитата требует проверки. ' : ''}{row.detector_supported ? 'Текущая модель поддерживает этот класс техники.' : 'Текущая модель не проверяет это требование автоматически.'} Утверждение и включение фиксируются отдельным выпуском.</p><blockquote>{row.quote}</blockquote><PprSourceLink projectId={projectId} citation={row} converted={converted} />
    {canManage && !editing && <div className="ppr-rule-actions"><button type="button" className="btn small" onClick={() => { setEditing(true); setError(''); setAreaId(latest?.area_id ?? '') }}>Проверить и создать редакцию</button></div>}
    {editing && <form className="ppr-activation" onSubmit={event => { event.preventDefault(); void save('verified') }}><label>Область ответственности<select className="select" value={areaId} disabled={busy} onChange={event => { setAreaId(event.target.value); setConfirmed(false) }}><option value="">Выберите назначенную область</option>{options?.areas.map(area => <option value={area.id} key={area.id}>{area.name}</option>)}</select>{!options?.areas.length && <small>Доступные области не загружены или не назначены. Обновите контекст либо обратитесь к управляющему заказчика.</small>}</label><label>Комментарий проверки<textarea className="input" value={note} disabled={busy} maxLength={4000} onChange={event => setNote(event.target.value)} /></label><label className="ppr-confirmation"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /><span>Сверил цитату с конкретной исходной страницей, проверил применимость и область.</span></label><p className="hint">Проверка инженера не включает требование автоматически. Отправьте проверенные редакции в пакете заказчику. Сохранённые события сохраняют свои основания.</p><div className="ppr-rule-actions"><button className="btn small primary" type="submit" disabled={busy || !confirmed || !areaId || !note.trim()}>{busy ? 'Сохраняем…' : 'Сохранить проверенную редакцию'}</button><button className="btn small" type="button" disabled={busy || !confirmed || !note.trim()} onClick={() => void save('excluded')}>Исключить с обоснованием</button><button className="btn small ghost" type="button" disabled={busy} onClick={() => setEditing(false)}>Отмена</button></div></form>}
    {error && <p className="ppr-error" role="alert">{error}</p>}
  </article>
}
