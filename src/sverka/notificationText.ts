import type { NotificationDTO } from '../api/generated/customerControl'

export function notificationTitle(notification: Pick<NotificationDTO, 'title' | 'event_type'>): string {
  return notification.title?.trim() || (notification.event_type === 'incident.workflow_changed' ? 'Изменён статус дела' : 'Изменение по доступному ресурсу')
}
