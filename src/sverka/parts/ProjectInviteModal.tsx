import { useEffect, useRef, useState } from 'react'
import * as api from '../api'
import type { ProjectInviteKeyItem } from '../api'
import type { ContextDTO } from '../customerApi'
import { CloseIcon } from './common'

interface JoinByKeyModalProps {
  open: boolean
  onClose: () => void
  onSuccess: (result: api.JoinByKeyResult) => void
}

export function JoinByKeyModal({ open, onClose, onSuccess }: JoinByKeyModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [key, setKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [successMsg, setSuccessMsg] = useState('')

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      setError('')
      setSuccessMsg('')
      setKey('')
      if (!dialog.open) dialog.showModal()
    } else {
      if (dialog.open) dialog.close()
    }
  }, [open])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = key.trim()
    if (!trimmed) {
      setError('Введите ключ приглашения')
      return
    }
    setLoading(true)
    setError('')
    try {
      const res = await api.joinProjectByKey(trimmed)
      setSuccessMsg(res.message || 'Вы успешно подключены к объекту!')
      setTimeout(() => {
        onSuccess(res)
        onClose()
      }, 1200)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось подключиться по данному ключу')
    } finally {
      setLoading(false)
    }
  }

  return (
    <dialog ref={dialogRef} className="customer-dialog" onClose={onClose}>
      <div className="customer-dialog-head">
        <div>
          <h2>Подключение к объекту</h2>
          <p className="customer-muted">Введите ключ-приглашение для автоматического доступа к объекту в назначенной роли</p>
        </div>
        <button type="button" className="close-x" onClick={onClose} aria-label="Закрыть">
          <CloseIcon />
        </button>
      </div>

      <div className="customer-dialog-body">
        {error && <div className="customer-notice" data-kind="error">{error}</div>}
        {successMsg && <div className="customer-notice" data-kind="demo">{successMsg}</div>}

        <form onSubmit={handleSubmit} className="customer-form">
          <label>
            Ключ приглашения в проект
            <input
              type="text"
              placeholder="PRJ-XXXX-XXXX"
              value={key}
              onChange={(e) => setKey(e.target.value.toUpperCase())}
              disabled={loading || !!successMsg}
              autoFocus
              style={{ textTransform: 'uppercase', letterSpacing: '1px', fontFamily: 'monospace', fontSize: '16px' }}
            />
          </label>

          <div className="customer-actions">
            <button type="submit" className="btn primary" disabled={loading || !!successMsg || !key.trim()}>
              {loading ? 'Подключение…' : 'Подключиться к объекту'}
            </button>
            <button type="button" className="btn" onClick={onClose} disabled={loading}>
              Отмена
            </button>
          </div>
        </form>
      </div>
    </dialog>
  )
}

interface ProjectInviteManagerModalProps {
  open: boolean
  context: ContextDTO
  onClose: () => void
}

