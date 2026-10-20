import type { CameraItem, ProjectItem, UserProfile } from './api'

export const isSharedDemoProject = (p: Pick<ProjectItem, 'code' | 'owner_username'>) => p.code === 'MANAGEMENT-DEMO' && p.owner_username == null

export function visibleProjects(projects: ProjectItem[], user: UserProfile): ProjectItem[] {
  return projects.filter(p => user.role === 'admin' || p.owner_username === user.username || isSharedDemoProject(p))
    .sort((a, b) => Number(isSharedDemoProject(b)) - Number(isSharedDemoProject(a)))
}

export function sourceCamera(cameras: CameraItem[], sourceId?: string, recordingCameraId?: string): CameraItem | undefined {
  const cameraId = sourceId === 'recording' ? recordingCameraId : sourceId
  return cameras.find(camera => camera.id === cameraId)
}

export function recordingAnalysisLabel(status?: string): string {
  const labels: Record<string, string> = { PENDING: 'Ожидает анализа', QUEUED: 'В очереди', RUNNING: 'Анализируется', COMPLETED: 'Обработано', FAILED: 'Ошибка' }
  return labels[status ?? ''] ?? 'Статус анализа неизвестен'
}
