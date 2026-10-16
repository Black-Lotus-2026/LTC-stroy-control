import type { Incident } from '../data'

/** One mutually exclusive classification for lists, counters and exports. */
export function incidentKind(item: Incident): 'error' | 'warning' | 'info' {
  if (item.discrepancyType === 'STREAM_ONLINE' || item.discrepancyType === 'NEUTRAL_INFO' || item.severity === 'NEUTRAL') return 'info'
  if (item.severity === 'ERROR') return 'error'
  if (item.severity === 'WARNING') return 'warning'
  if (item.discrepancyType === 'MISSING_MANDATORY' || item.discrepancyType === 'UNCHARACTERISTIC_PRESENT' || item.priority === 'Критический') return 'error'
  return item.discrepancyType === 'MISSING_RECOMMENDED' ? 'warning' : 'info'
}

export const isDeviation = (item: Incident): boolean => incidentKind(item) !== 'info'
export const isOpenIncident = (item: Incident): boolean => !['Устранено', 'Проблемы нет', 'Ложное срабатывание'].includes(item.status)

export function filterIncidents(items: Incident[], projectId?: string, zoneId?: string | null): Incident[] {
  if (!projectId) return []
  return items.filter(item => item.projectId === projectId && (!zoneId || zoneId === 'all' || item.zoneId === zoneId))
}

export function incidentDateTime(item: Incident): string {
  const timestamp = item.createdAt ? Date.parse(item.createdAt) : NaN
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp))
    : item.time || 'Время не указано'
}
