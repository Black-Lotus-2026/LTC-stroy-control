import type { CameraItem, ZoneItem } from '../api/stroyControlApi'
import type { Incident } from '../data'

/** A camera's saved site wins over a display filter. Never guess the first site. */
export function observationScope(cameras: CameraItem[], zones: ZoneItem[], sourceId?: string, selectedZoneId?: string | null) {
  const camera = cameras.find(item => item.id === sourceId || item.code === sourceId)
  const zoneId = camera ? camera.zone_id : selectedZoneId === 'all' ? undefined : selectedZoneId
  return { camera, zone: zones.find(item => item.id === zoneId) }
}

/** The server may return an existing case when observations repeat. */
export function upsertIncident(items: Incident[], confirmed: Incident, temporaryId?: string): Incident[] {
  return [confirmed, ...items.filter(item => item.id !== temporaryId && item.id !== confirmed.id && (!confirmed.uuid || item.uuid !== confirmed.uuid))]
}
