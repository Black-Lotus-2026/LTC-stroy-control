import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CameraItem, ProjectItem, ZoneItem } from '../api'
import type { NumKey, Observation, Settings as S } from '../model'
import { DEFAULTS, KINDS, STEPS, THRESHOLDS } from '../model'
import { clock, durShort, hhmmss, toLocalInput } from '../lib/format'
import { Spring, clamp } from '../lib/spring'
import { CloseIcon } from './common'

export type Probe = (url: string) => Promise<{ ok: boolean; message: string }>

export type SheetTab = 'control' | 'sources' | 'shift' | 'object'

export interface ObjectActions {
  counts: { stages: number; events: number }
  onUpdateProject: (d: { name: string; code: string; address: string; object_kind: string }) => Promise<void>
  onDeleteProject: () => Promise<void>
  onCreateZone: (d: ZoneDraft) => Promise<void>
  onUpdateZone: (id: string, d: ZoneDraft) => Promise<void>
  onDeleteZone: (id: string) => Promise<void>
  onUpdateCamera: (id: string, name: string, url: string, zoneId: string | null) => Promise<void>
}
export interface ZoneDraft { name: string; code: string; description: string }

export function SettingsSheet({
  tab: initialTab,
  settings,
  onSettings,
  obs,
  cameras,
  project,
  zones,
  onAddCamera,
  onDeleteCamera,
  onCheck,
  onRecording,
  onClose,
  objectActions,
}: {
  tab: SheetTab
  settings: S
  onSettings: (s: S) => void
  obs: Observation
  cameras: CameraItem[]
  project: ProjectItem
  zones: ZoneItem[]
  onAddCamera: (name: string, url: string, zoneId?: string | null) => Promise<void>
  onDeleteCamera: (id: string) => Promise<void>
  onCheck: Probe
  onRecording: (f: File, start: number) => void
  onClose: () => void
  objectActions: ObjectActions
}) {
  const [tab, setTab] = useState<SheetTab>(initialTab)
  const el = useRef<HTMLElement>(null)
  const scrim = useRef<HTMLDivElement>(null)
  const closing = useRef(false)
  const sp = useRef<Spring | null>(null)
  const ind = useRef<HTMLElement>(null)
  const ix = useRef(new Spring(0, { response: 0.36, damping: 0.86, rest: 0.2, onUpdate: (v) => ind.current && (ind.current.style.transform = `translateX(${v}px)`) }))
  const iw = useRef(new Spring(0, { response: 0.36, damping: 0.9, rest: 0.2, onUpdate: (v) => ind.current && (ind.current.style.width = v + 'px') }))
  const first = useRef(true)

  useLayoutEffect(() => {
    const mob = matchMedia('(max-width: 860px)').matches
    sp.current = new Spring(0, {
      response: 0.48,
      damping: 0.92,
      rest: 0.002,
      onUpdate: (p) => {
        // enters from the side of the button that opened it and leaves the same way
        if (el.current) el.current.style.transform = mob ? `translateY(${(1 - p) * 104}%)` : `translateX(${(1 - p) * 108}%)`
        if (scrim.current) scrim.current.style.opacity = String(clamp(p, 0, 1) * 0.8)
      },
    })
    sp.current.set(0)
    sp.current.to(1)
    const back = document.activeElement as HTMLElement | null
    window.setTimeout(() => el.current?.querySelector<HTMLElement>('#sheetTitle')?.focus({ preventScroll: true }), 40)
    return () => back?.focus?.({ preventScroll: true })
  }, [])
  useLayoutEffect(() => {
    const b = el.current?.querySelector<HTMLElement>('.tabs button[aria-selected="true"]')
    if (!b) return
    if (first.current) {
      ix.current.set(b.offsetLeft)
      iw.current.set(b.offsetWidth)
      first.current = false
    } else {
      ix.current.to(b.offsetLeft)
      iw.current.to(b.offsetWidth)
    }
  }, [tab])
  const close = () => {
    if (closing.current) return
    closing.current = true
    sp.current?.to(0, { damping: 1, onRest: onClose })
  }
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close()
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  })

  const set = (k: NumKey, d: number) => {
    const steps = STEPS[k]
    let i = steps.findIndex((v) => v >= settings[k])
    if (i < 0) i = steps.length - 1
    const n = { ...settings, [k]: steps[clamp(i + d, 0, steps.length - 1)] }
    if (n.errAfter <= n.warnAfter) n.errAfter = STEPS.errAfter.find((v) => v > n.warnAfter) ?? n.errAfter
    onSettings(n)
  }
  const row = (p: { k: NumKey; title: string; desc: string; where?: string }) => <SetRow key={p.k} {...p} settings={settings} onStep={set} onSettings={onSettings} />

  return (
    <>
      <div className="scrim" data-on="true" ref={scrim} onClick={close} style={{ opacity: 0 }} />
      <section className="sheet" ref={el} role="dialog" aria-modal="true" aria-labelledby="sheetTitle" style={{ transform: 'translateX(108%)' }}>
        <div className="sheet-head">
          <div>
            <h2 id="sheetTitle" tabIndex={-1}>
              Настройки контроля
            </h2>
            <p>{project.name}</p>
          </div>
          <button type="button" className="close-x" onClick={close} aria-label="Закрыть">
            <CloseIcon />
          </button>
        </div>
        <div className="tabs" role="tablist">
          {(
            [
              ['control', 'Контроль'],
              ['sources', 'Источники'],
              ['shift', 'Смена'],
              ['object', 'Объект'],
            ] as const
          ).map(([k, v]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {v}
            </button>
          ))}
          <i className="bar-ind" ref={ind} />
        </div>
        <div className="sheet-body">
          {tab === 'control' && (
            <>
              {row({ k: "window", title: "Окно сверки", desc: "Техника считается замеченной, если найдена хотя бы на одном кадре любого источника за это время.", where: "Сохраняется на сервере" })}
              {row({ k: "conf", title: "Порог уверенности распознавания", desc: "Рамки с меньшей уверенностью не учитываются и не показываются." })}
              {row({ k: "warnAfter", title: "Предупреждение, если обязательной техники нет", desc: "Общее значение. У отдельной техники на этапе можно задать своё в правиле." })}
              {row({ k: "errAfter", title: "Отклонение, если её нет", desc: "После этого времени предупреждение считается отклонением." })}
              {row({ k: "oopAfter", title: "Техника не по этапу", desc: "Создать отклонение, если нехарактерная техника видна дольше этого времени." })}
              <div className="set-row">
                <div>
                  <h4>Демо-распознавание</h4>
                  <p>Если модель недоступна, детекции подставляются по демо-сцене, чтобы показать весь сценарий. Экран и события помечаются как демо.</p>
                </div>
                <button type="button" className="toggle" role="switch" aria-checked={settings.demo} onClick={() => onSettings({ ...settings, demo: !settings.demo })}>
                  <span className="sw" />
                  {settings.demo ? 'Включено' : 'Выключено'}
                </button>
                <div className="def">
                  {obs.model === 'demo' ? `Сейчас работает: ${obs.modelMessage || 'модель недоступна'}` : obs.model === 'ready' ? 'Сейчас не нужно: модель отвечает' : 'Включится, если модель не ответит'}
                  <span>Хранится в этом браузере</span>
                </div>
              </div>
              <div className="set-row">
                <div>
                  <h4>Пороги профиля этапа</h4>
                  <p>Как доля этапов справочника, где встречается техника, переводится в требование. Задаются на сервере.</p>
                </div>
                <span />
                <div className="thresholds">
                  {THRESHOLDS.map((x) => (
                    <div key={x.v}>
                      <b>{x.v}</b>
                      {x.l}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
          {tab === 'sources' && <Sources obs={obs} cameras={cameras} zones={zones} onAdd={onAddCamera} onUpdate={objectActions.onUpdateCamera} onDelete={onDeleteCamera} onCheck={onCheck} onRecording={onRecording} />}
          {tab === 'object' && <ObjectPane project={project} zones={zones} cameras={cameras} a={objectActions} />}
          {tab === 'shift' && (
            <>
              {row({ k: "shiftFrom", title: "Начало смены", desc: "Вне смены отсутствие техники не считается отклонением." })}
              {row({ k: "shiftTo", title: "Конец смены", desc: "После конца смены события об отсутствии техники не создаются." })}
              {row({ k: "startGrace", title: "Сбор техники после начала смены", desc: "Сколько ждать, прежде чем считать технику отсутствующей, если с начала смены её ещё не было." })}
            </>
          )}
        </div>
      </section>
    </>
  )
}

const fmtVal = (k: NumKey, v: number) => (k === 'conf' ? `${v}%` : k === 'window' ? `${v} с` : k === 'shiftFrom' || k === 'shiftTo' ? clock(v) : durShort(v * 1000))

function SetRow({ k, title, desc, where, settings, onStep, onSettings }: { k: NumKey; title: string; desc: string; where?: string; settings: S; onStep: (k: NumKey, d: number) => void; onSettings: (s: S) => void }) {
  return (
    <div className="set-row">
      <div>
        <h4>{title}</h4>
        <p>{desc}</p>
      </div>
      <div className="stepper">
        <button type="button" aria-label={`${title}: меньше`} onClick={() => onStep(k, -1)}>
          −
        </button>
        <output aria-live="polite">{fmtVal(k, settings[k])}</output>
        <button type="button" aria-label={`${title}: больше`} onClick={() => onStep(k, 1)}>
          +
        </button>
      </div>
      <div className="def">
        По умолчанию: {fmtVal(k, DEFAULTS[k])}
        {settings[k] !== DEFAULTS[k] && (
          <>
            <span className="changed">изменено</span>
            <button type="button" onClick={() => onSettings({ ...settings, [k]: DEFAULTS[k] })}>
              Сбросить
            </button>
          </>
        )}
        <span>{where || 'Хранится в этом браузере'}</span>
      </div>
    </div>
  )
}

const STATUS_LINE: Record<string, string> = {
  live: 'Кадры приходят',
  connecting: 'Подключаемся…',
  offline: 'Нет сигнала',
  stale: 'Кадр не меняется',
  unsupported: 'Не поддерживается браузером',
  idle: 'Пауза: открыта запись',
}

function Sources({ obs, cameras, zones, onAdd, onUpdate, onDelete, onCheck, onRecording }: { obs: Observation; cameras: CameraItem[]; zones: ZoneItem[]; onAdd: (n: string, u: string, z?: string | null) => Promise<void>; onUpdate: (id: string, n: string, u: string, z: string | null) => Promise<void>; onDelete: (id: string) => Promise<void>; onCheck: Probe; onRecording: (f: File, start: number) => void }) {
  const [form, setForm] = useState<null | 'camera' | 'recording'>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [checks, setChecks] = useState<Record<string, string>>({})
  return (
    <>
      {cameras.length === 0 && obs.mode === 'live' && <div className="empty-note">Камер пока нет.</div>}
      {obs.mode === 'recording' && obs.recording && (
        <div className="src-row">
          <span className="t-snap-none" style={{ position: 'static', width: 96, aspectRatio: '16/9' }}>запись</span>
          <div>
            <b>{obs.recording.name}</b>
            <small>Запись · начало {hhmmss(obs.recording.start)} · камеры на паузе</small>
          </div>
          <span />
        </div>
      )}
      {cameras.map((c) => {
        const v = obs.sources.find((s) => s.id === c.id)
        const st = v?.status || 'idle'
        const zone = zones.find((z) => z.id === c.zone_id)
        if (editing === c.id)
          return (
            <div className="src-edit" key={c.id}>
              <span className="kicker">Камера · изменение</span>
              <CameraForm
                zones={zones}
                initial={{ name: c.name, url: c.stream_url || '', zoneId: c.zone_id ?? null }}
                submitLabel="Сохранить"
                onAdd={(n, u, z) => onUpdate(c.id, n, u, z ?? null).then(() => setEditing(null))}
                onCheck={onCheck}
                onCancel={() => setEditing(null)}
              />
            </div>
          )
        return (
          <div className="src-row" key={c.id}>
            {v?.snapshot ? <img src={v.snapshot} alt="" /> : <span className="t-snap-none" style={{ position: 'static', width: 96, aspectRatio: '16/9' }}>нет кадра</span>}
            <div>
              <b>{c.name}</b>
              <small className={st === 'live' ? 'ok' : st === 'connecting' || st === 'idle' ? '' : 'bad'}>
                {STATUS_LINE[st]}
                {v?.message ? ` · ${v.message}` : ''}
              </small>
              <small className="mono">{c.stream_url || 'адрес не указан'}</small>
              {zones.length > 0 && <small>Зона: {zone ? zone.name : 'не указана'}</small>}
              {checks[c.id] && <small>{checks[c.id]}</small>}
            </div>
            <div className="row-actions">
              {confirmDel === c.id ? (
                <span className="confirm-row">
                  Удалить?
                  <button type="button" className="btn small danger" onClick={() => onDelete(c.id).finally(() => setConfirmDel(null))}>
                    Да
                  </button>
                  <button type="button" className="btn small ghost" onClick={() => setConfirmDel(null)}>
                    Нет
                  </button>
                </span>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn small"
                    disabled={!c.stream_url}
                    onClick={async () => {
                      setChecks((x) => ({ ...x, [c.id]: 'Проверяем…' }))
                      try {
                        const r = await onCheck(c.stream_url!)
                        setChecks((x) => ({ ...x, [c.id]: r.message }))
                      } catch (e) {
                        setChecks((x) => ({ ...x, [c.id]: e instanceof Error ? e.message : 'Не удалось проверить' }))
                      }
                    }}
                  >
                    Проверить
                  </button>
                  <button type="button" className="btn small ghost" onClick={() => setEditing(c.id)} aria-label={`Изменить камеру ${c.name}`}>
                    Изменить
                  </button>
                  <button type="button" className="btn small ghost" onClick={() => setConfirmDel(c.id)} aria-label={`Удалить камеру ${c.name}`}>
                    Удалить
                  </button>
                </>
              )}
            </div>
          </div>
        )
      })}
      <div className="set-row">
        <div>
          <h4>Распознавание</h4>
          <p>{obs.model === 'ready' ? `Работает · проанализировано кадров в этом сеансе: ${obs.frames}` : obs.model === 'demo' ? `Модель недоступна (${obs.modelMessage || 'причина не сообщена'}), работает демо-распознавание · кадров: ${obs.frames}` : obs.model === 'down' ? `Недоступно: ${obs.modelMessage || 'причина не сообщена'}` : 'Ждём первый ответ сервиса'}</p>
        </div>
        <span />
      </div>
      {form === 'camera' ? (
        <CameraForm zones={zones} onAdd={onAdd} onCancel={() => setForm(null)} onCheck={onCheck} />
      ) : form === 'recording' ? (
        <RecordingForm onSubmit={(f, s) => { onRecording(f, s); setForm(null) }} onCancel={() => setForm(null)} />
      ) : (
        <div className="form-actions">
          <button type="button" className="btn small" onClick={() => setForm('camera')}>
            Добавить камеру
          </button>
          <button type="button" className="btn small" onClick={() => setForm('recording')}>
            Открыть запись
          </button>
        </div>
      )}
    </>
  )
}

export function CameraForm({
  onAdd,
  onCancel,
  onCheck,
  zones = [],
  initial,
  submitLabel = 'Проверить и сохранить',
}: {
  onAdd: (n: string, u: string, zoneId?: string | null) => Promise<void>
  onCancel?: () => void
  onCheck: Probe
  zones?: ZoneItem[]
  initial?: { name: string; url: string; zoneId: string | null }
  submitLabel?: string
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [url, setUrl] = useState(initial?.url ?? '')
  const [zoneId, setZoneId] = useState<string | null>(initial ? initial.zoneId : zones[0]?.id ?? null)
  const [state, setState] = useState<{ s: 'idle' | 'busy' | 'error' | 'warn'; msg?: string }>({ s: 'idle' })
  const rtsp = /^rtsp:\/\//i.test(url.trim())
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !url.trim()) return
    setState({ s: 'busy', msg: 'Проверяем связь…' })
    try {
      // the address did not change: nothing to check again
      if (initial && url.trim() === initial.url.trim()) {
        await onAdd(name.trim(), url.trim(), zoneId)
        setState({ s: 'idle' })
        return
      }
      const r = await onCheck(url.trim())
      if (!r.ok) {
        setState({ s: 'warn', msg: `${r.message}. Камеру можно сохранить, но кадров не будет, пока связь не появится.` })
        return
      }
      await onAdd(name.trim(), url.trim(), zoneId)
      if (!initial) {
        setName('')
        setUrl('')
      }
      setState({ s: 'idle' })
      if (!initial) onCancel?.()
    } catch (err) {
      setState({ s: 'error', msg: err instanceof Error ? err.message : 'Не удалось сохранить камеру' })
    }
  }
  return (
    <form onSubmit={submit}>
      <div className="form-grid two-col">
        <label>
          Название
          <input className="input" id="camName" value={name} onChange={(e) => setName(e.target.value)} placeholder="Котлован · общий план" required />
        </label>
        <label>
          Адрес потока
          <input className="input mono" id="camUrl" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://10.20.1.11/mjpeg" required />
        </label>
      </div>
      {zones.length > 0 && (
        <div className="form-grid">
          <label>
            Зона
            <select className="select" value={zoneId ?? ''} onChange={(e) => setZoneId(e.target.value || null)}>
              <option value="">Без зоны</option>
              {zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {rtsp && <p className="hint">RTSP-поток браузер не воспроизводит: камера сохранится, но для анализа нужен HTTP/MJPEG-адрес или серверный шлюз.</p>}
      {state.msg && <p className={state.s === 'error' ? 'err-line' : 'hint'}>{state.msg}</p>}
      <div className="form-actions">
        <button type="submit" className="btn small primary" disabled={state.s === 'busy'}>
          {state.s === 'busy' ? 'Проверяем…' : submitLabel}
        </button>
        {state.s === 'warn' && (
          <button type="button" className="btn small" onClick={() => onAdd(name.trim(), url.trim(), zoneId).then(() => { setState({ s: 'idle' }); if (!initial) onCancel?.() }, (err) => setState({ s: 'error', msg: err.message }))}>
            Сохранить без проверки
          </button>
        )}
        {onCancel && (
          <button type="button" className="btn small ghost" onClick={onCancel}>
            Отмена
          </button>
        )}
      </div>
    </form>
  )
}

export function RecordingForm({ onSubmit, onCancel }: { onSubmit: (f: File, start: number) => void; onCancel?: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [start, setStart] = useState(() => toLocalInput(new Date()))
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (file && start) onSubmit(file, new Date(start).getTime())
      }}
    >
      <div className="form-grid two-col">
        <label>
          Файл записи
          <input className="input" type="file" accept="video/*" onChange={(e) => setFile(e.target.files?.[0] || null)} required />
        </label>
        <label>
          Дата и время начала съёмки
          <input className="input" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} required />
        </label>
      </div>
      <p className="hint">По времени начала система найдёт этап плана. Без него сверка с планом невозможна.</p>
      <div className="form-actions">
        <button type="submit" className="btn small primary" disabled={!file}>
          Открыть запись
        </button>
        {onCancel && (
          <button type="button" className="btn small ghost" onClick={onCancel}>
            Отмена
          </button>
        )}
      </div>
    </form>
  )
}

/* ── Object: its card, the zones of the site, and deleting it ─────────────── */
function ObjectPane({ project, zones, cameras, a }: { project: ProjectItem; zones: ZoneItem[]; cameras: CameraItem[]; a: ObjectActions }) {
  const init = { name: project.name, code: project.code || '', address: project.address || '', object_kind: project.object_kind || KINDS[0] }
  const [f, setF] = useState(init)
  const [st, setSt] = useState<{ s: 'idle' | 'saving' | 'saved' | 'error'; msg?: string }>({ s: 'idle' })
  const [zoneForm, setZoneForm] = useState<string | 'new' | null>(null)
  const [zoneDel, setZoneDel] = useState<string | null>(null)
  const [ask, setAsk] = useState(false)
  const [typed, setTyped] = useState('')
  const [delBusy, setDelBusy] = useState(false)
  const [delErr, setDelErr] = useState<string | null>(null)
  const dirty = (Object.keys(init) as (keyof typeof init)[]).some((k) => f[k].trim() !== init[k].trim())
  const kinds = KINDS.includes(f.object_kind) ? KINDS : [f.object_kind, ...KINDS]
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!f.name.trim() || !dirty) return
    setSt({ s: 'saving' })
    try {
      await a.onUpdateProject(f)
      setSt({ s: 'saved' })
    } catch (err) {
      setSt({ s: 'error', msg: err instanceof Error ? err.message : 'Не удалось сохранить' })
    }
  }
  return (
    <>
      <section className="obj-sec">
        <span className="kicker">Карточка объекта</span>
        <form onSubmit={save}>
          <div className="form-grid two-col">
            <label style={{ gridColumn: '1 / -1' }}>
              Название
              <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
            </label>
            <label>
              Код
              <input className="input mono" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="PRJ-SEV" />
            </label>
            <label>
              Тип объекта
              <select className="select" value={f.object_kind} onChange={(e) => setF({ ...f, object_kind: e.target.value })}>
                {kinds.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label style={{ gridColumn: '1 / -1' }}>
              Адрес
              <input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} placeholder="г. Москва, ул. Строителей, 12" />
            </label>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn small primary" disabled={!dirty || st.s === 'saving' || !f.name.trim()}>
              {st.s === 'saving' ? 'Сохраняем…' : 'Сохранить'}
            </button>
            {dirty && (
              <button type="button" className="btn small ghost" onClick={() => { setF(init); setSt({ s: 'idle' }) }}>
                Отменить правки
              </button>
            )}
            {st.s === 'saved' && !dirty && <span className="save-state" data-s="saved">Сохранено</span>}
            {st.s === 'error' && <span className="err-line">{st.msg}</span>}
          </div>
        </form>
        <p className="hint">Тип объекта пока только подписывает объект: сервер не учитывает его, когда сопоставляет этапы плана со справочником.</p>
      </section>

      <section className="obj-sec">
        <div className="obj-head">
          <span className="kicker">Зоны площадки</span>
          {zoneForm !== 'new' && (
            <button type="button" className="btn small" onClick={() => setZoneForm('new')}>
              Добавить зону
            </button>
          )}
        </div>
        {!zones.length && zoneForm !== 'new' && <p className="hint">Зон нет: события относятся ко всему объекту. Зона нужна, если камеры смотрят на разные участки.</p>}
        {zoneForm === 'new' && <ZoneForm onSubmit={(d) => a.onCreateZone(d).then(() => setZoneForm(null))} onCancel={() => setZoneForm(null)} />}
        {zones.map((z) => {
          const n = cameras.filter((c) => c.zone_id === z.id).length
          if (zoneForm === z.id) return <ZoneForm key={z.id} initial={{ name: z.name, code: z.code || '', description: z.description || '' }} onSubmit={(d) => a.onUpdateZone(z.id, d).then(() => setZoneForm(null))} onCancel={() => setZoneForm(null)} />
          return (
            <div className="zone-row" key={z.id}>
              <div>
                <b>
                  {z.name} <span className="mono">{z.code}</span>
                </b>
                <small>
                  {z.description ? `${z.description} · ` : ''}
                  {n ? `${n} ${n === 1 ? 'камера' : n < 5 ? 'камеры' : 'камер'}` : 'камер нет'}
                </small>
              </div>
              <div className="row-actions">
                {zoneDel === z.id ? (
                  <span className="confirm-row">
                    {n ? `Камеры (${n}) останутся без зоны.` : 'Удалить?'}
                    <button type="button" className="btn small danger" onClick={() => a.onDeleteZone(z.id).finally(() => setZoneDel(null))}>
                      Удалить
                    </button>
                    <button type="button" className="btn small ghost" onClick={() => setZoneDel(null)}>
                      Нет
                    </button>
                  </span>
                ) : (
                  <>
                    <button type="button" className="btn small ghost" onClick={() => setZoneForm(z.id)}>
                      Изменить
                    </button>
                    <button type="button" className="btn small ghost" onClick={() => setZoneDel(z.id)}>
                      Удалить
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        })}
        {zones.length > 0 && <p className="hint">Зона камеры попадает в события, снятые этой камерой. Привязать камеру к зоне можно во вкладке «Источники».</p>}
      </section>

      <section className="obj-sec danger-zone">
        <span className="kicker">Удаление объекта</span>
        {!ask ? (
          <div className="obj-head">
            <p className="hint">Объект удаляется вместе с планом, камерами, зонами и журналом событий.</p>
            <button type="button" className="btn small danger" onClick={() => setAsk(true)}>
              Удалить объект…
            </button>
          </div>
        ) : (
          <div className="del-box">
            <p>
              Удалятся план ({a.counts.stages} {a.counts.stages === 1 ? 'этап' : 'этапов'}), камеры ({cameras.length}), зоны ({zones.length}) и журнал событий ({a.counts.events}). Отменить это нельзя.
            </p>
            <label>
              Чтобы подтвердить, введите название объекта
              <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={project.name} autoFocus />
            </label>
            {delErr && <p className="err-line">{delErr}</p>}
            <div className="form-actions">
              <button
                type="button"
                className="btn small danger"
                disabled={typed.trim() !== project.name.trim() || delBusy}
                onClick={() => {
                  setDelBusy(true)
                  setDelErr(null)
                  a.onDeleteProject().catch((e: Error) => {
                    setDelErr(e.message)
                    setDelBusy(false)
                  })
                }}
              >
                {delBusy ? 'Удаляем…' : 'Удалить навсегда'}
              </button>
              <button type="button" className="btn small ghost" onClick={() => { setAsk(false); setTyped('') }}>
                Отмена
              </button>
            </div>
          </div>
        )}
      </section>
    </>
  )
}

function ZoneForm({ initial, onSubmit, onCancel }: { initial?: ZoneDraft; onSubmit: (d: ZoneDraft) => Promise<void>; onCancel: () => void }) {
  const [d, setD] = useState<ZoneDraft>(initial ?? { name: '', code: '', description: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <form
      className="zone-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (!d.name.trim()) return
        setBusy(true)
        setErr(null)
        onSubmit({ name: d.name.trim(), code: d.code.trim(), description: d.description.trim() }).catch((x: Error) => {
          setErr(x.message)
          setBusy(false)
        })
      }}
    >
      <div className="form-grid two-col">
        <label>
          Название
          <input className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="Котлован секции А" required autoFocus />
        </label>
        <label>
          Код
          <input className="input mono" value={d.code} onChange={(e) => setD({ ...d, code: e.target.value })} placeholder="A-01" />
        </label>
        <label style={{ gridColumn: '1 / -1' }}>
          Описание
          <input className="input" value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} placeholder="Что на этом участке" />
        </label>
      </div>
      {err && <p className="err-line">{err}</p>}
      <div className="form-actions">
        <button type="submit" className="btn small primary" disabled={busy || !d.name.trim()}>
          {busy ? 'Сохраняем…' : initial ? 'Сохранить' : 'Добавить зону'}
        </button>
        <button type="button" className="btn small ghost" onClick={onCancel}>
          Отмена
        </button>
      </div>
    </form>
  )
}
