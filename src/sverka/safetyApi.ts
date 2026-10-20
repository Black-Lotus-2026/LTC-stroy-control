import { API_PREFIX, getStoredToken } from '../api/stroyControlApi'
import { req, type DetectResponse } from './api'

export type SafetyScenario = 'worker_danger_zone' | 'vehicle_blocks_passage' | 'vehicle_restricted_zone'
export type Point = [number, number]
export const SAFETY_SCENARIOS: Record<SafetyScenario, string> = {
  worker_danger_zone: 'Человек в опасной зоне',
  vehicle_blocks_passage: 'Техника в зоне прохода',
  vehicle_restricted_zone: 'Техника в запрещённой зоне',
}
export interface SafetyZone {
  id: string; camera_id: string; name: string; scenario: SafetyScenario; polygon: Point[];
  site_basis: string; responsible_user_id: string; responsible_name?: string; camera_name?: string; min_duration_seconds: number;
  confidence_threshold: number; allowed_classes: string[]; enabled: boolean;
}
export type ZoneInput = Omit<SafetyZone, 'id'>
export interface SafetyConfiguration {
  can_manage: boolean;
  cameras: { id: string; name: string }[];
  responsibles: { id: string; name: string; role: string }[];
}
export interface SafetyEvent {
  id: string; status: 'pending' | 'confirmed' | 'rejected'; scenario: SafetyScenario;
  candidate_reason: string; first_seen: string; last_seen: string;
  camera_name: string; source_id: string; position_ms?: number;
  evidence_url: string; model_sha256: string;
  detections: { raw_label: string; confidence: number; x1: number; y1: number; x2: number; y2: number }[];
  zone_snapshot: SafetyZone;
  norm_snapshot: Record<string, unknown>[];
  sanction_snapshot: Record<string, unknown>[];
  reviewed_by?: string; reviewed_at?: string; review_comment?: string;
  can_review?: boolean; created_at: string; observations: number; limitations: string; algorithm_version: string; evidence_sha256: string; first_evidence_sha256: string; first_position_ms: number; last_position_ms: number;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const projectPath = (id: string) => `/safety/projects/${encodeURIComponent(id)}`
export const safetyConfiguration = (id: string) => req<SafetyConfiguration>(`${projectPath(id)}/configuration`)
export const safetyZones = (id: string) => req<SafetyZone[]>(`${projectPath(id)}/zones`)
export const saveSafetyZone = (id: string, zone: ZoneInput, zoneId?: string) => req<SafetyZone>(zoneId ? `/safety/zones/${encodeURIComponent(zoneId)}` : `${projectPath(id)}/zones`, json(zoneId ? 'PATCH' : 'POST', zone))
export const deleteSafetyZone = (id: string, zoneId: string) => req<void>(`/safety/zones/${encodeURIComponent(zoneId)}`, { method: 'DELETE' })
interface WireEvent { can_review?: boolean; created_at: string; evidence_sha256: string; id: string; status: 'candidate' | 'confirmed' | 'rejected'; scenario: SafetyScenario; title: string; source_id: string; camera_id: string; first_position_ms: number; last_position_ms: number; model_sha256: string; evidence_url: string; snapshot: { zone: SafetyZone; detections: SafetyEvent['detections']; requirements: (Record<string, unknown> & { document?: Record<string, unknown> })[]; sanctions: Record<string, unknown>[]; limitations: string; observations: number; algorithm_version: string; first_evidence_sha256: string; camera_name?: string }; reviewed_by?: string; reviewed_at?: string; review_comment?: string }
export function sourceTime(ms: number): string { return ms >= 946684800000 ? new Date(ms).toISOString() : `Позиция записи: ${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}` }
function toEvent(e: WireEvent): SafetyEvent {
  return { ...e, status: e.status === 'candidate' ? 'pending' : e.status, candidate_reason: e.title, first_seen: sourceTime(e.first_position_ms), last_seen: sourceTime(e.last_position_ms), camera_name: (e.snapshot.zone as SafetyZone & { camera_name?: string }).camera_name ?? e.camera_id, detections: e.snapshot.detections, zone_snapshot: e.snapshot.zone, norm_snapshot: e.snapshot.requirements.map(r => ({ ...r.document, ...r, title: `${r.document?.code ?? ''} · ${r.clause ?? ''}`, document_applicability_note: r.document?.applicability_note })), sanction_snapshot: e.snapshot.sanctions, observations: e.snapshot.observations, limitations: e.snapshot.limitations, algorithm_version: e.snapshot.algorithm_version, first_evidence_sha256: e.snapshot.first_evidence_sha256 }
}
export const safetyEvents = async (id: string) => (await req<WireEvent[]>(`${projectPath(id)}/events`)).map(toEvent)
export const reviewSafetyEvent = async (id: string, decision: 'confirmed' | 'rejected', comment: string) => toEvent(await req<WireEvent>(`/safety/events/${encodeURIComponent(id)}/review`, json('POST', { decision, comment })))
export const safetyCatalog = () => req<{ documents: Record<string, unknown>[]; requirements: Record<string, unknown>[]; sanctions: Record<string, unknown>[] }>('/safety/catalog')

export function analyzeSafetyFrame(projectId: string, cameraId: string, blob: Blob, sourceId: string, positionMs: number) {
  const fd = new FormData()
  fd.append('file', blob, 'frame.jpg')
  fd.append('camera_id', cameraId)
  fd.append('source_id', sourceId)
  fd.append('position_ms', String(Math.round(positionMs)))
  return req<DetectResponse>(`${projectPath(projectId)}/analyze-frame`, { method: 'POST', body: fd })
}

/** Evidence stays behind project authorization; no bearer token in image URLs. */
export async function safetyEvidence(eventId: string, signal: AbortSignal, kind: 'first' | 'last' = 'last'): Promise<Blob> {
  const token = getStoredToken()
  const response = await fetch(`${API_PREFIX}/safety/events/${encodeURIComponent(eventId)}/evidence?kind=${kind}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal })
  if (!response.ok) throw new Error('Кадр доказательства недоступен')
  return response.blob()
}
