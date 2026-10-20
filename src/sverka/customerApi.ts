import { API_BASE_URL, API_PREFIX, getAuthHeaders } from '../api/stroyControlApi'
import { ApiError, req } from './api'
import { decodeCustomerControl } from '../api/generated/customerControl'
import type { CustomerControlContracts, ContextDTO, IncidentDTO, IncidentDetailDTO, IncidentCommandDTO as IncidentCommand, EvidenceDTO, DisputeDTO, OpenDisputeCommand, DecideDisputeCommand, ControlReleaseDTO, CreateReleaseCommand, ReturnControlCommand, ApproveControlCommand, VersionedCommand, RequirementRevisionDTO, CreateRevisionCommand, ParticipantOptionsDTO, PublishEvidenceCommand, CameraMoveCommand, CameraMoveDecisionCommand, CameraMoveRequestDTO, CoverageCommand, CreateOrganizationCommand, CreateProjectCommand, InvitationCommand, InviteParticipationCommand, CreateAreaCommand, CreateAssignmentCommand, RevokeCommand, ArchiveProjectCommand, RestoreProjectCommand, AssignIncidentCommand, DeadlineCommand, ShareCommand, DeadlinePolicyCommand, DeadlinePauseCommand, CommentCommand, ScopedReportCommand } from '../api/generated/customerControl'

