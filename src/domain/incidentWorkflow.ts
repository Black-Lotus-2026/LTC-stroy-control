import type { Incident, IncidentStatus } from '../data'

export function canChangeIncident(incident: Incident, user: { id: string; username: string; role: string } | null, owner?: string | null): boolean {
  if (!user || user.role === 'viewer') return false
  return user.role === 'admin' || incident.assignedUserId === user.id || (!incident.assignedUserId && owner === user.username)
}

export function incidentActions(incident: Incident): IncidentStatus[] {
  if (incident.canUpdate === false || ['Устранено', 'Проблемы нет', 'Ложное срабатывание'].includes(incident.status) || incident.verificationStatus === 'requested') return []
  return ['Подтверждено', 'В работе', 'Устранено', ...(incident.canDismiss ? ['Проблемы нет'] : [])] as IncidentStatus[]
}
