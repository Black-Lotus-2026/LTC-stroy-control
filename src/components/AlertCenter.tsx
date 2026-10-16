import { useEffect, useState } from 'react'
import {
  type AlertNotificationItem,
  type IncidentEventItem,
  fetchIncidentEvents,
} from '../api/stroyControlApi'

interface AlertCenterProps {
  alerts: AlertNotificationItem[]
  loading: boolean
  onRead: (alert: AlertNotificationItem) => void
  onAction: (alert: AlertNotificationItem, status: string) => Promise<void>
  onOpen: (alert: AlertNotificationItem) => void
}

function deadlineText(value: string | null, now: number): string {
  if (!value) return 'Срок не задан'
  const remaining = new Date(value).getTime() - now
  const minutes = Math.ceil(Math.abs(remaining) / 60000)
  const hours = Math.floor(minutes / 60)
  const label = `${hours > 0 ? `${hours} ч ` : ''}${minutes % 60} мин`
  return remaining < 0 ? `Просрочено на ${label}` : `Осталось ${label}`
}

export function AlertCenter({ alerts, loading, onRead, onAction, onOpen }: AlertCenterProps) {
  const [filter, setFilter] = useState<'all' | 'assigned' | 'escalated'>('all')
  const [selected, setSelected] = useState<string | null>(null)
  const [events, setEvents] = useState<IncidentEventItem[]>([])
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!selected) return
    fetchIncidentEvents(selected).then(setEvents).catch(() => setEvents([]))
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
            <span className="section-kicker">ЦЕНТР АЛЕРТОВ</span>
            <h2>Мои задачи и эскалации</h2>
            <p>Ответственный получает задачу; после срока система проверяет камеры и сообщает результат.</p>
          </div>
          <span className="alert-unread">{alerts.filter((item) => !item.read_at).length} новых</span>
        </div>
        <div className="alert-filters">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Все ({alerts.length})</button>
          <button className={filter === 'assigned' ? 'active' : ''} onClick={() => setFilter('assigned')}>Мои задачи</button>
          <button className={filter === 'escalated' ? 'active' : ''} onClick={() => setFilter('escalated')}>Эскалации</button>
        </div>
        {loading && alerts.length === 0 && <p className="alert-empty">Загрузка алертов…</p>}
        {!loading && visible.length === 0 && <p className="alert-empty">Алертов пока нет.</p>}
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
                <small className={overdue ? 'overdue' : ''}>{deadlineText(alert.sla_deadline, now)}</small>
              </button>
            )
          })}
        </div>
      </section>

      <section className="alert-detail panel">
        {!selectedAlert ? (
          <p className="alert-empty">Выберите алерт, чтобы увидеть срок, действия и историю проверки.</p>
        ) : (
          <>
            <span className="section-kicker">{selectedAlert.incident_code}</span>
            <h2>{selectedAlert.title}</h2>
            <p>{selectedAlert.body}</p>
            <div className="alert-facts">
              <div><span>Ответственный</span><strong>{selectedAlert.assignee_name || 'Не назначен'}</strong></div>
              <div><span>Исправить до</span><strong>{selectedAlert.sla_deadline ? new Date(selectedAlert.sla_deadline).toLocaleString('ru-RU') : '—'}</strong></div>
              <div><span>Проверка</span><strong>{selectedAlert.verification_status === 'passed' ? 'Исправлено' : selectedAlert.verification_status === 'failed' ? 'Нарушение осталось' : selectedAlert.verification_status === 'unavailable' ? 'Нет данных с камер' : selectedAlert.verification_status === 'requested' ? 'Запрошена' : 'Ожидается'}</strong></div>
              <div><span>Срок</span><strong className={selectedAlert.escalated_at ? 'overdue' : ''}>{deadlineText(selectedAlert.sla_deadline, now)}</strong></div>
            </div>
            <div className="alert-actions">
              {selectedAlert.kind === 'assigned' && ['pending', 'confirmed'].includes(selectedAlert.incident_status) && (
                <button className="button" disabled={busy} onClick={() => takeAction(selectedAlert, 'in_progress')}>Взять в работу</button>
              )}
              {selectedAlert.kind === 'assigned' && ['pending', 'confirmed', 'in_progress'].includes(selectedAlert.incident_status) && (
                <button className="button primary" disabled={busy || selectedAlert.verification_status === 'requested'} onClick={() => takeAction(selectedAlert, 'resolved')}>Исправлено — проверить</button>
              )}
              {selectedAlert.kind === 'escalated' && selectedAlert.incident_status !== 'resolved' && selectedAlert.incident_status !== 'false_positive' && (
                <button className="button" disabled={busy} onClick={() => takeAction(selectedAlert, 'false_positive')}>Отклонить как ошибку</button>
              )}
              <button className="button" onClick={() => onOpen(selectedAlert)}>Открыть инцидент ↗</button>
            </div>
            <h3>История</h3>
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
