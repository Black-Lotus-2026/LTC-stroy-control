export type PageKey = 'monitoring' | 'archive' | 'progress' | 'analytics' | 'reports' | 'settings'
export type IncidentStatus =
  | 'Ожидает обработки'
  | 'Подтверждено'
  | 'Проблемы нет'
  | 'Требует проверки'
  | 'В работе'
  | 'Устранено'
  | 'Ложное срабатывание'
export type Priority = 'Критический' | 'Высокий' | 'Средний' | 'Низкий'

export interface Camera {
  id: string
  name: string
  zone: string
  status: 'online' | 'degraded' | 'offline'
  freshness: string
  visibility: number
}

export interface Incident {
  id: string
  type: string
  title: string
  zone: string
  camera: string
  time: string
  age: string
  priority: Priority
  status: IncidentStatus
  assignee: string
  sla: string
  confidence: number
  grouped?: number
  note: string
  severity?: 'ERROR' | 'WARNING' | 'NEUTRAL'
  snapshotUrl?: string
  albumPhotos?: { url: string; cameraName?: string; isPrimary?: boolean; capturedAt?: string }[]
  stageName?: string
  discrepancyType?: string
  manual_override?: boolean
}

export const projects: { id: string; name: string; address: string; stage: string }[] = []

export const cameras: Camera[] = []

export const incidentsSeed: Incident[] = []

export const zones: { id: string; name: string; work: string; risk: string; x: number; y: number; w: number; h: number }[] = []

export const activities: { name: string; zone: string; time: string; planned: string; observed: string; status: string }[] = []

export const detections: { label: string; confidence: number; time: string; tone: string }[] = []

export const archiveResults: { time: string; duration: string; camera: string; zone: string; title: string; confidence: number }[] = []

export const analytics: { day: string; incidents: number; response: number }[] = []

export const team: string[] = []

export const mockApi = {
  async updateIncident(id: string, patch: Partial<Incident>) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    return { id, ...patch }
  },
  async runArchiveSearch(query: string) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    return { query, results: archiveResults }
  },
}
