import { useEffect, useState } from 'react'
import * as api from '../api'
import type { UserProfile } from '../api'
import { reducedMotion } from '../lib/spring'

export function Auth({ onAuth, offline }: { onAuth: (u: UserProfile) => void; offline?: string | null }) {
  const [tab, setTab] = useState<'login' | 'register'>('login')
  const [f, setF] = useState({ u: '', p: '', c: '' })
  const [role, setRole] = useState<'manager' | 'inspector' | 'admin' | 'viewer'>('manager')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // signed in: the form steps aside first, then the drawing behind it moves to the intro layout
  const [done, setDone] = useState<UserProfile | null>(null)
  useEffect(() => {
    if (!done) return
    const t = window.setTimeout(() => onAuth(done), reducedMotion() ? 0 : 240)
    return () => clearTimeout(t)
  }, [done, onAuth])
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr(null)
    if (tab === 'register' && f.p !== f.c) {
      setErr('Пароли не совпадают')
      return
    }
    setBusy(true)
    try {
      setDone(tab === 'login' ? await api.login(f.u.trim(), f.p) : await api.register(f.u.trim(), f.p, f.c, role))
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'Не получилось')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="auth" data-leaving={done ? true : undefined}>
      <div className="auth-card">
        <div className="brand" aria-hidden="true">
          СК
        </div>
        <h1>Строй-контроль</h1>
        <p>Сверка плана работ с техникой на камерах площадки.</p>
        {offline && <p className="err-line">{offline}</p>}
        <div className="auth-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'login'} onClick={() => setTab('login')}>
            Вход
          </button>
          <button type="button" role="tab" aria-selected={tab === 'register'} onClick={() => setTab('register')}>
            Регистрация
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="form-grid">
            <label>
              Логин
              <input className="input" id="authUser" autoComplete="username" value={f.u} onChange={(e) => setF({ ...f, u: e.target.value })} minLength={3} required autoFocus />
            </label>
            <label>
              Пароль
              <input className="input" id="authPass" type="password" autoComplete={tab === 'login' ? 'current-password' : 'new-password'} value={f.p} onChange={(e) => setF({ ...f, p: e.target.value })} minLength={4} required />
            </label>
            {tab === 'register' && (
              <>
                <label>
                  Пароль ещё раз
                  <input className="input" id="authPass2" type="password" autoComplete="new-password" value={f.c} onChange={(e) => setF({ ...f, c: e.target.value })} minLength={4} required />
                </label>
                <label>
                  Роль в системе
                  <select className="select" id="authRole" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                    <option value="manager">Руководитель проекта (управление объектом и техникой)</option>
                    <option value="inspector">Инспектор технадзора (фиксация и проверка нарушений)</option>
                    <option value="admin">Администратор (полный доступ)</option>
                    <option value="viewer">Наблюдатель (только чтение)</option>
                  </select>
                </label>
              </>
            )}
          </div>
          {err && <p className="err-line">{err}</p>}
          <div className="form-actions">
            <button type="submit" className="btn primary" disabled={busy || !!done} style={{ width: '100%' }}>
              {busy ? 'Подождите…' : tab === 'login' ? 'Войти' : 'Создать учётную запись'}
            </button>
          </div>
        </form>
        <p className="hint" style={{ marginTop: 18 }}>
          <a className="link" href="#legacy" onClick={() => setTimeout(() => location.reload(), 0)}>
            Открыть старый интерфейс
          </a>
        </p>
      </div>
    </main>
  )
}