export type { ContextDTO, IncidentDTO, IncidentDetailDTO, IncidentCommand, EvidenceDTO, DisputeDTO, ControlReleaseDTO, RequirementRevisionDTO, ParticipantOptionsDTO, CameraMoveRequestDTO }
const root = '/customer-control'
const p = (id: string) => `${root}/projects/${encodeURIComponent(id)}`
const i = (id: string) => `${root}/incidents/${encodeURIComponent(id)}`
const retries = new Map<string, string>()
function receiptKey(route: string, body: unknown): string {
  const signature = `${getAuthHeaders()['X-Project-Assignment'] || ''}:${route}:${JSON.stringify(body)}`
  let key = retries.get(signature)
  if (!key) { key = crypto.randomUUID(); retries.set(signature, key) }
  if (retries.size > 200) retries.delete(retries.keys().next().value!)
  return key
}
/** Repeating an unacknowledged action uses the same receipt, including after a network error. */
function mutation(method: 'POST' | 'PATCH', route: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': receiptKey(route, body) }, body: JSON.stringify(body) }
}
async function rpc<K extends keyof CustomerControlContracts>(schema: K, route: string, init?: RequestInit): Promise<CustomerControlContracts[K]> {
  return decodeCustomerControl(schema, await req<unknown>(route, init))
}
async function list<K extends keyof CustomerControlContracts>(schema: K, route: string, signal?: AbortSignal): Promise<CustomerControlContracts[K][]> {
  const response = await req<unknown>(route, { signal })
  if (!Array.isArray(response)) throw new Error('Ответ API не соответствует контракту списка. Обновите приложение или обратитесь к администратору.')
  return response.map(item => decodeCustomerControl(schema, item))
}
export const contexts = (signal?: AbortSignal) => list('ContextDTO', '/auth/contexts', signal)
export async function incidents(projectId: string, signal?: AbortSignal): Promise<IncidentDTO[]> {
  const rows: IncidentDTO[] = []
  for (let offset = 0; ; offset += 200) {
    const page = await list('IncidentDTO', `${p(projectId)}/incidents?limit=200&offset=${offset}`, signal)
    rows.push(...page)
    if (page.length < 200) return rows
  }
}
export const incident = (id: string, signal?: AbortSignal) => rpc('IncidentDetailDTO', i(id), { signal })
export const participants = (projectId: string, signal?: AbortSignal) => rpc('ParticipantOptionsDTO', `${p(projectId)}/participants`, { signal })
export const assignIncident = (id: string, body: AssignIncidentCommand) => rpc('IncidentDTO', `${i(id)}/assignments`, mutation('POST', `${i(id)}/assignments`, body))
export const changeDeadline = (id: string, body: DeadlineCommand) => rpc('IncidentDTO', `${i(id)}/deadline-changes`, mutation('POST', `${i(id)}/deadline-changes`, body))
export const command = (id: string, body: IncidentCommand) => rpc('CommandResultDTO', `${i(id)}/commands`, mutation('POST', `${i(id)}/commands`, body))
export async function uploadEvidence(id: string, file: File, expectedVersion: number): Promise<EvidenceDTO> {
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))).map(byte => byte.toString(16).padStart(2, '0')).join('')
  const data = new FormData(); data.append('file', file); data.append('expected_version', String(expectedVersion))
  return rpc('EvidenceDTO', `${i(id)}/evidence`, { method: 'POST', body: data, headers: { 'Idempotency-Key': receiptKey(`${i(id)}/evidence`, { sha256: hash, expected_version: expectedVersion }) } })
}
export const openDispute = (id: string, body: OpenDisputeCommand) => rpc('DisputeDTO', `${i(id)}/disputes`, mutation('POST', `${i(id)}/disputes`, body))
export const decideDispute = (id: string, body: DecideDisputeCommand) => rpc('DisputeDTO', `${root}/disputes/${encodeURIComponent(id)}/decide`, mutation('POST', `${root}/disputes/${encodeURIComponent(id)}/decide`, body))
export const withdrawDispute = (id: string, body: ReturnControlCommand) => rpc('DisputeDTO', `${root}/disputes/${encodeURIComponent(id)}/withdraw`, mutation('POST', `${root}/disputes/${encodeURIComponent(id)}/withdraw`, body))
export const discloseEvidence = (id: string, body: PublishEvidenceCommand) => rpc('IncidentDTO', `${i(id)}/disclosures`, mutation('POST', `${i(id)}/disclosures`, body))
export const releases = (projectId: string, signal?: AbortSignal) => list('ControlReleaseDTO', `${p(projectId)}/control-releases`, signal)
export const createRelease = (projectId: string, body: CreateReleaseCommand) => rpc('ControlReleaseDTO', `${p(projectId)}/control-releases`, mutation('POST', `${p(projectId)}/control-releases`, body))
export const submitRelease = (id: string, body: VersionedCommand) => rpc('ControlReleaseDTO', `${root}/control-releases/${encodeURIComponent(id)}/submit`, mutation('POST', `${root}/control-releases/${encodeURIComponent(id)}/submit`, body))
export const approveRelease = (id: string, body: ApproveControlCommand) => rpc('ControlReleaseDTO', `${root}/control-releases/${encodeURIComponent(id)}/approve`, mutation('POST', `${root}/control-releases/${encodeURIComponent(id)}/approve`, body))
export const returnRelease = (id: string, body: ReturnControlCommand) => rpc('ControlReleaseDTO', `${root}/control-releases/${encodeURIComponent(id)}/return`, mutation('POST', `${root}/control-releases/${encodeURIComponent(id)}/return`, body))
export const retireRelease = (id: string, body: ReturnControlCommand) => rpc('ControlReleaseDTO', `${root}/control-releases/${encodeURIComponent(id)}/retire`, mutation('POST', `${root}/control-releases/${encodeURIComponent(id)}/retire`, body))
export const notifications = (projectId: string, signal?: AbortSignal) => list('NotificationDTO', `${p(projectId)}/notifications?limit=50`, signal)
export const revisions = (projectId: string, signal?: AbortSignal) => list('RequirementRevisionDTO', `${p(projectId)}/requirement-revisions`, signal)
export const createRevision = (id: string, body: CreateRevisionCommand) => rpc('RequirementRevisionDTO', `${root}/requirements/${encodeURIComponent(id)}/revisions`, mutation('POST', `${root}/requirements/${encodeURIComponent(id)}/revisions`, body))
export const cameraMoves = (projectId: string, cameraId: string, signal?: AbortSignal) => list('CameraMoveRequestDTO', `${p(projectId)}/cameras/${encodeURIComponent(cameraId)}/move-requests`, signal)
export const requestCameraMove = (projectId: string, cameraId: string, body: CameraMoveCommand) => rpc('CameraMoveRequestDTO', `${p(projectId)}/cameras/${encodeURIComponent(cameraId)}/move-requests`, mutation('POST', `${p(projectId)}/cameras/${encodeURIComponent(cameraId)}/move-requests`, body))
export const decideCameraMove = (id: string, body: CameraMoveDecisionCommand) => rpc('CameraMoveRequestDTO', `${root}/camera-move-requests/${encodeURIComponent(id)}/commands`, mutation('POST', `${root}/camera-move-requests/${encodeURIComponent(id)}/commands`, body))

