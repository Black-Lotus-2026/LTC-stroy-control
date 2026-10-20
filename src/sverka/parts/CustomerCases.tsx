import { useCallback, useEffect, useRef, useState } from 'react'
import * as customer from '../customerApi'
import type { ContextDTO, IncidentDTO, IncidentDetailDTO, IncidentCommand, EvidenceDTO, ParticipantOptionsDTO } from '../customerApi'
import { can, dateTime } from './CustomerWorkspace'
import { PprSourceLink } from './PprSourceLink'
import { CloseIcon } from './common'
import { ApiError } from '../api'

export const caseStatus = (incident: IncidentDTO) => incident.status === 'pending' ? 'Обнаружено системой — требуется проверка' : incident.status === 'confirmed' ? 'Нарушение подтверждено' : incident.status === 'in_progress' ? 'В работе' : incident.status === 'remediation_submitted' ? 'Устранение заявлено — ожидает приёмки' : incident.status === 'false_positive' ? 'Обнаружение отклонено' : incident.resolution_origin === 'customer_accepted' ? 'Устранение принято заказчиком' : 'Закрыто по прежнему процессу; приёмка заказчиком не зафиксирована'
const verification = { pending: 'Дополнительная проверка не запрошена', not_requested: 'Дополнительная проверка не запрошена', queued: 'Дополнительная проверка в очереди', passed: 'На проверочной записи признак не обнаружен', failed: 'Признак сохраняется', unavailable: 'Недостаточно данных для дополнительной проверки' }
const reasonLabels = { wrong_detection: 'Ошибочное обнаружение', wrong_requirement: 'Неверное требование', wrong_scope: 'Неверная область', insufficient_evidence: 'Недостаточно доказательств', other: 'Другая причина', not_an_incident: 'Не является нарушением' }
type Filter = 'open' | IncidentDTO['status'] | 'all' | 'disputed'

