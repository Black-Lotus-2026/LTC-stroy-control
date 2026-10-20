import { useState } from 'react'
import type { ApiAlert, ProjectItem } from '../api'
import { atTime, durShort } from '../lib/format'
import { Seg } from './common'

type Filter = 'all' | 'assigned' | 'escalated'
const KIND: Record<string, string> = { assigned: 'назначено вам', escalated: 'эскалация', verified: 'исправление подтверждено' }
const SHOWN = 8

/** Where a task stands, in a few words: the deadline while it is open, the outcome once closed. */
export function taskState(a: ApiAlert, now: number): { text: string; late: boolean } {
  if (a.incident_status === 'resolved') return { text: 'дело закрыто · основание в истории', late: false }
  if (a.incident_status === 'remediation_submitted') return { text: 'устранение заявлено · ожидает приёмки заказчиком', late: false }
  if (a.incident_status === 'false_positive') return { text: 'закрыто как ложное', late: false }
  if (a.verification_status === 'requested') return { text: 'проверка исправления запрошена', late: false }
  if (!a.sla_deadline) return { text: 'срок не задан', late: false }
  const d = new Date(a.sla_deadline).getTime()
  return d <= now ? { text: `срок истёк ${durShort(now - d)} назад`, late: true } : { text: `до ${atTime(d, now)} · осталось ${durShort(d - now)}`, late: false }
}

/** The user's tasks across objects. A task is its event: choosing one opens the event's case. */
export function TaskList({ alerts, projects, current, onOpen }: { alerts: ApiAlert[]; projects: ProjectItem[]; current: string | null; onOpen: (a: ApiAlert) => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const now = Date.now()
  const both = alerts.some((a) => a.kind === 'escalated') && alerts.some((a) => a.kind === 'assigned')
  const shown = alerts.filter((a) => filter === 'all' || a.kind === filter)
  return (
    <>
      <div className="m-k tasks-head">
        <span className="kicker">Уведомления</span>
        {both && (
          <Seg
            label="Какие задачи показать"
            value={filter}
            options={[
              { v: 'all', label: 'Все' },
              { v: 'assigned', label: 'Мои' },
              { v: 'escalated', label: 'Эскалации' },
            ]}
            onChange={(v) => setFilter(v)}
          />
        )}
      </div>
      {shown.slice(0, SHOWN).map((a) => {
        const st = taskState(a, now)
        const other = a.project_id !== current ? projects.find((p) => p.id === a.project_id)?.name : null
        return (
          <button key={a.id} type="button" className="m-item task" role="menuitem" data-kind={a.kind} data-unread={!a.read_at || undefined} onClick={() => onOpen(a)}>
            <span className="t-mark" aria-label={a.read_at ? undefined : 'новая'} />
            <span>
              <b>{a.title}</b>
              <small>
                {KIND[a.kind] ?? a.kind}
                {' · '}
                <span className={st.late ? 'late' : undefined}>{st.text}</span>
                {other ? ` · ${other}` : ''}
              </small>
            </span>
          </button>
        )
      })}
      {!shown.length && <div className="m-note">Уведомлений нет.</div>}
      {shown.length > SHOWN && <div className="m-note">Показаны последние {SHOWN} из {shown.length}.</div>}
    </>
  )
}
