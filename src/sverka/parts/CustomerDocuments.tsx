import { useCallback, useEffect, useState } from 'react'
import type { ContextDTO, ControlReleaseDTO, RequirementRevisionDTO, ParticipantOptionsDTO } from '../customerApi'
import * as customer from '../customerApi'
import * as api from '../api'
import type { ProjectItem, UserProfile } from '../api'
import { can, dateTime } from './CustomerWorkspace'
import { PprDocuments } from './PprDocuments'
import { CustomerSourceSharing } from './CustomerSourceSharing'
import { listPprDocuments, type PprDocument } from '../pprApi'
import { PprSourceLink } from './PprSourceLink'
import { ApiError } from '../api'
import { CustomerDocumentCases } from './CustomerDocumentCases'

const releaseStatus: Record<ControlReleaseDTO['status'], string> = { draft: 'Черновик', in_review: 'На утверждении заказчиком', changes_requested: 'Возвращён на доработку', scheduled: 'Утверждён · ожидает начала', active: 'Действующий выпуск', retired: 'Завершён', cancelled: 'Отменён' }
export function CustomerDocuments({ context, user }: { context: ContextDTO; user: UserProfile }) {
  const [releases, setReleases] = useState<ControlReleaseDTO[]>([])
  const [revisions, setRevisions] = useState<RequirementRevisionDTO[]>([])
  const [project, setProject] = useState<ProjectItem | null>(null)
  const [documents, setDocuments] = useState<PprDocument[]>([])
  const [options, setOptions] = useState<ParticipantOptionsDTO | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [limitations, setLimitations] = useState('')
  const rulesChanged = useCallback(() => setRefresh(value => value + 1), [])
  useEffect(() => {
    const controller = new AbortController(); setLoading(true)
    Promise.all([customer.releases(context.project_id, controller.signal), customer.revisions(context.project_id, controller.signal), api.projects()]).then(([releaseRows, revisionRows, projects]) => {
      if (controller.signal.aborted) return
      setReleases(releaseRows); setRevisions(revisionRows); setProject(projects.find(item => item.id === context.project_id) ?? null); setError('')
    }).catch(reason => { if (!controller.signal.aborted) setError(customer.errorMessage(reason)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    listPprDocuments(context.project_id, controller.signal).then(setDocuments, () => undefined)
    if (can(context, 'requirement.edit')) customer.participants(context.project_id, controller.signal).then(setOptions, () => undefined)
    return () => controller.abort()
  }, [context, refresh])
  const active = releases.filter(release => release.status === 'active' || release.status === 'scheduled').sort((a, b) => b.sequence - a.sequence)[0]
  const create = async () => {
    setBusy(true); setError(''); setNotice('')
    try { await customer.createRelease(context.project_id, { base_release_id: active?.id ?? null, requirement_revision_ids: selected, limitations: limitations.split('\n').map(value => value.trim()).filter(Boolean) }); setSelected([]); setNotice('Черновик пакета создан. Проверьте состав и отправьте на утверждение.'); rulesChanged() }
    catch (failure) { setError(customer.errorMessage(failure)) }
    finally { setBusy(false) }
  }
  return <>
    <div className="customer-title"><div><h2 style={{ margin: 0 }}>ППР → проверка → утверждение</h2><p>Инженер проверяет цитаты и область. Управляющий заказчика утверждает полный выпуск. Новый документ сохраняет прежний контроль до утверждения.</p></div><button className="btn primary" type="button" disabled={!project} onClick={() => setOpen(true)}>{can(context, 'document.upload') ? 'Открыть / загрузить ППР' : 'Опубликованные документы'}</button></div>
    {error && <div className="customer-notice" data-kind="error" role="alert">{error}<div className="customer-actions"><button type="button" className="btn small" onClick={rulesChanged}>Повторить загрузку</button></div></div>}
    {notice && <p role="status">{notice}</p>}
    {loading && <p role="status">Загружаем версии требований и выпуски…</p>}
    {!loading && !error && !revisions.length && <div className="customer-state"><h3>Проверенных редакций пока нет</h3><p>{can(context, 'requirement.edit') ? 'Откройте ППР, запустите разбор и проверьте каждую цитату на конкретной странице. После проверки отправьте пакет заказчику.' : 'Требования для вашей области ещё не опубликованы.'}</p></div>}
    <div className="customer-grid">{revisions.map(revision => <article className="customer-card" key={revision.id}>
      <span className="customer-status">Редакция №{revision.revision_no} · {revision.review_status === 'verified' ? 'Проверена инженером' : revision.review_status === 'excluded' ? 'Исключена из пакета' : 'Требует проверки'}</span><p>{revision.quote}</p><p className="customer-muted">{revision.check_mode === 'automated' ? 'Поддерживается автоматическая проверка' : 'Проверка человеком'} · {options?.areas.find(area => area.id === revision.area_id)?.name ?? (revision.area_id ? 'Назначенная область' : 'Объект')}</p><PprSourceLink projectId={context.project_id} citation={revision.citation} converted={revision.citation.source_kind === 'converted_pdf'} />
      {can(context, 'control.submit') && revision.review_status !== 'needs_review' && !revisions.some(other => other.requirement_id === revision.requirement_id && other.revision_no > revision.revision_no) && !releases.some(release => release.status !== 'draft' && release.requirement_revision_ids.includes(revision.id)) && !context.is_demo && context.lifecycle === 'active' && <label className="customer-inline-check"><input type="checkbox" checked={selected.includes(revision.id)} onChange={event => setSelected(ids => event.target.checked ? [...ids, revision.id] : ids.filter(id => id !== revision.id))} /><span>{revision.review_status === 'excluded' ? 'Исключить требование из нового набора' : 'Включить в пакет'}</span></label>}
    </article>)}</div>
    {can(context, 'control.submit') && !context.is_demo && context.lifecycle === 'active' && <section className="customer-card customer-form" style={{ marginTop: 22 }}><h3>Новый пакет контроля</h3><p>Выбрано редакций: {selected.length}. Сервер строит полный выпуск поверх действующего, сохраняя недоступные вам требования других организаций.</p><label>Ограничения / непроверенные страницы<textarea value={limitations} onChange={event => setLimitations(event.target.value)} placeholder="Каждое ограничение с новой строки" maxLength={10000} /></label><button type="button" className="btn" disabled={busy || !selected.length} onClick={() => void create()}>{busy ? 'Создаём…' : 'Создать пакет для проверки'}</button></section>}
    <section style={{ marginTop: 28 }}><div className="customer-title"><div><h2>Выпуски контроля</h2><p>Утверждение, автоматическая поддержка и срок действия — разные состояния.</p></div><button className="btn small" type="button" disabled={loading} onClick={rulesChanged}>Обновить</button></div><div className="customer-grid">{releases.map(release => <Release key={`${release.id}:${release.row_version}`} release={release} base={releases.find(item => item.id === release.base_release_id)} revisions={revisions} context={context} onChanged={rulesChanged} />)}</div>{!loading && !error && !releases.length && <p className="customer-muted">Выпусков контроля пока нет. Сам по себе результат ИИ не включает требования в контроль.</p>}</section>
    {can(context, 'evidence.publish') && context.lifecycle === 'active' && !context.is_demo && <CustomerSourceSharing context={context} kind="document" items={documents.map(doc => ({ id: doc.id, name: `${doc.filename}${doc.version_no ? ` · версия ${doc.version_no}` : ''}` }))} />}
    {context.role === 'pto_engineer' && <CustomerDocumentCases context={context} revisions={revisions} />}
    {project && <PprDocuments key={`${context.assignment_id}:${context.authorization_version}`} project={project} user={user} requiresArea={context.side === 'contractor'} permissions={context.lifecycle === 'active' && !context.is_demo ? context.effective_permissions : []} stages={[]} open={open} onClose={() => { setOpen(false); rulesChanged() }} onRulesChanged={rulesChanged} />}
  </>
}
function Release({ release, base, revisions, context, onChanged }: { release: ControlReleaseDTO; base?: ControlReleaseDTO; revisions: RequirementRevisionDTO[]; context: ContextDTO; onChanged: () => void }) {
  const [note, setNote] = useState('')
  const [date, setDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflicted, setConflicted] = useState(false)
  const [reviewed, setReviewed] = useState(false)
  const [stopConfirmed, setStopConfirmed] = useState(false)
  const added = release.requirement_revision_ids.filter(id => !base?.requirement_revision_ids.includes(id))
  const removed = (base?.requirement_revision_ids ?? []).filter(id => !release.requirement_revision_ids.includes(id))
  const writable = !context.is_demo && context.lifecycle === 'active' && !conflicted
  const run = async (action: 'submit' | 'approve' | 'return' | 'retire') => {
    if (busy || !writable) return
    setBusy(true); setError('')
    try {
      if (action === 'submit') await customer.submitRelease(release.id, { expected_version: release.row_version })
      else if (action === 'return') await customer.returnRelease(release.id, { expected_version: release.row_version, note })
      else if (action === 'retire') await customer.retireRelease(release.id, { expected_version: release.row_version, note })
      else if (date && release.manifest_sha256) await customer.approveRelease(release.id, { expected_version: release.row_version, manifest_sha256: release.manifest_sha256, effective_from: new Date(date).toISOString(), note })
      onChanged()
    } catch (failure) { setError(customer.errorMessage(failure)); if (failure instanceof ApiError && failure.status === 409) setConflicted(true) }
    finally { setBusy(false) }
  }
  return <article className="customer-card"><span className="customer-status">{releaseStatus[release.status]}</span><h3>Выпуск №{release.sequence}</h3><p>Редакций требований: {release.requirement_revision_ids.length}</p><p className="customer-muted">Начало: {dateTime(release.effective_from)}{release.effective_until ? ` · Завершение: ${dateTime(release.effective_until)}` : ''}</p>{release.approved_at && <p className="customer-muted">Утверждён заказчиком {dateTime(release.approved_at)}</p>}{release.note && <p>{release.note}</p>}{release.limitations.length > 0 && <div><strong>Ограничения выпуска</strong><ul>{release.limitations.map((value, index) => <li key={index}>{value}</li>)}</ul></div>}{release.base_release_id && <p className="customer-muted">Состав построен поверх предыдущего выпуска. Исторические основания событий сохраняются.</p>}
    {writable && can(context, 'control.submit') && release.status === 'draft' && <button className="btn" type="button" disabled={busy} onClick={() => void run('submit')}>Отправить на утверждение</button>}
    {release.status === 'changes_requested' && <p className="customer-muted">Сохраните новые редакции требований с учётом замечаний и создайте следующий пакет. Этот отправленный снимок не редактируется.</p>}
    {writable && can(context, 'control.approve') && release.status === 'in_review' && <div className="customer-form"><details><summary>Сравнение с предыдущим выпуском: добавлено {added.length}, исключено {removed.length}</summary><ul>{added.map(id => <li key={id}>Добавлено: {revisions.find(item => item.id === id)?.quote ?? "Редакция недоступна в текущем назначении"}</li>)}{removed.map(id => <li key={id}>Исключено: {revisions.find(item => item.id === id)?.quote ?? "Редакция недоступна в текущем назначении"}</li>)}</ul></details><label className="customer-check"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /><span>Проверил полный состав, изменения и ограничения пакета.</span></label><label>Включить с (местное время)<input type="datetime-local" value={date} onChange={event => setDate(event.target.value)} /></label><label>Основание решения<textarea maxLength={4000} value={note} onChange={event => setNote(event.target.value)} /></label><div className="customer-actions"><button className="btn primary" type="button" disabled={busy || !reviewed || !date || !note.trim() || !release.manifest_sha256} onClick={() => void run('approve')}>Утвердить и включить</button><button className="btn" type="button" disabled={busy || !note.trim()} onClick={() => void run('return')}>Вернуть с замечанием</button></div></div>}
    {writable && can(context, 'control.retire') && (release.status === 'active' || release.status === 'scheduled') && <details className="customer-form"><summary>Остановить выпуск контроля</summary><p>Новые проверки по этому выпуску прекратятся. Основания уже созданных дел сохранятся. Следующий выпуск потребует отдельного утверждения.</p><label>Основание остановки<textarea maxLength={4000} value={note} onChange={event => setNote(event.target.value)} /></label><label className="customer-check"><input type="checkbox" checked={stopConfirmed} onChange={event => setStopConfirmed(event.target.checked)} /><span>Подтверждаю остановку этого выпуска контроля.</span></label><button className="btn" type="button" disabled={busy || !note.trim() || !stopConfirmed} onClick={() => void run('retire')}>Остановить выпуск</button></details>}
    {error && <p className="ppr-error" role="alert">{error}</p>}
  </article>
}
