import { useEffect, useState } from 'react'
import type { NotificationDTO } from '../../api/generated/customerControl'
import * as customer from '../customerApi'
import type { ContextDTO } from '../customerApi'
import { ApiError } from '../api'
import { CustomerCase } from './CustomerCases'
import { can, dateTime } from './CustomerWorkspace'
import { notificationTitle } from '../notificationText'

/** An inbox is a record of available events; the case queue remains the place to act. */
export function CustomerNotifications({ context, onAccessChanged, onDocuments }: { context: ContextDTO; onAccessChanged: () => void; onDocuments: () => void }) {
  const [items, setItems] = useState<NotificationDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController(); setLoading(true)
    customer.notifications(context.project_id, controller.signal).then(rows => { if (!controller.signal.aborted) { setItems(rows); setError('') } }).catch(reason => { if (!controller.signal.aborted) { setError(customer.errorMessage(reason)); if (reason instanceof ApiError && (reason.status === 403 || reason.status === 404)) onAccessChanged() } }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [context.project_id, refresh, onAccessChanged])
  return <section>
    <div className="customer-title"><div><h2>Уведомления</h2><p>Последние события, доступные вашему назначению. Рабочие задачи и их состояние находятся в очереди дел.</p></div><button className="btn small" type="button" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Обновить уведомления</button></div>
    {loading && <p role="status">Загружаем уведомления…</p>}
    {error && <div className="customer-notice" data-kind="error" role="alert">{error}{items.length > 0 && ' Показана прежняя лента; обновите доступы.'}</div>}
    {!loading && !error && !items.length && <div className="customer-state"><h3>Доступных уведомлений пока нет</h3><p>Проверяйте рабочую очередь: отсутствие уведомлений не означает, что все дела закрыты.</p></div>}
    <div className="customer-grid">{items.map(item => <article className="customer-card" key={`${item.source}:${item.id}`}><span className="customer-status">{item.source === 'workflow' ? 'Изменение рабочего процесса' : 'Событие наблюдения'}</span><h3>{notificationTitle(item)}</h3><p className="customer-muted">{dateTime(item.occurred_at)}</p>{item.incident_id && can(context, 'incident.read') ? <button className="btn" type="button" onClick={() => setSelected(item.incident_id ?? null)}>Открыть доступное дело</button> : can(context, 'document.read') && context.role === 'pto_engineer' ? <button className="btn" type="button" onClick={onDocuments}>Документы и согласование</button> : null}</article>)}</div>
    {!loading && items.length === 50 && <p className="customer-muted">Показаны последние 50 доступных уведомлений. Полный список дел открыт в рабочей очереди.</p>}
    {selected && <CustomerCase id={selected} context={context} onClose={() => setSelected(null)} onChanged={() => setRefresh(value => value + 1)} onAccessChanged={onAccessChanged} />}
  </section>
}