export function CustomerCases({ context, onAccessChanged, compact = false, onAll }: { context: ContextDTO; onAccessChanged: () => void; compact?: boolean; onAll?: () => void }) {
  const [items, setItems] = useState<IncidentDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<Filter>(!compact && context.role === 'customer_manager' ? 'pending' : 'open')
  const [selected, setSelected] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [asOf, setAsOf] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController(); setLoading(true)
    customer.incidents(context.project_id, controller.signal).then(result => { if (!controller.signal.aborted) { setItems(result); setError(''); setAsOf(new Date().toISOString()) } }).catch(reason => { if (!controller.signal.aborted) { setError(customer.errorMessage(reason)); if (reason instanceof ApiError && reason.status === 403) onAccessChanged() } }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [context.project_id, refresh, onAccessChanged])
  useEffect(() => { if (!compact) return; const timer = setInterval(() => setRefresh(value => value + 1), 30_000); return () => clearInterval(timer) }, [compact])
  const shown = items.filter(item => filter === 'all' || (filter === 'disputed' ? (item.open_dispute_count ?? 0) > 0 : filter === 'open' ? !['resolved', 'false_positive'].includes(item.status) : item.status === filter))
  const filters: { key: Filter; label: string }[] = [{ key: 'open', label: 'Открытые' }, ...(context.role === 'customer_manager' ? [{ key: 'pending' as const, label: 'Проверить обнаружения' }, { key: 'disputed' as const, label: 'Споры' }] : []), { key: 'confirmed', label: 'Назначенные' }, { key: 'in_progress', label: 'В работе / возвращены' }, { key: 'remediation_submitted', label: 'Ожидают приёмки' }, { key: 'all', label: 'Все' }]
  if (compact) return <section className="panel queue customer-task-queue" id="queue" aria-label={context.role === 'contractor_foreman' ? 'Мои задачи' : 'Риски и решения'}>
    <div className="queue-head"><span className="kicker">{context.role === 'contractor_foreman' ? 'Мои задачи' : 'Риски и решения'}<span className="count">{asOf ? shown.length : '…'}</span></span><button className="btn ghost small" type="button" onClick={onAll}>Все дела</button></div>
    <div className="role-queue-filter"><select aria-label="Фильтр рабочих дел" value={filter} onChange={event => setFilter(event.target.value as Filter)}>{filters.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</select><button type="button" className="link" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Обновить</button></div>
    {error && <p className="q-empty err-line" role="alert">{error} {items.length > 0 && 'Показан прежний список.'}</p>}
    {loading && !asOf && <p className="q-empty" role="status">Загружаем доступные дела…</p>}
    {!loading && !error && !shown.length && <p className="q-empty">По выбранному фильтру дел нет. Выберите другой фильтр.</p>}
    <div className="q-list">{shown.map(item => <div className="q-item" key={item.id}><button className="q-card role-q-card" type="button" onClick={() => setSelected(item.id)} data-sev={item.status === 'pending' || item.status === 'remediation_submitted' || (item.open_dispute_count ?? 0) > 0 ? 'err' : 'info'}><span className="sev" /><span><span className="q-title">{item.title || item.code}<span className="mono">{item.code}</span></span><span className="q-sub">{caseStatus(item)}</span>{(item.open_dispute_count ?? 0) > 0 && <span className="q-sub">Открытых споров: {item.open_dispute_count}</span>}<Deadlines incident={item} /></span></button></div>)}</div>
    {asOf && <div className="q-hint">Данные на {dateTime(asOf)}. Доступны только дела вашего назначения.</div>}
    {selected && <CustomerCase key={selected} id={selected} context={context} onClose={() => setSelected(null)} onChanged={() => setRefresh(value => value + 1)} onAccessChanged={onAccessChanged} />}
  </section>
  return <>
    <div className="customer-filters" aria-label="Фильтр дел">{filters.map(item => <button className="btn small" type="button" key={item.key} aria-pressed={filter === item.key} onClick={() => setFilter(item.key)}>{item.label}</button>)}</div>
    <div className="customer-meta" style={{ marginBottom: 16 }}><span>{asOf ? `Данные на ${dateTime(asOf)}` : 'Данные ещё не получены'}</span><button type="button" className="link" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Обновить очередь</button></div>
    {loading && <p role="status">Загружаем доступные дела…</p>}
    {error && <div className="customer-notice" data-kind="error" role="alert">{error}{items.length > 0 && ' Показан прежний список; данные могут быть устаревшими.'}</div>}
    {!loading && !error && !shown.length && <div className="customer-state"><h2>По выбранному фильтру дел нет</h2><p>Попробуйте другой фильтр. Этот список показывает ваши доступные дела и не подтверждает безопасность всего объекта.</p></div>}
    <div className="customer-grid">{shown.map(item => <article className="customer-card" key={item.id}><span className="customer-status">{caseStatus(item)}</span><h2>{item.title || item.code}</h2>{(item.open_dispute_count ?? 0) > 0 && <p className="customer-status">Открытых споров: {item.open_dispute_count}</p>}<div className="customer-meta"><span>{item.code}</span><span>Наблюдение: {dateTime(item.first_seen_at)}</span><span>Поступило: {dateTime(item.detected_at)}</span></div><Deadlines incident={item} /><button type="button" className="btn" onClick={() => setSelected(item.id)}>Открыть дело</button></article>)}</div>
    {selected && <CustomerCase key={selected} id={selected} context={context} onClose={() => setSelected(null)} onChanged={() => setRefresh(value => value + 1)} onAccessChanged={onAccessChanged} />}
  </>
}
function Deadlines({ incident }: { incident: IncidentDTO }) { return <div className="customer-meta">{incident.status === 'pending' && <span>Проверить заказчику до {dateTime(incident.reaction_due_at)}</span>}{incident.remediation_due_at && <span>Подать исправление до {dateTime(incident.remediation_due_at)}</span>}{incident.review_due_at && <span>Принять заказчику до {dateTime(incident.review_due_at)}</span>}</div> }

export function CustomerCase({ id, context, onClose, onChanged, onAccessChanged }: { id: string; context: ContextDTO; onClose: () => void; onChanged: () => void; onAccessChanged: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [detail, setDetail] = useState<IncidentDetailDTO | null>(null)
  const [options, setOptions] = useState<ParticipantOptionsDTO | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflicted, setConflicted] = useState(false)
  const [note, setNote] = useState('')
  const [evidence, setEvidence] = useState<string[]>([])
  const [participationId, setParticipationId] = useState('')
  const [assignmentId, setAssignmentId] = useState('')
  const [areaId, setAreaId] = useState('')
  const [due, setDue] = useState('')
  const [pauseUntil, setPauseUntil] = useState('')
  const [reason, setReason] = useState<'wrong_detection' | 'wrong_requirement' | 'wrong_scope' | 'insufficient_evidence' | 'other'>('wrong_detection')
  const [notice, setNotice] = useState('')
  const [publishEvidence, setPublishEvidence] = useState<string[]>([])
  const [publishRevisions, setPublishRevisions] = useState<string[]>([])
  const [publicationConfirmed, setPublicationConfirmed] = useState(false)
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await customer.incident(id, signal)
      if (signal?.aborted) return
      setDetail(result); setConflicted(false); setError(''); setEvidence([])
    } catch (failure) { if (!signal?.aborted) setError(customer.errorMessage(failure)) }
  }, [id])
  useEffect(() => {
    const element = dialog.current; element?.showModal()
    const controller = new AbortController(); void load(controller.signal)
    if (can(context, 'incident.assign')) customer.participants(context.project_id, controller.signal).then(setOptions, failure => { if (!controller.signal.aborted) setError(customer.errorMessage(failure)) })
    return () => { controller.abort(); element?.close() }
  }, [context, load])
  const incident = detail?.incident
  const allowed = (permission: ContextDTO['effective_permissions'][number]) => !conflicted && !context.is_demo && context.lifecycle === 'active' && !!incident?.allowed_actions.includes(permission)
  const run = async (fn: () => Promise<unknown>) => {
    if (busy || conflicted) return
    setBusy(true); setError(''); setNotice('')
    try { await fn(); await load(); setNote(''); setNotice('Решение сохранено сервером.'); onChanged() }
    catch (failure) { setError(customer.errorMessage(failure)); if (failure instanceof ApiError && failure.status === 409) setConflicted(true); if (failure instanceof ApiError && failure.status === 403) { onClose(); onAccessChanged() } }
    finally { setBusy(false) }
  }
  const act = (command: IncidentCommand) => run(() => customer.command(id, command))
  const upload = (file?: File) => {
    if (!file || !incident) return
    if (file.size > 50 * 1024 * 1024) { setError('Материал больше 50 МБ.'); return }
    void run(async () => { const asset = await customer.uploadEvidence(id, file, incident.row_version); setEvidence(ids => [...ids, asset.id]) })
  }
  const latest = detail?.submissions.at(-1)
  const basis = incident?.basis
  const citations = incident?.view === 'customer' ? incident.basis?.citations ?? [] : []
  const visibleCitations = incident?.view === 'contractor' ? incident.basis.visible_citations : []
  const coverage = incident?.view === 'customer' ? incident.basis?.coverage.status : incident?.view === 'contractor' ? incident.basis.coverage_status : undefined
  const ready = !busy && !conflicted && !!note.trim()
  return <dialog ref={dialog} className="customer-dialog" aria-labelledby="customer-case-title" onCancel={event => { event.preventDefault(); onClose() }}>
    <header className="customer-dialog-head"><div><span className="kicker">{incident?.code || 'Дело'}</span><h2 id="customer-case-title">{incident?.title || 'Загружаем дело…'}</h2></div><button className="close-x" type="button" aria-label="Закрыть дело" onClick={onClose}><CloseIcon /></button></header>
    <div className="customer-dialog-body">
      {error && <div className="customer-notice" data-kind="error" role="alert">{error}<div className="customer-actions"><button className="btn" type="button" onClick={() => void load()}>Обновить дело</button></div></div>}
      {notice && <p role="status">{notice}</p>}
      {!detail && !error && <p role="status">Загружаем основание, материалы и решения…</p>}
      {detail && incident && <>
        <section><p className="customer-status">{caseStatus(incident)}</p><p>Снято: {dateTime(incident.first_seen_at)} · Поступило: {dateTime(incident.detected_at)}</p><Deadlines incident={incident} />{incident.deadline_paused_until && <p className="customer-status">Отсчёт срока приостановлен до {dateTime(incident.deadline_paused_until)}. История срока сохранена.</p>}<p>{verification[incident.verification_status]}</p>{coverage !== 'sufficient' && <p className="customer-notice">{coverage === 'insufficient' ? 'Недостаточное покрытие' : 'Покрытие не установлено'}: отрицательные выводы об отсутствии техники недоступны.</p>}{(basis?.limitations ?? []).map((limitation, index) => <p className="customer-muted" key={index}>{limitation}</p>)}</section>
        <section><h3>Основание ППР</h3>{citations.map(citation => <article key={citation.requirement_revision_id}><blockquote>{citation.quote}</blockquote><PprSourceLink projectId={incident.project_id} citation={citation} converted={citation.source_kind === 'converted_pdf'} /><p className="customer-muted">Версия источника SHA256 {citation.document_sha256.slice(0, 12)}…</p></article>)}{visibleCitations.map(citation => <article key={citation.requirement_revision_id}><strong>{citation.document_title}</strong><blockquote>{citation.quote}</blockquote><p>Страница {citation.page_number} · SHA256 {citation.document_sha256.slice(0, 12)}…</p><PprSourceLink projectId={incident.project_id} citation={{ document_id: "", page_number: citation.page_number, source_url: `/api/v1/customer-control/incidents/${incident.id}/ppr-sources/${citation.requirement_revision_id}` }} /><p className="customer-muted">Доступна только опубликованная исходная страница. Полный оригинал открывается отдельным разрешением.</p></article>)}{!citations.length && !visibleCitations.length && <p className="customer-muted">В доступном основании нет цитат ППР. Для исторического дела исходные материалы сохраняются в истории.</p>}</section>
        <section><h3>Доказательства и материалы</h3><div className="customer-evidence">{detail.evidence.map(asset => <Evidence key={asset.id} asset={asset} />)}</div>{!detail.evidence.length && <p className="customer-muted">Опубликованных материалов пока нет.</p>}{allowed('evidence.append') && <label className="customer-form">Добавить материал<input type="file" accept="image/*,application/pdf,video/mp4" disabled={busy} onChange={event => { upload(event.target.files?.[0]); event.target.value = '' }} /><small className="customer-muted">Загрузка пользователя. Время из EXIF не считается подтверждённым временем съёмки.</small></label>}</section>
        {detail.submissions.length > 0 && <section><h3>Подачи устранения</h3>{detail.submissions.map(submission => <article className="customer-card" key={submission.id}><strong>Подача №{submission.sequence} · {dateTime(submission.submitted_at)}</strong><p>{submission.note}</p><p className="customer-muted">Материалов: {submission.evidence_ids.length}</p><div className="customer-evidence">{detail.evidence.filter(asset => submission.evidence_ids.includes(asset.id)).map(asset => <Evidence key={asset.id} asset={asset} />)}</div>{submission.review && <p>{submission.review.outcome === 'accepted' ? 'Принято заказчиком' : 'Возвращено на доработку'} · {submission.review.note} · {dateTime(submission.review.decided_at)}</p>}</article>)}</section>}
        {allowed('evidence.publish') && incident.responsible_participation_id && <section className="customer-form"><h3>Публикация подрядчику</h3><p>Подтверждение само по себе не раскрывает материалы. Опубликуйте карточку и выбранные доказательства ответственной организации; оригинал ППР и вся запись при этом не открываются.</p><fieldset><legend>Доказательства для ответственной организации</legend>{detail.evidence.map(asset => <label className="customer-check" key={asset.id}><input type="checkbox" checked={publishEvidence.includes(asset.id)} onChange={event => setPublishEvidence(ids => event.target.checked ? [...ids, asset.id] : ids.filter(id => id !== asset.id))} /><span>{asset.source === 'upload' ? 'Материал пользователя' : 'Кадр / источник'} · {dateTime(asset.received_at)} · {asset.sha256.slice(0, 10)}…</span></label>)}{citations.map(citation => <label className="customer-check" key={citation.requirement_revision_id}><input type="checkbox" checked={publishRevisions.includes(citation.requirement_revision_id)} onChange={event => setPublishRevisions(ids => event.target.checked ? [...ids, citation.requirement_revision_id] : ids.filter(id => id !== citation.requirement_revision_id))} /><span>Цитата ППР · страница {citation.page_number}</span></label>)}</fieldset><label className="customer-check"><input type="checkbox" checked={publicationConfirmed} onChange={event => setPublicationConfirmed(event.target.checked)} /><span>Проверил выбранные материалы и разрешаю их раскрытие ответственной организации.</span></label><button className="btn" type="button" disabled={busy || !publicationConfirmed || (!publishEvidence.length && !publishRevisions.length)} onClick={() => void run(() => customer.discloseEvidence(id, { expected_version: incident.row_version, participation_id: incident.responsible_participation_id!, evidence_ids: publishEvidence, revision_ids: publishRevisions }))}>Опубликовать карточку и выбранные материалы</button></section>}
        <section className="customer-form"><h3>Действия по делу</h3>
          {(allowed('incident.confirm') || allowed('incident.assign') || allowed('incident.deadline')) && <><label>Ответственный подрядчик<select value={participationId} onChange={event => { setParticipationId(event.target.value); setAssignmentId('') }}><option value="">Выберите организацию</option>{options?.participations.filter(item => incident.case_kind === 'control_integrity' || item.id !== context.participation_id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Исполнитель<select value={assignmentId} onChange={event => setAssignmentId(event.target.value)}><option value="">Без персонального исполнителя</option>{options?.assignments.filter(item => item.participation_id === participationId && item.role === (incident.case_kind === 'control_integrity' && participationId === context.participation_id ? 'customer_manager' : 'contractor_foreman')).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Область ответственности<select value={areaId} onChange={event => setAreaId(event.target.value)}><option value="">Выберите область</option>{options?.areas.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Срок подачи исправления<input type="datetime-local" value={due} onChange={event => setDue(event.target.value)} /></label></>}
          {allowed('incident.deadline') && ['confirmed', 'in_progress'].includes(incident.status) && <label>Приостановить отсчёт до<input type="datetime-local" value={pauseUntil} onChange={event => setPauseUntil(event.target.value)} /></label>}
          {(allowed('remediation.submit') || allowed('dispute.open')) && <fieldset><legend>Материалы конкретной подачи</legend>{detail.evidence.filter(asset => asset.integrity === 'verified' && (allowed('remediation.submit') ? asset.can_submit === true : true)).map(asset => <label key={asset.id} className="customer-check"><input type="checkbox" checked={evidence.includes(asset.id)} onChange={event => setEvidence(ids => event.target.checked ? [...ids, asset.id] : ids.filter(id => id !== asset.id))} /><span>{asset.source === 'upload' ? 'Загруженный материал' : 'Доказательство'} · {dateTime(asset.received_at)} · {asset.sha256.slice(0, 10)}…</span></label>)}</fieldset>}
          {(allowed('dispute.open') || allowed('incident.dismiss')) && <label>Причина<select value={reason} onChange={event => setReason(event.target.value as typeof reason)}>{(['wrong_detection', 'wrong_requirement', 'wrong_scope', 'insufficient_evidence', 'other'] as const).map(value => <option value={value} key={value}>{reasonLabels[value]}</option>)}</select></label>}
          {(incident.allowed_actions.length > 0 && !context.is_demo) && <label>Комментарий / описание исправления<textarea value={note} onChange={event => setNote(event.target.value)} maxLength={4000} disabled={busy || conflicted} /></label>}
          <div className="customer-actions">
            {allowed('incident.confirm') && <button type="button" className="btn primary" disabled={!ready || !participationId || (!areaId && incident.case_kind === 'construction') || !due} onClick={() => void act({ action: 'confirm', expected_version: incident.row_version, responsible_participation_id: participationId, assignee_assignment_id: assignmentId || null, area_id: areaId || null, remediation_due_at: new Date(due).toISOString(), note })}>Подтвердить и назначить</button>}
            {allowed('incident.assign') && !allowed('incident.confirm') && <button type="button" className="btn" disabled={!ready || !participationId || (!areaId && incident.case_kind === 'construction')} onClick={() => void run(() => customer.assignIncident(id, { expected_version: incident.row_version, responsible_participation_id: participationId, assignee_assignment_id: assignmentId || null, area_id: areaId || null, note }))}>Изменить ответственного с записью истории</button>}
            {allowed('incident.deadline') && !allowed('incident.confirm') && <button type="button" className="btn" disabled={!ready || !due} onClick={() => void run(() => customer.changeDeadline(id, { expected_version: incident.row_version, remediation_due_at: new Date(due).toISOString(), reason: note }))}>Изменить срок с обоснованием</button>}
            {allowed('incident.deadline') && ['confirmed', 'in_progress'].includes(incident.status) && <button type="button" className="btn" disabled={!ready || !pauseUntil} onClick={() => void run(() => customer.pauseDeadline(id, { expected_version: incident.row_version, until: new Date(pauseUntil).toISOString(), reason: note }))}>Приостановить срок с основанием</button>}
            {allowed('incident.dismiss') && <button type="button" className="btn" disabled={!ready} onClick={() => void act({ action: 'dismiss', expected_version: incident.row_version, reason: reason === 'other' ? 'not_an_incident' : reason, note })}>Отклонить обнаружение</button>}
            {allowed('incident.start') && incident.status === 'confirmed' && <button type="button" className="btn primary" disabled={busy} onClick={() => void act({ action: 'start', expected_version: incident.row_version })}>Принять в работу</button>}
            {allowed('remediation.submit') && <button type="button" className="btn primary" disabled={!ready || !evidence.length} onClick={() => void act({ action: 'submit_remediation', expected_version: incident.row_version, note, evidence_ids: evidence })}>Передать на приёмку</button>}
            {allowed('remediation.accept') && latest && <button type="button" className="btn primary" disabled={!ready} onClick={() => void act({ action: 'accept_remediation', expected_version: incident.row_version, submission_id: latest.id, note })}>Принять подачу №{latest.sequence}</button>}
            {allowed('remediation.return') && latest && <button type="button" className="btn" disabled={!ready} onClick={() => void act({ action: 'return_remediation', expected_version: incident.row_version, submission_id: latest.id, note, new_remediation_due_at: null })}>Вернуть с замечанием</button>}
            {allowed('incident.comment') && <button type="button" className="btn" disabled={!ready} onClick={() => void run(() => customer.commentOnCase(id, { expected_version: incident.row_version, note }))}>Сохранить комментарий</button>}
            {allowed('dispute.open') && <button type="button" className="btn" disabled={!ready} onClick={() => void run(() => customer.openDispute(id, { expected_version: incident.row_version, note, reason, evidence_ids: evidence }))}>Оспорить</button>}
          </div>{context.lifecycle === 'archived' && <p className="customer-muted">Объект в архиве · только просмотр. Открытые дела сохраняют свой статус.</p>}{!incident.allowed_actions.length && <p className="customer-muted">В этом состоянии и назначении вам доступен просмотр. Решения принимает уполномоченный управляющий заказчика.</p>}
        </section>
        {detail.disputes.length > 0 && <section><h3>Споры</h3>{detail.disputes.map(dispute => <article className="customer-card" key={dispute.id}><strong>{reasonLabels[dispute.reason]} · {dispute.status === 'open' ? 'Открыт' : dispute.status === 'upheld' ? 'Признан' : dispute.status === 'rejected' ? 'Отклонён' : 'Отозван'}</strong><p>{dispute.note}</p>{dispute.status === 'open' && dispute.author_assignment_id === context.assignment_id && allowed('dispute.open') && <button type="button" className="btn" disabled={!ready} onClick={() => void run(() => customer.withdrawDispute(dispute.id, { expected_version: dispute.row_version, note }))}>Отозвать спор с комментарием</button>}{dispute.status === 'open' && allowed('dispute.decide') && <div className="customer-actions"><button type="button" className="btn" disabled={!ready} onClick={() => void run(() => customer.decideDispute(dispute.id, { expected_version: dispute.row_version, incident_expected_version: incident.row_version, outcome: 'upheld', correction: 'dismiss_incident', note }))}>Признать спор: отменить факт</button><button type="button" className="btn" disabled={!ready} onClick={() => void run(() => customer.decideDispute(dispute.id, { expected_version: dispute.row_version, incident_expected_version: incident.row_version, outcome: 'rejected', correction: 'none', note }))}>Отклонить с мотивировкой</button></div>}</article>)}</section>}
        <section><h3>История решений</h3>{detail.history.length ? <ol className="customer-timeline">{detail.history.map((item, index) => <li key={index}>{item === 'status_changed' ? 'Статус дела изменён' : item}</li>)}</ol> : <p className="customer-muted">{context.side === 'contractor' ? 'Подробная история решений доступна заказчику. Опубликованные подачи и ответы показаны выше.' : 'В доступной истории пока нет записей.'}</p>}</section>
      </>}
    </div>
  </dialog>
}
function Evidence({ asset }: { asset: EvidenceDTO }) {
  const [url, setUrl] = useState(''); const [error, setError] = useState('')
  useEffect(() => { const controller = new AbortController(); let local = ''; customer.evidenceBlob(asset.id, controller.signal).then(blob => { if (!controller.signal.aborted) { local = URL.createObjectURL(blob); setUrl(local) } }).catch(reason => { if (!controller.signal.aborted) setError(customer.errorMessage(reason)) }); return () => { controller.abort(); if (local) URL.revokeObjectURL(local) } }, [asset.id])
  return <figure>{error ? <p role="alert">{error}</p> : url ? asset.media_type.startsWith('image/') ? <a href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt="Материал дела" /></a> : <a className="btn" href={url} target="_blank" rel="noopener noreferrer">Открыть материал</a> : <p role="status">Получаем материал…</p>}<figcaption>{asset.source === 'upload' ? 'Загружено пользователем' : 'Источник наблюдения'} · получено {dateTime(asset.received_at)}{asset.captured_at ? ` · заявленное время съёмки ${dateTime(asset.captured_at)}` : ''} · SHA256 {asset.sha256.slice(0, 12)}…</figcaption></figure>
}
