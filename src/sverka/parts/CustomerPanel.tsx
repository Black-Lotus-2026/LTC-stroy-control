import { useEffect, useLayoutEffect, useRef } from 'react'
import type { ContextDTO } from '../customerApi'
import type { UserProfile } from '../api'
import { Spring, clamp } from '../lib/spring'
import { CloseIcon } from './common'
import { can, roleName } from './CustomerWorkspace'
import { CustomerCases } from './CustomerCases'
import { CustomerDocuments } from './CustomerDocuments'
import { CustomerCameras } from './CustomerCameras'
import { CustomerParticipants } from './CustomerParticipants'
import { CustomerReports } from './CustomerReports'
import { CustomerNotifications } from './CustomerNotifications'
import { CustomerOrganizations } from './CustomerOrganizations'
export type CustomerSection = 'cases' | 'documents' | 'cameras' | 'participants' | 'reports' | 'notifications' | 'organizations'
export function CustomerPanel({ context, user, section, onSection, onClose, onAccessChanged }: { context: ContextDTO; user: UserProfile; section: CustomerSection; onSection: (section: CustomerSection) => void; onClose: () => void; onAccessChanged: () => void }) {
  const el = useRef<HTMLElement>(null); const scrim = useRef<HTMLDivElement>(null); const spring = useRef<Spring | null>(null)
  const callbacks = useRef({ onClose }); callbacks.current = { onClose }
  const closing = useRef(false)
  const close = () => { if (closing.current) return; closing.current = true; spring.current?.to(0, { damping: 1, onRest: () => callbacks.current.onClose() }) }
  useLayoutEffect(() => {
    const mobile = matchMedia('(max-width: 860px)').matches
    spring.current = new Spring(0, { response: .48, damping: .92, rest: .002, onUpdate: value => { if (el.current) el.current.style.transform = mobile ? `translateY(${(1 - value) * 104}%)` : `translateX(${(1 - value) * 108}%)`; if (scrim.current) scrim.current.style.opacity = String(clamp(value, 0, 1) * .8) } })
    spring.current.set(0); spring.current.to(1)
    const previous = document.activeElement as HTMLElement | null
    el.current?.querySelector<HTMLElement>('#customerSheetTitle')?.focus({ preventScroll: true })
    return () => previous?.focus?.({ preventScroll: true })
  }, [])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (document.querySelector('dialog[open]')) return
      if (event.key === 'Escape') { close(); return }
      if (event.key !== 'Tab' || !el.current) return
      const nodes = [...el.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]')].filter(node => node.getClientRects().length > 0)
      const first = nodes[0], last = nodes.at(-1)
      if (!first || !last) { event.preventDefault(); return }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === el.current.querySelector('#customerSheetTitle') || !el.current.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === el.current.querySelector('#customerSheetTitle') || !el.current.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    addEventListener('keydown', key); return () => removeEventListener('keydown', key)
  })
  const sections: { key: CustomerSection; label: string; available: boolean }[] = [
    { key: 'cases', label: context.role === 'contractor_foreman' ? 'Мои задачи' : 'Решения', available: can(context, 'incident.read') },
    { key: 'documents', label: 'ППР', available: can(context, 'document.read') },
    { key: 'cameras', label: 'Камеры', available: can(context, 'camera.read') },
    { key: 'participants', label: 'Участники', available: can(context, 'assignment.manage') },
    { key: 'reports', label: 'Отчёты', available: can(context, 'report.read') },
    { key: 'notifications', label: 'Уведомления', available: true },
    { key: 'organizations', label: 'Организации', available: true },
  ]
  const title = section === 'documents' ? 'Документы и требования' : section === 'cases' ? context.role === 'contractor_foreman' ? 'Мои задачи' : 'Решения заказчика' : sections.find(item => item.key === section)?.label ?? 'Рабочее пространство'
  return <><div className="scrim" data-on="true" ref={scrim} onClick={close} /><section className="sheet customer-role-sheet" ref={el} role="dialog" aria-modal="true" aria-labelledby="customerSheetTitle"><div className="sheet-head"><div><h2 id="customerSheetTitle" tabIndex={-1}>{title}</h2><p>{context.project_name} · {roleName(context)}</p></div><button className="close-x" type="button" aria-label="Закрыть рабочую панель" onClick={close}><CloseIcon /></button></div><div className="tabs" role="tablist" aria-label="Рабочие разделы">{sections.filter(item => item.available).map(item => <button type="button" role="tab" key={item.key} aria-selected={item.key === section} onClick={() => onSection(item.key)}>{item.label}</button>)}</div><div className="sheet-body">
    {section === 'cases' && can(context, 'incident.read') ? <CustomerCases context={context} onAccessChanged={onAccessChanged} /> : section === 'documents' && can(context, 'document.read') ? <CustomerDocuments context={context} user={user} /> : section === 'cameras' && can(context, 'camera.read') ? <CustomerCameras context={context} /> : section === 'participants' && can(context, 'assignment.manage') ? <CustomerParticipants context={context} onChanged={onAccessChanged} /> : section === 'reports' && can(context, 'report.read') ? <CustomerReports context={context} /> : section === 'notifications' ? <CustomerNotifications context={context} onAccessChanged={onAccessChanged} onDocuments={() => onSection('documents')} /> : section === 'organizations' ? <CustomerOrganizations user={user} onChanged={onAccessChanged} /> : <p className="q-empty">Раздел недоступен в текущем назначении.</p>}
  </div></section></>
}
