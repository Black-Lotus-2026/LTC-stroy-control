import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { setProjectAssignment } from '../../api/stroyControlApi'
import * as customer from '../customerApi'
import type { ContextDTO } from '../customerApi'
import type { UserProfile } from '../api'
import { CustomerOrganizations } from './CustomerOrganizations'
import '../customer-control.css'

import { contextKey, roleName } from '../customerContext'
export { roleName, contextKey, can, dateTime, canReadFullPlan } from '../customerContext'
export type CustomerAccess = Omit<WorkspaceAccess, 'context'> & { context: ContextDTO | null; accessNotice: string }
export type WorkspaceAccess = { context: ContextDTO; contexts: ContextDTO[]; onContextChange: (key: string) => void; onRefreshAccess: () => void; accessLoading: boolean; accessError: string }

/** Context state has no alternate workspace: the existing native Workspace owns all navigation. */
export function CustomerWorkspace({ user, onLogout, renderWorkspace, render }: { user: UserProfile | null; onLogout: () => void; renderWorkspace: (access: WorkspaceAccess) => ReactNode; render: (access: CustomerAccess, workspace: ReactNode) => ReactNode }) {
  const [contexts, setContexts] = useState<ContextDTO[]>([])
  const [selected, setSelected] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const selectedRef = useRef('')
  const initialized = useRef(false)
  const generation = useRef(0)
  const sessionUser = useRef<string | null>(null)
  const onLogoutRef = useRef(onLogout); onLogoutRef.current = onLogout
  const userId = user?.id ?? null
  const currentUser = !!user && sessionUser.current === user.id
  const context = currentUser ? contexts.find(item => contextKey(item) === selected) : undefined
  const load = useCallback(async (signal?: AbortSignal) => {
    const requestedUser = sessionUser.current
    if (!requestedUser) return
    const token = ++generation.current
    setLoading(true)
    try {
      const result = await customer.contexts(signal)
      if (signal?.aborted || generation.current !== token || sessionUser.current !== requestedUser) return
      setContexts(result); setError('')
      if (!initialized.current) {
        initialized.current = true
        const first = result[0]
        selectedRef.current = first ? contextKey(first) : ''
        setProjectAssignment(first?.assignment_id ?? null)
        setSelected(selectedRef.current)
      } else if (!result.some(item => contextKey(item) === selectedRef.current)) {
        if (selectedRef.current) setNotice('Назначение отозвано или изменено. Защищённые материалы закрыты. Выберите доступный контекст.')
        selectedRef.current = ''; setSelected(''); setProjectAssignment(null)
      }
    } catch (reason) {
      if (signal?.aborted || token !== generation.current || sessionUser.current !== requestedUser) return
      setError(customer.errorMessage(reason))
      if (reason instanceof Error && 'status' in reason && reason.status === 401) {
        ++generation.current; initialized.current = false; selectedRef.current = ''; sessionUser.current = null
        setSelected(''); setContexts([]); setProjectAssignment(null); onLogoutRef.current()
      }
    }
    finally { if (!signal?.aborted && token === generation.current) setLoading(false) }
  }, [])
  useEffect(() => {
    sessionUser.current = userId
    initialized.current = false; selectedRef.current = ''; setSelected(''); setContexts([]); setError(''); setNotice(''); setProjectAssignment(null)
    if (!userId) { setLoading(false); return }
    const controller = new AbortController(); void load(controller.signal)
    const timer = setInterval(() => void load(controller.signal), 30_000)
    return () => { controller.abort(); clearInterval(timer); generation.current++; setProjectAssignment(null) }
  }, [load, userId])
  const refresh = useCallback(() => void load(), [load])
  const changeContext = (key: string) => {
    if (!userId || sessionUser.current !== userId) return
    const next = contexts.find(item => contextKey(item) === key)
    if (!next) return
    selectedRef.current = key; setProjectAssignment(next?.assignment_id ?? null); setSelected(key); setNotice('')
  }
  const access: CustomerAccess = { context: context ?? null, contexts: currentUser ? contexts : [], onContextChange: changeContext, onRefreshAccess: refresh, accessLoading: !!user && (!currentUser || loading), accessError: currentUser ? error : '', accessNotice: currentUser ? notice : '' }
  if (!user) return render(access, null)
  if (context) return render(access, <div className="native-workspace" key={`${contextKey(context)}:${context.authorization_version}`}>{renderWorkspace({ context, contexts, onContextChange: changeContext, onRefreshAccess: refresh, accessLoading: loading, accessError: error })}</div>)
  return render(access, <div className="app access-empty">
    <header className="bar"><span className="brand">СК</span><span className="ctx"><small>Стройконтроль</small><span className="no-caret">{user.username}</span></span><div className="grow" /><button className="btn small" type="button" onClick={onLogout}>Выйти</button></header>
    <main className="access-content"><section className="panel access-state">
      <span className="kicker">Рабочее пространство</span><h1>{loading ? 'Загружаем назначения…' : 'Выберите доступное назначение'}</h1>
      {(error || notice) && <p className="err-line" role="alert">{error || notice}</p>}
      {!loading && !contexts.length && <p>В этой организации вам пока не назначены объекты. Примите приглашение или обратитесь к администратору своей организации.</p>}
      {contexts.map(item => <button className="btn" key={contextKey(item)} type="button" onClick={() => changeContext(contextKey(item))}>{item.organization_name} / {item.project_name} / {roleName(item)}</button>)}
      <button className="btn small" type="button" disabled={loading} onClick={refresh}>Обновить доступы</button>
    </section><CustomerOrganizations user={user} onChanged={refresh} /></main>
  </div>)
}