export const coverageConfigurations = (projectId: string, signal?: AbortSignal) => list('CoverageConfigurationDTO', `${p(projectId)}/coverage-configurations`, signal)
export const configureCoverage = (projectId: string, body: CoverageCommand) => rpc('CoverageConfigurationDTO', `${p(projectId)}/coverage-configurations`, mutation('POST', `${p(projectId)}/coverage-configurations`, body))

export const organizationMembers = (id: string, signal?: AbortSignal) => list('NamedMembershipDTO', `${root}/organizations/${encodeURIComponent(id)}/members`, signal)
export const revokeMembership = async (id: string, reason: string): Promise<void> => { await req<unknown>(`${root}/memberships/${encodeURIComponent(id)}/revoke`, mutation('POST', `${root}/memberships/${encodeURIComponent(id)}/revoke`, { reason })) }
export const organizations = (signal?: AbortSignal) => list('OrganizationDTO', `${root}/organizations`, signal)
export const memberships = (signal?: AbortSignal) => list('MembershipDTO', `${root}/memberships`, signal)
export const invitations = (signal?: AbortSignal) => list('InvitationDTO', `${root}/invitations`, signal)
export const createOrganization = (body: CreateOrganizationCommand) => rpc('OrganizationDTO', `${root}/organizations`, mutation('POST', `${root}/organizations`, body))
export function createProject(membershipId: string, body: CreateProjectCommand) {
  const init = mutation('POST', `${root}/projects`, body)
  return rpc('ProjectDTO', `${root}/projects`, { ...init, headers: { ...init.headers, 'X-Organization-Membership': membershipId, 'X-Project-Assignment': '' } })
}
export function inviteMember(organizationId: string, membershipId: string, body: InvitationCommand) {
  const route = `${root}/organizations/${encodeURIComponent(organizationId)}/invitations`
  const init = mutation('POST', route, body)
  return rpc('InvitationDTO', route, { ...init, headers: { ...init.headers, 'X-Organization-Membership': membershipId, 'X-Project-Assignment': '' } })
}
export const acceptInvitation = (token: string) => rpc('InvitationDTO', `${root}/invitations/${encodeURIComponent(token)}/accept`, mutation('POST', `${root}/invitations/${encodeURIComponent(token)}/accept`, {}))
export const inviteContractor = (projectId: string, body: InviteParticipationCommand) => rpc('InvitationDTO', `${p(projectId)}/participations`, mutation('POST', `${p(projectId)}/participations`, body))
export const createArea = (projectId: string, body: CreateAreaCommand) => rpc('NamedOptionDTO', `${p(projectId)}/areas`, mutation('POST', `${p(projectId)}/areas`, body))
export const grantAssignment = (projectId: string, body: CreateAssignmentCommand) => rpc('AssignmentDTO', `${p(projectId)}/assignments`, mutation('POST', `${p(projectId)}/assignments`, body))
export const revokeAssignment = (id: string, body: RevokeCommand) => rpc('AssignmentDTO', `${root}/assignments/${encodeURIComponent(id)}/revoke`, mutation('POST', `${root}/assignments/${encodeURIComponent(id)}/revoke`, body))
export const archiveProject = (projectId: string, body: ArchiveProjectCommand) => rpc('ProjectDTO', `${p(projectId)}/archive`, mutation('POST', `${p(projectId)}/archive`, body))