export function ProjectInviteManagerModal({ open, context, onClose }: ProjectInviteManagerModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [tab, setTab] = useState<'create' | 'list'>('create')
  const [role, setRole] = useState<'contractor_foreman' | 'pto_engineer' | 'customer_manager' | 'project_viewer'>('contractor_foreman')
  const [expiresInDays, setExpiresInDays] = useState<number | null>(30)
  const [maxUses, setMaxUses] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [createdKey, setCreatedKey] = useState<ProjectInviteKeyItem | null>(null)
  const [copied, setCopied] = useState(false)
  const [invites, setInvites] = useState<ProjectInviteKeyItem[]>([])
  const [listLoading, setListLoading] = useState(false)

  const loadInvites = async () => {
    setListLoading(true)
    try {
      const data = await api.listProjectInvites(context.project_id)
      setInvites(data)
    } catch {
      // ignore
    } finally {
      setListLoading(false)
    }
  }

  useEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    if (open) {
      setError('')
      setCreatedKey(null)
      setCopied(false)
      loadInvites()
      if (!dialog.open) dialog.showModal()
    } else {
      if (dialog.open) dialog.close()
    }
  }, [open, context.project_id])

  useEffect(() => {
    if (open && tab === 'list') {
      loadInvites()
    }
  }, [tab, open])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')
    setCreatedKey(null)
    setCopied(false)
    try {
      const res = await api.createProjectInvite(context.project_id, {
        role,
        expires_in_days: expiresInDays,
        max_uses: maxUses,
      })
      setCreatedKey(res)
      loadInvites()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать ключ приглашения')
    } finally {
      setLoading(false)
    }
  }

  const handleRevoke = async (inviteId: string) => {
    try {
      await api.deleteProjectInvite(context.project_id, inviteId)
      await loadInvites()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отозвать ключ')
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const roleLabel = (r: string) => {
    if (r === 'contractor_foreman') return 'Прораб / Генподрядчик'
    if (r === 'pto_engineer') return 'Инженер ПТО'
    if (r === 'customer_manager') return 'Руководитель проекта'
    if (r === 'project_viewer') return 'Наблюдатель'
    return r
  }

  return (
    <dialog ref={dialogRef} className="customer-dialog" onClose={onClose}>
      <div className="customer-dialog-head">
        <div>
          <h2>Ключи приглашений в проект</h2>
          <p className="customer-muted">{context.project_name} · Управление доступом по ключам</p>
        </div>
        <button type="button" className="close-x" onClick={onClose} aria-label="Закрыть">
          <CloseIcon />
        </button>
      </div>

      <div className="customer-dialog-body">
        <div className="tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'create'} onClick={() => setTab('create')}>
            Создать ключ
          </button>
          <button type="button" role="tab" aria-selected={tab === 'list'} onClick={() => setTab('list')}>
            Список ключей ({invites.length})
          </button>
        </div>

        {error && <div className="customer-notice" data-kind="error">{error}</div>}

        {tab === 'create' && (
          <form onSubmit={handleCreate} className="customer-form">
            <label>
              Роль приглашаемого участника
              <select
                value={role}
                onChange={(e) => setRole(e.target.value as any)}
                disabled={loading}
              >
                <option value="contractor_foreman">Прораб / Генподрядчик (контроль площадки, камеры, устранение замечаний)</option>
                <option value="pto_engineer">Инженер ПТО (ППР, ПОС, соответствие техники этапам, календарный график)</option>
                <option value="customer_manager">Руководитель проекта / Заказчик (полное управление, утверждения, отчёты)</option>
                <option value="project_viewer">Инспектор / Наблюдатель (только просмотр камер и хроники)</option>
              </select>
            </label>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
              <label>
                Срок действия
                <select
                  value={expiresInDays ?? ''}
                  onChange={(e) => setExpiresInDays(e.target.value ? Number(e.target.value) : null)}
                  disabled={loading}
                >
                  <option value="7">7 дней</option>
                  <option value="30">30 дней</option>
                  <option value="90">90 дней</option>
                  <option value="">Бессрочно</option>
                </select>
              </label>

              <label>
                Лимит использований
                <select
                  value={maxUses ?? ''}
                  onChange={(e) => setMaxUses(e.target.value ? Number(e.target.value) : null)}
                  disabled={loading}
                >
                  <option value="">Без ограничений (многоразовый)</option>
                  <option value="1">1 использование (одноразовый)</option>
                  <option value="5">5 использований</option>
                  <option value="20">20 использований</option>
                </select>
              </label>
            </div>

            <div className="customer-actions">
              <button type="submit" className="btn primary" disabled={loading}>
                {loading ? 'Создание…' : 'Сгенерировать ключ приглашения'}
              </button>
            </div>

            {createdKey && (
              <div className="customer-card" style={{ borderColor: 'var(--plan-2)' }}>
                <span className="customer-status" style={{ fontWeight: 600 }}>Ключ приглашения успешно создан!</span>
                <p>Передайте этот ключ сотруднику. При входе он автоматически подключится к объекту в роли <b>{roleLabel(createdKey.role)}</b>.</p>
                <div className="invite-key-display">
                  <span className="invite-key-code">{createdKey.key}</span>
                  <button
                    type="button"
                    className="btn small copy-btn"
                    onClick={() => copyToClipboard(createdKey.key)}
                  >
                    {copied ? '✓ Скопировано' : 'Копировать ключ'}
                  </button>
                </div>
              </div>
            )}
          </form>
        )}

        {tab === 'list' && (
          <div>
            {listLoading ? (
              <p className="customer-muted">Загрузка ключей…</p>
            ) : invites.length === 0 ? (
              <p className="customer-muted">Для этого объекта ещё не создано ключей приглашений.</p>
            ) : (
              <table className="invite-keys-table">
                <thead>
                  <tr>
                    <th>Ключ</th>
                    <th>Роль</th>
                    <th>Использований</th>
                    <th>Истекает</th>
                    <th>Статус</th>
                    <th>Действие</th>
                  </tr>
                </thead>
                <tbody>
                  {invites.map((inv) => (
                    <tr key={inv.id} style={{ opacity: inv.is_active ? 1 : 0.5 }}>
                      <td>
                        <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{inv.key}</span>
                      </td>
                      <td>{roleLabel(inv.role)}</td>
                      <td>{inv.uses_count} {inv.max_uses ? `/ ${inv.max_uses}` : ''}</td>
                      <td>
                        {inv.expires_at
                          ? new Date(inv.expires_at).toLocaleDateString('ru-RU')
                          : 'Бессрочно'}
                      </td>
                      <td>
                        {inv.is_active ? (
                          <span style={{ color: 'var(--success, #10b981)' }}>Активен</span>
                        ) : (
                          <span style={{ color: 'var(--err, #ef4444)' }}>Отозван</span>
                        )}
                      </td>
                      <td>
                        {inv.is_active && (
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              type="button"
                              className="btn small"
                              onClick={() => copyToClipboard(inv.key)}
                              title="Копировать ключ"
                            >
                              Копировать
                            </button>
                            <button
                              type="button"
                              className="btn small danger"
                              onClick={() => handleRevoke(inv.id)}
                              title="Отозвать ключ"
                            >
                              Отозвать
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </dialog>
  )
}
