import { useEffect, useState } from 'react'
import type { InvitationDTO, MembershipDTO, OrganizationDTO, CreateProjectCommand, NamedMembershipDTO } from '../../api/generated/customerControl'
import type { UserProfile } from '../api'
import * as customer from '../customerApi'
import { dateTime } from './CustomerWorkspace'

export function CustomerOrganizations({ user, onChanged }: { user: UserProfile; onChanged: () => void }) {
  const [organizations, setOrganizations] = useState<OrganizationDTO[]>([])
  const [memberships, setMemberships] = useState<MembershipDTO[]>([])
  const [invitations, setInvitations] = useState<InvitationDTO[]>([])
  const [memberId, setMemberId] = useState('')
  const [name, setName] = useState('')
  const [projectName, setProjectName] = useState('')
  const [reactionMinutes, setReactionMinutes] = useState('')
  const [remediationMinutes, setRemediationMinutes] = useState('')
  const [reviewMinutes, setReviewMinutes] = useState('')
  const [projectKind, setProjectKind] = useState<CreateProjectCommand['kind']>('production')
  const [recipient, setRecipient] = useState('')
  const [expires, setExpires] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [employees, setEmployees] = useState<NamedMembershipDTO[]>([])
  useEffect(() => {
    const controller = new AbortController(); setLoading(true)
    Promise.all([customer.organizations(controller.signal), customer.memberships(controller.signal), customer.invitations(controller.signal)]).then(([orgs, members, inbox]) => { if (!controller.signal.aborted) { setOrganizations(orgs); setMemberships(members); setInvitations(inbox); setMemberId(current => members.some(member => member.id === current) ? current : members[0]?.id ?? ''); setError('') } }).catch(failure => { if (!controller.signal.aborted) setError(customer.errorMessage(failure)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh])
  const member = memberships.find(item => item.id === memberId)
  const org = organizations.find(item => item.id === member?.organization_id)
  useEffect(() => {
    const controller = new AbortController(); setEmployees([])
    if (member?.can_manage_members) customer.organizationMembers(member.organization_id, controller.signal).then(setEmployees, failure => { if (!controller.signal.aborted) setError(customer.errorMessage(failure)) })
    return () => controller.abort()
  }, [member, refresh])
  const run = async (fn: () => Promise<unknown>, message: string) => { if (busy) return; setBusy(true); setError(''); try { await fn(); setNotice(message); setRefresh(value => value + 1); onChanged() } catch (failure) { setError(customer.errorMessage(failure)) } finally { setBusy(false) } }
  return <>
    <div className="customer-title"><div><span className="kicker">Членство и рабочие назначения</span><h1>Организации и приглашения</h1><p>Членство подтверждает вашу организацию. Доступ к объектам предоставляет управляющий отдельным назначением.</p></div><button type="button" className="btn small" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Обновить</button></div>
    {loading && <p role="status">Загружаем организации и входящие приглашения…</p>}{error && <p className="customer-notice" data-kind="error" role="alert">{error}</p>}{notice && <p className="customer-notice" role="status">{notice}</p>}
    <section><h2>Входящие приглашения</h2><div className="customer-grid">{invitations.map(invitation => <article className="customer-card" key={invitation.id}><h3>{'organization_name' in invitation && typeof invitation.organization_name === 'string' ? invitation.organization_name : 'Приглашение в организацию'}</h3><p>{'project_name' in invitation && typeof invitation.project_name === 'string' ? `Участие в объекте: ${invitation.project_name}` : 'Подтверждение членства организации'}</p><p className="customer-muted">Действует до {dateTime(invitation.expires_at)}</p><button className="btn" type="button" disabled={busy || !invitation.token} onClick={() => { if (invitation.token) void run(() => customer.acceptInvitation(invitation.token!), 'Приглашение принято. Объекты появятся после отдельного назначения управляющим.') }}>Принять приглашение</button></article>)}</div>{!loading && !invitations.length && !error && <p className="customer-muted">Действующих приглашений нет.</p>}</section>
    <section style={{ marginTop: 28 }}><h2>Мои организации</h2>{memberships.length > 0 && <label className="customer-form">Выбранное членство<select value={memberId} onChange={event => setMemberId(event.target.value)}>{memberships.map(item => <option key={item.id} value={item.id}>{organizations.find(org => org.id === item.organization_id)?.name ?? 'Организация'}</option>)}</select></label>}{org && <article className="customer-card" style={{ marginTop: 16 }}><h3>{org.name}</h3><p className="customer-muted">Код организации для приглашения заказчиком: {org.id}</p><p className="customer-muted">Ваш идентификатор для приглашений: {user.id}</p>{org.needs_confirmation && <p>Организация перенесена из прежней системы и требует подтверждения. Новые полномочия автоматически не выданы.</p>}</article>}{!loading && !organizations.length && !error && <p className="customer-muted">У вас пока нет подтверждённого членства. Примите приглашение либо явно создайте новую организацию.</p>}</section>
    <div className="customer-grid" style={{ marginTop: 24 }}>
      {member?.can_create_projects && <section className="customer-card customer-form"><h3>Создать объект заказчика</h3><p>Объект принадлежит {org?.name}. Создатель получает назначение управляющего только в этом объекте.</p><label>Название объекта<input value={projectName} maxLength={256} onChange={event => setProjectName(event.target.value)} /></label><label>Проверка кандидата, мин<input type="number" min={1} max={43200} value={reactionMinutes} onChange={event => setReactionMinutes(event.target.value)} /></label><label>Исправление, мин<input type="number" min={1} max={43200} value={remediationMinutes} onChange={event => setRemediationMinutes(event.target.value)} /></label><label>Приёмка, мин<input type="number" min={1} max={43200} value={reviewMinutes} onChange={event => setReviewMinutes(event.target.value)} /></label><label>Назначение объекта<select value={projectKind} onChange={event => setProjectKind(event.target.value as CreateProjectCommand['kind'])}><option value="production">Рабочий объект</option><option value="jury">Изолированный демонстрационный объект</option></select></label><button className="btn" type="button" disabled={busy || !projectName.trim() || !reactionMinutes || !remediationMinutes || !reviewMinutes || [reactionMinutes, remediationMinutes, reviewMinutes].some(value => !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 43200)} onClick={() => void run(() => customer.createProject(member.id, { name: projectName.trim(), kind: projectKind, reaction_minutes: Number(reactionMinutes), remediation_minutes: Number(remediationMinutes), review_minutes: Number(reviewMinutes) }), 'Объект создан. Выберите новое назначение в шапке.')}>Создать объект</button></section>}
      {member?.can_manage_members && org && <section className="customer-card customer-form"><h3>Пригласить сотрудника в {org.name}</h3><label>Идентификатор аккаунта сотрудника<input value={recipient} onChange={event => setRecipient(event.target.value.trim())} placeholder="Из профиля приглашённого пользователя" /></label><label>Приглашение действует до<input type="datetime-local" value={expires} onChange={event => setExpires(event.target.value)} /></label><p className="customer-muted">Срок не более 30 дней. Приглашение появится только в аккаунте указанного человека. Назначение на объект выполняется отдельно.</p><button className="btn" type="button" disabled={busy || !recipient || !expires} onClick={() => void run(() => customer.inviteMember(org.id, member.id, { recipient_user_id: recipient, expires_at: new Date(expires).toISOString() }), 'Приглашение создано во входящих адресата. Доступ к объектам не выдан.')}>Создать приглашение</button></section>}
    </div>
    {member?.can_manage_members && <section style={{ marginTop: 24 }}><h2>Сотрудники организации</h2><div className="customer-grid">{employees.map(employee => <Employee key={employee.id + employee.status} employee={employee} busy={busy} onRevoke={reason => void run(() => customer.revokeMembership(employee.id, reason), 'Членство отозвано. Доступ к объектам и материалам прекращён.')} />)}</div></section>}
    <details className="customer-card customer-form" style={{ marginTop: 24 }}><summary>Создать новую самостоятельную организацию</summary><p>Это отдельная новая организация. Совпадение названия с существующей компанией не предоставляет членство и не объединяет данные.</p><label>Название организации<input value={name} maxLength={256} onChange={event => setName(event.target.value)} /></label><button className="btn" type="button" disabled={busy || !name.trim()} onClick={() => void run(() => customer.createOrganization({ name: name.trim() }), 'Новая изолированная организация создана. Теперь можно создать её объект или пригласить сотрудников.')}>Создать отдельную организацию</button></details>
  </>
}

function Employee({ employee, busy, onRevoke }: { employee: NamedMembershipDTO; busy: boolean; onRevoke: (reason: string) => void }) {
  const [reason, setReason] = useState(''); const [confirmed, setConfirmed] = useState(false)
  return <article className="customer-card customer-form"><h3>{employee.name}</h3><p>{employee.status === 'active' ? 'Членство подтверждено' : 'Членство отозвано'}</p><p className="customer-muted">{[employee.can_manage_members ? 'Управление членством' : '', employee.can_create_projects ? 'Создание объектов' : ''].filter(Boolean).join(' · ') || 'Рабочие права выдаются назначением'}</p>{employee.status === 'active' && <details><summary>Отозвать членство</summary><p>Сотрудник потеряет текущий доступ во всех объектах этой организации. При необходимости сначала передайте его открытые задачи управляющим объектов.</p><label>Причина<textarea value={reason} maxLength={4000} onChange={event => setReason(event.target.value)} /></label><label className="customer-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>Проверил последствия прекращения доступа.</span></label><button className="btn" type="button" disabled={busy || !confirmed || !reason.trim()} onClick={() => onRevoke(reason)}>Отозвать членство</button></details>}</article>
}
