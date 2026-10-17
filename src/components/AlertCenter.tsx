import { useEffect, useState } from 'react'
import {
  type AlertNotificationItem,
  type IncidentEventItem,
  fetchIncidentEvents,
} from '../api/stroyControlApi'

interface AlertCenterProps {
  error?: string
  onRetry: () => void
  canAct: boolean
  canOpen: (alert: AlertNotificationItem) => boolean
  alerts: AlertNotificationItem[]
  loading: boolean
  onRead: (alert: AlertNotificationItem) => void
  onAction: (alert: AlertNotificationItem, status: string) => Promise<void>
  onOpen: (alert: AlertNotificationItem) => void
}

function deadlineText(value: string | null, now: number, status?: string): string {
  if (status === 'resolved' || status === 'false_positive') return 'Закрыто'
  if (!value) return 'Срок не задан'
  const remaining = new Date(value).getTime() - now
  const minutes = Math.ceil(Math.abs(remaining) / 60000)
  const hours = Math.floor(minutes / 60)
  const label = `${hours > 0 ? `${hours} ч ` : ''}${minutes % 60} мин`
  return remaining < 0 ? `Просрочено на ${label}` : `Осталось ${label}`
}

export function AlertCenter({ alerts, loading, error, onRetry, canAct, canOpen, onRead, onAction, onOpen }: AlertCenterProps) {
  const [filter, setFilter] = useState<'all' | 'assigned' | 'escalated'>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [events, setEvents] = useState<IncidentEventItem[]>([])
  const [busy, setBusy] = useState(false)
  const [eventsError, setEventsError] = useState('')
  const [eventsLoading, setEventsLoading] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let cancelled = false
    setEvents([]); setEventsError('')
    if (!selected) return
    setEventsLoading(true)
    fetchIncidentEvents(selected).then(items => { if (!cancelled) setEvents(items) })
      .catch(() => { if (!cancelled) setEventsError('Не удалось загрузить историю') })
      .finally(() => { if (!cancelled) setEventsLoading(false) })
    return () => { cancelled = true }
  }, [selected, alerts])

  const visible = alerts.filter((alert) => filter === 'all' || alert.kind === filter)
  const selectedAlert = alerts.find((alert) => alert.incident_id === selected)

  const takeAction = async (alert: AlertNotificationItem, status: string) => {
    setBusy(true)
    try {
      await onAction(alert, status)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="alert-center">
      <section className="alert-list panel">
        <div className="alert-heading">
          <div>
            <h2>Задачи и эскалации</h2>
          </div>
          <span className="alert-unread">{alerts.filter((item) => !item.read_at).length} новых</span>
        </div>
        <div className="alert-filters">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Все ({alerts.length})</button>
          <button className={filter === 'assigned' ? 'active' : ''} onClick={() => setFilter('assigned')}>Мои задачи</button>
          <button className={filter === 'escalated' ? 'active' : ''} onClick={() => setFilter('escalated')}>Эскалации</button>
        </div>
        {error && <div className="workspace-error" role="alert">{error}<button className="button" onClick={onRetry}>Повторить</button></div>}
        {loading && alerts.length === 0 && <p className="alert-empty">Загрузка алертов…</p>}
        {!loading && !error && visible.length === 0 && <p className="alert-empty">Задач пока нет.</p>}
        <div className="alert-items">
          {visible.map((alert) => {
            const overdue = Boolean(alert.sla_deadline && new Date(alert.sla_deadline).getTime() < now && alert.incident_status !== 'resolved')
            return (
              <button
                key={alert.id}
                className={`alert-item ${selected === alert.incident_id ? 'selected' : ''} ${!alert.read_at ? 'unread' : ''}`}
                onClick={() => { setSelected(alert.incident_id); onRead(alert) }}
              >
                <div className="alert-item-top">
                  <strong>{alert.incident_code}</strong>
                  <span className={alert.kind === 'escalated' ? 'alert-tag danger' : 'alert-tag'}>
                    {alert.kind === 'escalated' ? 'Эскалация' : alert.kind === 'verified' ? 'Проверено' : 'Назначено'}
                  </span>
                </div>
                <b>{alert.title}</b>
                <span>{alert.body}</span>
                <small className={overdue ? 'overdue' : ''}>{deadlineText(alert.sla_deadline, now, alert.incident_status)}</small>
              </button>
            )
          })}
        </div>
      </section>

      <section className="alert-detail panel">
        {!selectedAlert ? (
          <p className="alert-empty">Выберите задачу.</p>
        ) : (
          <>
            <span className="section-kicker">{selectedAlert.incident_code}</span>
            <h2>{selectedAlert.title}</h2>
            <p>{selectedAlert.body}</p>
            <div className="alert-facts">
              <div><span>Ответственный</span><strong>{selectedAlert.assignee_name || 'Не назначен'}</strong></div>
              <div><span>Исправить до</span><strong>{selectedAlert.sla_deadline ? new Date(selectedAlert.sla_deadline).toLocaleString('ru-RU') : '—'}</strong></div>
              <div><span>Проверка</span><strong>{selectedAlert.verification_status === 'passed' ? 'Исправлено' : selectedAlert.verification_status === 'failed' ? 'Нарушение осталось' : selectedAlert.verification_status === 'unavailable' ? 'Нет данных с камер' : selectedAlert.verification_status === 'requested' ? 'Запрошена' : 'Ожидается'}</strong></div>
              <div><span>Срок</span><strong className={selectedAlert.escalated_at ? 'overdue' : ''}>{deadlineText(selectedAlert.sla_deadline, now, selectedAlert.incident_status)}</strong></div>
            </div>
            <div className="alert-actions">
              {canAct && selectedAlert.kind === 'assigned' && ['pending', 'confirmed'].includes(selectedAlert.incident_status) && (
                <button className="button" disabled={busy} onClick={() => takeAction(selectedAlert, 'in_progress')}>Взять в работу</button>
              )}
              {canAct && selectedAlert.kind === 'assigned' && ['pending', 'confirmed', 'in_progress'].includes(selectedAlert.incident_status) && (
                <button className="button primary" disabled={busy || selectedAlert.verification_status === 'requested'} onClick={() => takeAction(selectedAlert, 'resolved')}>Исправлено — проверить</button>
              )}
              {canAct && selectedAlert.kind === 'escalated' && selectedAlert.incident_status !== 'resolved' && selectedAlert.incident_status !== 'false_positive' && (
                <button className="button" disabled={busy} onClick={() => takeAction(selectedAlert, 'false_positive')}>Отклонить как ошибку</button>
              )}
              {canOpen(selectedAlert) && <button className="button" onClick={() => onOpen(selectedAlert)}>Открыть случай ↗</button>}
            </div>
            <h3>История</h3>
            {eventsLoading && <p role="status">Загружаем историю…</p>}
            {eventsError && <p role="alert">{eventsError}</p>}
            <ol className="alert-timeline">
              {events.map((event) => (
                <li key={event.id}>
                  <time>{new Date(event.created_at).toLocaleString('ru-RU')}</time>
                  <span>{event.comment || event.event_type}</span>
                </li>
              ))}
            </ol>
          </>
        )}
      </section>
    </div>
  )
}