export const assignmentOptions = (projectId: string, signal?: AbortSignal) => rpc('AssignmentSetupDTO', `${p(projectId)}/assignment-options`, { signal })
export const restoreProject = (projectId: string, body: RestoreProjectCommand) => rpc('ProjectDTO', `${p(projectId)}/restore`, mutation('POST', `${p(projectId)}/restore`, body))
export const endParticipation = async (id: string, reason: string): Promise<void> => { await req<unknown>(`${root}/participations/${encodeURIComponent(id)}/end`, mutation('POST', `${root}/participations/${encodeURIComponent(id)}/end`, { reason })) }

export const shareSource = (projectId: string, kind: 'document' | 'camera' | 'video', resourceId: string, body: ShareCommand) => rpc('ShareDTO', `${p(projectId)}/sources/${kind}/${encodeURIComponent(resourceId)}/shares`, mutation('POST', `${p(projectId)}/sources/${kind}/${encodeURIComponent(resourceId)}/shares`, body))

export const deadlinePolicies = (projectId: string, signal?: AbortSignal) => list('DeadlinePolicyDTO', `${p(projectId)}/deadline-policies`, signal)
export const approveDeadlinePolicy = (projectId: string, body: DeadlinePolicyCommand) => rpc('DeadlinePolicyDTO', `${p(projectId)}/deadline-policies`, mutation('POST', `${p(projectId)}/deadline-policies`, body))
export const pauseDeadline = (id: string, body: DeadlinePauseCommand) => rpc('IncidentDTO', `${i(id)}/deadline-pauses`, mutation('POST', `${i(id)}/deadline-pauses`, body))
export const documentCases = (projectId: string, signal?: AbortSignal) => list('IncidentDocumentContextDTO', `${p(projectId)}/document-cases`, signal)
export const commentOnCase = (id: string, body: CommentCommand) => rpc('CommentDTO', `${i(id)}/comments`, mutation('POST', `${i(id)}/comments`, body))

export const createReport = (projectId: string, body: ScopedReportCommand) => rpc('ScopedReportDTO', `${p(projectId)}/reports`, mutation('POST', `${p(projectId)}/reports`, body))
export const metrics = (projectId: string, signal?: AbortSignal) => rpc('MetricsDTO', `${p(projectId)}/metrics`, { signal })

export async function savedVideoPlayback(videoId: string, signal?: AbortSignal) {
  const session = await rpc('PlaybackSessionDTO', `/videos/${encodeURIComponent(videoId)}/playback-session`, { method: 'POST', credentials: 'include', signal, headers: { 'Idempotency-Key': crypto.randomUUID() } })
  const expectedPath = `${new URL(API_PREFIX, 'https://playback.invalid').pathname}/videos/${encodeURIComponent(videoId)}/media`
  if (session.media_url !== expectedPath) throw new ApiError('Ссылка сессии воспроизведения недопустима.', 0)
  return { ...session, media_url: `${API_BASE_URL}${session.media_url}` }
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'SELF_REVIEW_FORBIDDEN') return 'Это решение должен проверить другой управляющий заказчика: собственное устранение, спор или решение нельзя принять самому.'
    if (error.code === 'OPEN_DISPUTE') return 'Сначала требуется решение или отзыв открытого спора. Приёмка пока недоступна.'
    if (error.code === 'PROJECT_ARCHIVED') return 'Объект в архиве. Доступен только просмотр.'
    if (error.code === 'WORKFLOW_UPGRADE_REQUIRED') return 'Выполните действие в рабочем кабинете через согласование и приёмку заказчиком.'
    if (error.status === 409) return 'Данные изменены другим участником или действие сейчас недоступно. Обновите данные и заново просмотрите решение.'
    if (error.status === 403 || error.status === 404) return 'Ресурс недоступен в текущем назначении. Обновите список доступов.'
  }
  return error instanceof Error ? error.message : 'Не удалось получить ответ сервера.'
}
export async function evidenceBlob(id: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(`${API_PREFIX}${root}/evidence/${encodeURIComponent(id)}/file`, { signal, headers: getAuthHeaders() })
  if (!response.ok) throw new ApiError('Материал недоступен в текущем назначении.', response.status)
  return response.blob()
}
