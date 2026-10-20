import { API_BASE_URL } from '../api/stroyControlApi'
import { req } from './api'
import { decodeCustomerControl } from '../api/generated/customerControl'
import type { LiveDemoConfigDTO, LiveDemoObservationDTO } from '../api/generated/customerControl'

export type LiveConfig = LiveDemoConfigDTO
export type LiveObservation = LiveDemoObservationDTO
const path = (projectId: string, channel: number, action: 'analyze' | 'session') => `/live-demo/${channel}/${action}?project_id=${encodeURIComponent(projectId)}`
export const liveConfig = async (projectId: string, signal: AbortSignal) => decodeCustomerControl('LiveDemoConfigDTO', await req<unknown>(`/live-demo/config?project_id=${encodeURIComponent(projectId)}`, { signal }))
export const analyzeLive = async (projectId: string, channel: number, signal: AbortSignal) => decodeCustomerControl('LiveDemoObservationDTO', await req<unknown>(path(projectId, channel, 'analyze'), { method: 'POST', signal }))
export async function liveSession(projectId: string, channel: number, signal: AbortSignal) {
  const result = decodeCustomerControl('LiveDemoSessionDTO', await req<unknown>(path(projectId, channel, 'session'), { method: 'POST', credentials: 'include', signal }))
  // The server returns only its own scoped media path. No VMS credentials reach the browser.
  return `${API_BASE_URL}${result.media_url}`
}
