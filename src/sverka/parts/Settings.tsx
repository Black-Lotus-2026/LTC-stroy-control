import { SafetyPanel } from './Safety'
import { PhotoInspection } from './PhotoInspection'
import { DocumentsPanel } from './Documents'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AdminRecipient, AlertSettings, CameraItem, CameraViewState, DocumentSelection, ProjectItem, UserProfile, Weather, ZoneItem } from '../api'
import { CameraViewImage } from './CameraViewImage'
import type { NumKey, Observation, Settings as S, SourceView } from '../model'
import { DEFAULTS, DEMO_DEFAULTS, KINDS, STEPS, THRESHOLDS } from '../model'
import { isSharedDemoProject } from '../projectScope'
import { atTime, clock, durShort, hhmmss, plural, toLocalInput } from '../lib/format'
import { PROBLEM_WORD, turnWords } from '../lib/view'
import { Spring, clamp } from '../lib/spring'
import { CloseIcon } from './common'

export type Probe = (url: string) => Promise<{ ok: boolean; message: string }>

export type SheetTab = 'control' | 'sources' | 'shift' | 'tasks' | 'object' | 'photo' | 'safety' | 'documents'

/** The server side of tasks: who answers for the object's events, the deadlines, the user's email. */
export interface TaskActions {
  load: () => Promise<AlertSettings>
  save: (d: Omit<AlertSettings, 'project_id'>) => Promise<AlertSettings>
  saveEmail: (email: string | null) => Promise<void>
}

export interface ObjectActions {
  counts: { stages: number; events: number }
  onUpdateProject: (d: { name: string; code: string; address: string; object_kind: string }) => Promise<void>
  onDeleteProject: () => Promise<void>
  onCreateZone: (d: ZoneDraft) => Promise<void>
  onUpdateZone: (id: string, d: ZoneDraft) => Promise<void>
  onDeleteZone: (id: string) => Promise<void>
  onUpdateCamera: (id: string, name: string, url: string, zoneId: string | null, code?: string) => Promise<void>
}
export interface ZoneDraft { name: string; code: string; description: string }

/** Camera views on the server: the administrator approves, the others propose and ask. */
export interface ViewActions {
  states: CameraViewState[]
  user: UserProfile
  canApprove?: boolean
  canPropose?: boolean
  canRequestMove?: boolean
  submit: (cameraId: string, note?: string) => Promise<void>
  approve: (cameraId: string, sha256: string) => Promise<void>
  reject: (cameraId: string, note?: string) => Promise<void>
  requestMove: (cameraId: string, untilIso: string, reason: string) => Promise<void>
  approveMove: (cameraId: string) => Promise<void>
  rejectMove: (cameraId: string, note?: string) => Promise<void>
  cancelMove: (cameraId: string) => Promise<void>
}

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
  user,
  admins,
  tasks,
  weather,
  objectActions,
  views,
  recordingCameraId,
  onRecordingCamera,
  onDocumentRulesChanged,
  onBeforeDocumentAnalysis,
  allowedTabs,
  canConfigure = false,
  canUpload = false,
}: {
  tab: SheetTab
  recordingCameraId: string
  onRecordingCamera: (id: string) => void
  onDocumentRulesChanged: (changes: DocumentSelection[]) => Promise<void>
  onBeforeDocumentAnalysis: () => Promise<void>
  settings: S
  onSettings: (s: S) => void
  obs: Observation
  cameras: CameraItem[]
  project: ProjectItem
  zones: ZoneItem[]
  onAddCamera: (name: string, url: string, zoneId?: string | null, code?: string) => Promise<void>
  onDeleteCamera: (id: string) => Promise<void>
  onCheck: Probe
  onRecording: (f: File, start: number) => void
  onClose: () => void
  user: UserProfile
  admins: AdminRecipient[]
  tasks: TaskActions
  /** the forecast, to say which place the address was found as */
  weather: Weather | null
  objectActions: ObjectActions
  views?: ViewActions | null
  allowedTabs?: readonly SheetTab[]
  canConfigure?: boolean
  canUpload?: boolean
}) {
  const [tab, setTab] = useState<SheetTab>(allowedTabs && !allowedTabs.includes(initialTab) ? allowedTabs[0] ?? 'sources' : initialTab)
  const [safetyDirty, setSafetyDirty] = useState(false)
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
    b.scrollIntoView({ block: 'nearest', inline: 'nearest' })
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
    if (safetyDirty && !window.confirm('Есть несохранённые изменения зоны. Закрыть без сохранения?')) return
    closing.current = true
    sp.current?.to(0, { damping: 1, onRest: onClose })
  }
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); return }
      if (e.key !== 'Tab' || !el.current) return
      const nodes = [...el.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href], [tabindex="0"]')].filter(n => n.getClientRects().length > 0)
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (!first) { e.preventDefault(); return }
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el.current.querySelector('#sheetTitle') || !el.current.contains(document.activeElement))) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && (document.activeElement === last || document.activeElement === el.current.querySelector('#sheetTitle'))) { e.preventDefault(); first.focus() }
    }
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
  const defaults = isSharedDemoProject(project) ? DEMO_DEFAULTS : DEFAULTS
  const row = (p: { k: NumKey; title: string; desc: string; where?: string; locked?: boolean }) => <SetRow key={p.k} {...p} settings={settings} defaults={defaults} onStep={set} onSettings={onSettings} />

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
              ['safety', 'Безопасность'],
              ['documents', 'Документы'],
              ['photo', 'Фото'],
              ['shift', 'Смена'],
              ['tasks', 'Задачи'],
              ['object', 'Объект'],
            ] as const
          ).filter(([k]) => !allowedTabs || allowedTabs.includes(k)).map(([k, v]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => { if (!safetyDirty || window.confirm('Есть несохранённые изменения зоны. Перейти без сохранения?')) { setSafetyDirty(false); setTab(k) } }}>
              {v}
            </button>
          ))}
          <i className="bar-ind" ref={ind} />
        </div>
        <div className="sheet-body">
          {tab === 'documents' && <DocumentsPanel key={project.id} projectId={project.id} canWrite={user.role !== 'viewer'} beforeAnalyze={onBeforeDocumentAnalysis} onRulesChanged={onDocumentRulesChanged} />}
          {tab === 'safety' && <SafetyPanel key={project.id} projectId={project.id} cameras={cameras} obs={obs} user={user} recordingCameraId={recordingCameraId} onRecordingCamera={onRecordingCamera} onDirtyChange={setSafetyDirty} />}
          {tab === 'control' && (
            <>
              {row({ k: "window", title: "Окно сверки", desc: "Техника считается замеченной, если найдена хотя бы на одном кадре любого источника за это время.", ...(user.role === 'admin' ? { where: 'Сохраняется на сервере' } : { where: 'Общее для сервера, меняет администратор', locked: true }) })}
              {row({ k: "conf", title: "Порог уверенности распознавания", desc: "Рамки с меньшей уверенностью не учитываются и не показываются." })}
              {row({ k: "warnAfter", title: "Предупреждение, если обязательной техники нет", desc: "Общее значение. У отдельной техники на этапе можно задать своё в правиле." })}
              {row({ k: "errAfter", title: "Отклонение, если её нет", desc: "После этого времени предупреждение считается отклонением." })}
              {row({ k: "oopAfter", title: "Техника не по этапу", desc: "Создать отклонение, если нехарактерная техника видна дольше этого времени." })}
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
          {tab === 'photo' && <PhotoInspection />}
          {tab === 'sources' && <Sources obs={obs} cameras={cameras} zones={zones} onAdd={onAddCamera} onUpdate={objectActions.onUpdateCamera} onDelete={onDeleteCamera} onCheck={onCheck} onRecording={onRecording} views={views ?? null} canConfigure={canConfigure} canUpload={canUpload} />}
          {tab === 'object' && <ObjectPane project={project} zones={zones} cameras={cameras} weather={weather} a={objectActions} user={user} />}
          {tab === 'tasks' && <TasksPane project={project} user={user} admins={admins} a={tasks} />}
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

function SetRow({ k, title, desc, where, locked = false, settings, defaults, onStep, onSettings }: { k: NumKey; title: string; desc: string; where?: string; locked?: boolean; settings: S; defaults: S; onStep: (k: NumKey, d: number) => void; onSettings: (s: S) => void }) {
  return (
    <div className="set-row">
      <div>
        <h4>{title}</h4>
        <p>{desc}</p>
      </div>
      {locked ? (
        <output className="set-val">{fmtVal(k, settings[k])}</output>
      ) : (
        <div className="stepper">
          <button type="button" aria-label={`${title}: меньше`} onClick={() => onStep(k, -1)}>
            −
          </button>
          <output aria-live="polite">{fmtVal(k, settings[k])}</output>
          <button type="button" aria-label={`${title}: больше`} onClick={() => onStep(k, 1)}>
            +
          </button>
        </div>
      )}
      <div className="def">
        По умолчанию: {fmtVal(k, defaults[k])}
        {settings[k] !== defaults[k] && !locked && (
          <>
            <span className="changed">изменено</span>
            <button type="button" onClick={() => onSettings({ ...settings, [k]: defaults[k] })}>
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

function Sources({ obs, cameras, zones, onAdd, onUpdate, onDelete, onCheck, onRecording, views, canConfigure, canUpload }: { obs: Observation; cameras: CameraItem[]; zones: ZoneItem[]; onAdd: (n: string, u: string, z?: string | null, code?: string) => Promise<void>; onUpdate: (id: string, n: string, u: string, z: string | null, code?: string) => Promise<void>; onDelete: (id: string) => Promise<void>; onCheck: Probe; onRecording: (f: File, start: number) => void; views: ViewActions | null; canConfigure: boolean; canUpload: boolean }) {
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
                initial={{ name: c.name, url: '', zoneId: c.zone_id ?? null, code: c.code || '' }}
                submitLabel="Сохранить"
                onAdd={(n, u, z, code) => onUpdate(c.id, n, u, z ?? null, code).then(() => setEditing(null))}
                onCheck={onCheck}
                onCancel={() => setEditing(null)}
              />
            </div>
          )
        return (
          <div className="src-item" key={c.id}>
          <div className="src-row">
            {v?.snapshot ? <img src={v.snapshot} alt="" /> : <span className="t-snap-none" style={{ position: 'static', width: 96, aspectRatio: '16/9' }}>нет кадра</span>}
            <div>
              <b>
                {c.name} {c.code && <span className="mono src-code">{c.code}</span>}
              </b>
              <small className={st === 'live' ? 'ok' : st === 'connecting' || st === 'idle' ? '' : 'bad'}>
                {STATUS_LINE[st]}
                {v?.message ? ` · ${v.message}` : ''}
              </small>
              <small>Подключение проверяется сервером; адрес и учётные данные защищены.</small>
              {zones.length > 0 && <small>Зона: {zone ? zone.name : 'не указана'}</small>}
              {checks[c.id] && <small>{checks[c.id]}</small>}
            </div>
            {canConfigure && <div className="row-actions">
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
                        const r = await onCheck(c.id)
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
            </div>}
          </div>
          {views && obs.mode === 'live' && <ViewBlock camera={c} state={views.states.find((x) => x.camera_id === c.id)} live={v} a={views} />}
          </div>
        )
      })}
      <div className="set-row">
        <div>
          <h4>Распознавание</h4>
          <p>{obs.model === 'ready' ? `Распознавание работает${obs.complianceEnabled ? '' : '; автоматические выводы об отсутствии техники выключены'} · проанализировано кадров в этом сеансе: ${obs.frames}` : obs.model === 'down' ? `Недоступно: ${obs.modelMessage || 'причина не сообщена'}` : 'Ждём первый ответ сервиса'}</p>
        </div>
        <span />
      </div>
      {form === 'camera' ? (
        <CameraForm zones={zones} onAdd={onAdd} onCancel={() => setForm(null)} onCheck={onCheck} />
      ) : form === 'recording' ? (
        <RecordingForm onSubmit={(f, s) => { onRecording(f, s); setForm(null) }} onCancel={() => setForm(null)} />
      ) : (
        <div className="form-actions">
          {canConfigure && <button type="button" className="btn small" onClick={() => setForm('camera')}>
            Добавить камеру
          </button>}
          {canUpload && <button type="button" className="btn small" onClick={() => setForm('recording')}>
            Открыть запись
          </button>}
        </div>
      )}
    </>
  )
}

export function CameraForm({
  onAdd,
  onCancel,
  onCheck: _onCheck,
  zones = [],
  initial,
  submitLabel = 'Сохранить камеру',
}: {
  onAdd: (n: string, u: string, zoneId?: string | null, code?: string) => Promise<void>
  onCancel?: () => void
  onCheck: Probe
  zones?: ZoneItem[]
  initial?: { name: string; url: string; zoneId: string | null; code?: string }
  submitLabel?: string
}) {
  const [name, setName] = useState(initial?.name ?? '')
  const [url, setUrl] = useState(initial?.url ?? '')
  const [code, setCode] = useState(initial?.code ?? '')
  const [zoneId, setZoneId] = useState<string | null>(initial ? initial.zoneId : zones[0]?.id ?? null)
  const [state, setState] = useState<{ s: 'idle' | 'busy' | 'error' | 'warn'; msg?: string }>({ s: 'idle' })
  const rtsp = /^rtsp:\/\//i.test(url.trim())
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || (!initial && !url.trim())) return
    setState({ s: 'busy', msg: 'Сохраняем камеру…' })
    try {
      // the address did not change: nothing to check again
      if (initial && url.trim() === initial.url.trim()) {
        await onAdd(name.trim(), url.trim(), zoneId, code.trim())
        setState({ s: 'idle' })
        return
      }
      await onAdd(name.trim(), url.trim(), zoneId, code.trim())
      if (!initial) {
        setName('')
        setUrl('')
        setCode('')
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
          <input className="input mono" id="camUrl" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={initial ? "Оставьте пустым, чтобы сохранить подключение" : "https://camera.example/mjpeg"} required={!initial} />
        </label>
      </div>
      <div className="form-grid two-col">
        <label>
          Код
          <input className="input mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="CAM-01" />
        </label>
        {zones.length > 0 && (
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
        )}
      </div>
      {rtsp && <p className="hint">RTSP-поток браузер не воспроизводит: камера сохранится, но для анализа нужен HTTP/MJPEG-адрес или серверный шлюз.</p>}
      {state.msg && <p className={state.s === 'error' ? 'err-line' : 'hint'}>{state.msg}</p>}
      <div className="form-actions">
        <button type="submit" className="btn small primary" disabled={state.s === 'busy'}>
          {state.s === 'busy' ? 'Проверяем…' : submitLabel}
        </button>
        {state.s === 'warn' && (
          <button type="button" className="btn small" onClick={() => onAdd(name.trim(), url.trim(), zoneId, code.trim()).then(() => { setState({ s: 'idle' }); if (!initial) onCancel?.() }, (err) => setState({ s: 'error', msg: err.message }))}>
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
function ObjectPane({ project, zones, cameras, weather, a, user }: { project: ProjectItem; zones: ZoneItem[]; cameras: CameraItem[]; weather: Weather | null; a: ObjectActions; user: UserProfile }) {
  const metadataLocked = user.role === 'viewer' || (isSharedDemoProject(project) && user.role !== 'admin')
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
    if (metadataLocked || !f.name.trim() || !dirty) return
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
        {metadataLocked && <p className="hint">Карточку и удаление общего демонстрационного объекта изменяет администратор. Для своего объекта создайте отдельный проект в меню объектов.</p>}
        <form onSubmit={save}>
          <fieldset disabled={metadataLocked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
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
          </fieldset>
        </form>
        {weather && <p className="hint">{weather.resolved_address ? `Погода в плане — для места «${weather.resolved_address}».` : weather.location_configured ? 'Погода: место по этому адресу не найдено, прогноза нет.' : 'Укажите адрес, и в плане появится прогноз погоды на неделю.'}</p>}
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
        {metadataLocked ? <p className="hint">Общий демонстрационный объект сохраняется для всех пользователей; удалить его может администратор.</p> : !ask ? (
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

/* ── Tasks: who answers for the object's events, by when, and where the copies go ─────────── */
const ERR_STEPS = [15, 30, 60, 120, 240, 480, 1440, 2880, 4320, 10080]
const WARN_STEPS = [60, 240, 480, 1440, 2880, 4320, 10080, 20160, 43200]
const DEF_ERR = 120
const DEF_WARN = 1440
/** "45 мин", "2 ч", "1 день 4 ч" */
function minutes(m: number) {
  if (m < 60) return `${m} мин`
  if (m < 1440) return durShort(m * 60_000)
  const d = Math.floor(m / 1440)
  const h = Math.round((m % 1440) / 60)
  return `${d} ${plural(d, 'день', 'дня', 'дней')}${h ? ` ${h} ч` : ''}`
}
const editable = (r: Omit<AlertSettings, 'project_id'>) => ({ owner_username: r.owner_username ?? null, escalation_user_id: r.escalation_user_id ?? null, alert_error_deadline_minutes: r.alert_error_deadline_minutes, alert_warning_deadline_minutes: r.alert_warning_deadline_minutes })
/** The next value on the scale, from wherever the server's value happens to be. */
function stepFrom(steps: number[], v: number, d: number) {
  if (d > 0) return steps.find((x) => x > v) ?? steps[steps.length - 1]
  return [...steps].reverse().find((x) => x < v) ?? steps[0]
}

function TasksPane({ project, user, admins, a }: { project: ProjectItem; user: UserProfile; admins: AdminRecipient[]; a: TaskActions }) {
  const admin = user.role === 'admin'
  const fromProject = editable({ owner_username: project.owner_username ?? null, escalation_user_id: project.escalation_user_id ?? null, alert_error_deadline_minutes: project.alert_error_deadline_minutes ?? DEF_ERR, alert_warning_deadline_minutes: project.alert_warning_deadline_minutes ?? DEF_WARN })
  const [base, setBase] = useState(fromProject)
  const [f, setF] = useState(fromProject)
  const [st, setSt] = useState<{ s: 'idle' | 'saving' | 'saved' | 'error'; msg?: string }>({ s: 'idle' })
  const [email, setEmail] = useState(user.email || '')
  const [mail, setMail] = useState<{ s: 'idle' | 'saving' | 'saved' | 'error'; msg?: string }>({ s: 'idle' })
  // the object list may be older than the settings: read them once more from the server
  useEffect(() => {
    let alive = true
    a.load().then(
      (r) => {
        if (!alive) return
        setBase(editable(r))
        setF(editable(r))
      },
      () => undefined,
    )
    return () => {
      alive = false
    }
    // once per object
  }, [project.id])
  const dirty = (Object.keys(base) as (keyof typeof base)[]).some((k) => (f[k] ?? '') !== (base[k] ?? ''))
  const chief = admins.find((x) => x.id === f.escalation_user_id)
  const save = async () => {
    setSt({ s: 'saving' })
    try {
      const d = editable(await a.save({ ...f, owner_username: f.owner_username?.trim() || null }))
      setBase(d)
      setF(d)
      setSt({ s: 'saved' })
    } catch (e) {
      setSt({ s: 'error', msg: e instanceof Error ? e.message : 'Не удалось сохранить' })
    }
  }
  const stepper = (k: 'alert_error_deadline_minutes' | 'alert_warning_deadline_minutes', steps: number[], title: string) => (
    <div className="stepper">
      <button type="button" aria-label={`${title}: меньше`} onClick={() => setF({ ...f, [k]: stepFrom(steps, f[k], -1) })}>
        −
      </button>
      <output aria-live="polite">{minutes(f[k])}</output>
      <button type="button" aria-label={`${title}: больше`} onClick={() => setF({ ...f, [k]: stepFrom(steps, f[k], 1) })}>
        +
      </button>
    </div>
  )
  return (
    <>
      <section className="obj-sec">
        <span className="kicker">Ответственность</span>
        <p className="hint">Каждое событие становится задачей: ответственный получает её со сроком исправления. После срока сервер проверяет камеры и, если нарушение осталось, передаёт событие руководителю.</p>
        <div className="set-row">
          <div>
            <h4>Ответственный за объект</h4>
            <p>Получает задачи по событиям объекта. Без него задачи получает администратор.</p>
          </div>
          {admin ? (
            <input className="input mono set-input" value={f.owner_username ?? ''} onChange={(e) => setF({ ...f, owner_username: e.target.value })} placeholder="логин" aria-label="Логин ответственного" />
          ) : (
            <output className="set-val">{f.owner_username || 'не назначен'}</output>
          )}
          {!admin && <div className="def">Назначает администратор</div>}
        </div>
        <div className="set-row">
          <div>
            <h4>Руководитель для эскалации</h4>
            <p>Получает событие, если срок истёк, а нарушение осталось или проверить его по камерам не удалось.</p>
          </div>
          {admin ? (
            <select className="select set-input" value={f.escalation_user_id ?? ''} onChange={(e) => setF({ ...f, escalation_user_id: e.target.value || null })} aria-label="Руководитель для эскалации">
              <option value="">Первый администратор</option>
              {admins.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name} ({x.username})
                </option>
              ))}
            </select>
          ) : (
            <output className="set-val">{chief ? chief.name : 'первый администратор'}</output>
          )}
          {!admin && <div className="def">Назначает администратор</div>}
        </div>
        <div className="set-row">
          <div>
            <h4>Срок для отклонения</h4>
            <p>Сколько времени у ответственного, чтобы исправить отклонение.</p>
          </div>
          {stepper('alert_error_deadline_minutes', ERR_STEPS, 'Срок для отклонения')}
          <div className="def">
            По умолчанию: {minutes(DEF_ERR)}
            <span>На сервере</span>
          </div>
        </div>
        <div className="set-row">
          <div>
            <h4>Срок для предупреждения</h4>
            <p>Предупреждения не так срочны, но тоже закрываются проверкой.</p>
          </div>
          {stepper('alert_warning_deadline_minutes', WARN_STEPS, 'Срок для предупреждения')}
          <div className="def">
            По умолчанию: {minutes(DEF_WARN)}
            <span>На сервере</span>
          </div>
        </div>
        <div className="form-actions">
          <button type="button" className="btn small primary" disabled={!dirty || st.s === 'saving'} onClick={save}>
            {st.s === 'saving' ? 'Сохраняем…' : 'Сохранить'}
          </button>
          {dirty && (
            <button type="button" className="btn small ghost" onClick={() => { setF(base); setSt({ s: 'idle' }) }}>
              Отменить правки
            </button>
          )}
          {st.s === 'saved' && !dirty && <span className="save-state" data-s="saved">Сохранено</span>}
          {st.s === 'error' && <span className="err-line">{st.msg}</span>}
        </div>
        <p className="hint">Срок назначается событию, когда оно создаётся: новые сроки действуют для новых событий.</p>
      </section>
      <section className="obj-sec">
        <span className="kicker">Мои уведомления</span>
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setMail({ s: 'saving' })
            try {
              await a.saveEmail(email.trim() || null)
              setMail({ s: 'saved' })
            } catch (err) {
              setMail({ s: 'error', msg: err instanceof Error ? err.message : 'Не удалось сохранить email' })
            }
          }}
        >
          <div className="form-grid two-col">
            <label style={{ gridColumn: '1 / -1' }}>
              Email для копий задач
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@example.com" />
            </label>
          </div>
          <div className="form-actions">
            <button type="submit" className="btn small" disabled={mail.s === 'saving' || email.trim() === (user.email || '')}>
              {mail.s === 'saving' ? 'Сохраняем…' : 'Сохранить email'}
            </button>
            {mail.s === 'saved' && email.trim() === (user.email || '') && <span className="save-state" data-s="saved">Сохранено</span>}
            {mail.s === 'error' && <span className="err-line">{mail.msg}</span>}
          </div>
        </form>
        <p className="hint">Задачи всегда видны в шапке. Письма уходят, только если на сервере настроена почта.</p>
      </section>
    </>
  )
}

const VIEW_EVENT: Record<string, string> = {
  reference_set: 'Ракурс утверждён',
  reference_proposed: 'Предложен новый ракурс',
  reference_rejected: 'Предложенный ракурс отклонён',
  move_requested: 'Запрошен перенос',
  move_approved: 'Перенос согласован',
  move_rejected: 'Перенос отклонён',
  move_cancelled: 'Перенос отменён',
  move_completed: 'Перенос завершён: новый ракурс утверждён',
  move_expired: 'Срок переноса истёк без нового ракурса',
}
const pct = (m?: number) => `${Math.round(Math.max(0, m ?? 0) * 100)} %`
const ts = (v?: string | null) => (v ? new Date(v).getTime() : null)

/** The camera's approved view, what it matches now, and who may change it: the administrator decides. */
function ViewBlock({ camera, state, live, a }: { camera: CameraItem; state?: CameraViewState; live?: SourceView; a: ViewActions }) {
  const admin = a.canApprove === true
  const viewer = a.canPropose !== true && a.canRequestMove !== true
  const [form, setForm] = useState<null | 'fix' | 'move'>(null)
  const [note, setNote] = useState('')
  const [until, setUntil] = useState(() => toLocalInput(new Date(Date.now() + 4 * 3600_000)))
  const [busy, setBusy] = useState<{ s: 'saving' | 'error'; msg?: string } | null>(null)
  const [hist, setHist] = useState(false)
  const run = async (f: () => Promise<void>) => {
    setBusy({ s: 'saving' })
    try {
      await f()
      setForm(null)
      setNote('')
      setBusy(null)
    } catch (e) {
      setBusy({ s: 'error', msg: e instanceof Error ? e.message : 'Не удалось сохранить' })
    }
  }
  const ref = state?.reference
  const prop = state?.proposal
  const move = state?.move
  const check = live?.view
  const mine = (id?: string | null) => !!id && id === a.user.id
  const now = Date.now()
  const line = !ref
    ? { cls: '', t: 'Ракурс не утверждён: камера не сверяется с эталоном.' }
    : check?.state === 'move'
      ? { cls: '', t: `Перенос согласован до ${atTime(check.moveUntil ?? now)}: сверка ракурса на паузе.` }
      : check?.state === 'changed'
        ? { cls: 'bad', t: `Ракурс изменён: ${PROBLEM_WORD[check.problem ?? 'different']}${check.problem === 'turned' && turnWords(check) ? ` ${turnWords(check)}` : ''} · совпадение ${pct(check.match)}` }
        : check?.state === 'ok'
          ? { cls: 'ok', t: `Совпадает с утверждённым ракурсом · ${pct(check.match)}` }
          : { cls: '', t: live?.status === 'live' ? 'Сверяем первые кадры с утверждённым ракурсом…' : 'Сверка начнётся, когда камера пришлёт кадр.' }
  return (
    <div className="src-view">
      <div className="sv-head">
        <span className="kicker">Ракурс камеры</span>
        <small className={line.cls}>{line.t}</small>
      </div>
      <div className="sv-shots">
        {ref ? (
          <figure>
            <CameraViewImage url={ref.url} alt={`Утверждённый ракурс: ${camera.name}`} />
            <figcaption>
              Утверждён {atTime(ts(ref.at) ?? now)}
              {ref.by ? ` · ${ref.by}` : ''}
            </figcaption>
          </figure>
        ) : (
          <figure className="none">
            <span>эталона нет</span>
            <figcaption>{admin ? 'Утвердите ракурс, как должна висеть камера' : 'Ракурс утверждает администратор'}</figcaption>
          </figure>
        )}
        {prop && (
          <figure className="prop">
            <CameraViewImage url={prop.url} alt={`Предложенный ракурс: ${camera.name}`} />
            <figcaption>
              Предложен {atTime(ts(prop.at) ?? now)}
              {prop.by ? ` · ${prop.by}` : ''}
              {prop.note ? ` · «${prop.note}»` : ''}
            </figcaption>
          </figure>
        )}
      </div>
      {prop && (
        <div className="sv-ask">
          <span>Новый ракурс ждёт утверждения{admin ? '' : ' администратором'}.</span>
          {admin && (
            <span className="row-actions">
              <button type="button" className="btn small primary" disabled={busy?.s === 'saving' || !prop.sha256} onClick={() => { if (prop.sha256) void run(() => a.approve(camera.id, prop.sha256!)) }}>
                Утвердить
              </button>
              <button type="button" className="btn small ghost" disabled={busy?.s === 'saving'} onClick={() => run(() => a.reject(camera.id))}>
                Отклонить
              </button>
            </span>
          )}
        </div>
      )}
      {move && (
        <div className="sv-ask" data-move={move.status}>
          <span>
            {move.status === 'approved' ? 'Перенос согласован' : 'Запрошен перенос'} до <b>{atTime(ts(move.until) ?? now)}</b>: {move.reason}
            <span className="dim">
              {move.by ? ` · попросил ${move.by}` : ''}
              {move.status === 'approved' && move.approved_by ? ` · согласовал ${move.approved_by}` : ''}
            </span>
          </span>
          <span className="row-actions">
            {admin && a.canRequestMove && move.status === 'requested' && (
              <>
                <button type="button" className="btn small primary" disabled={busy?.s === 'saving'} onClick={() => run(() => a.approveMove(camera.id))}>
                  Согласовать
                </button>
                <button type="button" className="btn small ghost" disabled={busy?.s === 'saving'} onClick={() => run(() => a.rejectMove(camera.id))}>
                  Отклонить
                </button>
              </>
            )}
            {a.canRequestMove && (admin || mine(move.by_id)) && (
              <button type="button" className="btn small ghost" disabled={busy?.s === 'saving'} onClick={() => run(() => a.cancelMove(camera.id))}>
                Отменить перенос
              </button>
            )}
          </span>
        </div>
      )}
      {form === 'fix' ? (
        <div className="sv-form">
          <p className="hint">
            {admin
              ? 'Текущий кадр будет предложен как новая версия ракурса. Просмотрите его и утвердите отдельным решением.'
              : 'Текущий кадр уйдёт управляющему заказчика. Пока он не утвердит, камера сверяется с прежним ракурсом.'}
          </p>
          {live?.snapshot && <img className="sv-now" src={live.snapshot} alt="Текущий кадр" />}
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder={admin ? 'Комментарий, необязательно' : 'Почему ракурс изменился'} maxLength={500} />
          <div className="form-actions">
            <button type="button" className="btn small primary" disabled={busy?.s === 'saving' || !live?.snapshot || (!admin && note.trim().length < 3)} onClick={() => run(() => a.submit(camera.id, note.trim() || undefined))}>
              Отправить ракурс на утверждение
            </button>
            <button type="button" className="btn small ghost" onClick={() => setForm(null)}>
              Отмена
            </button>
          </div>
        </div>
      ) : form === 'move' ? (
        <div className="sv-form">
          <p className="hint">{admin ? 'Пока перенос согласован, смещение камеры не считается нарушением, а её кадры не сверяются. После переноса утвердите новый ракурс.' : 'Запрос уйдёт администратору. После переноса предложите новый ракурс.'}</p>
          <div className="form-grid two-col">
            <label>
              До
              <input className="input" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
            </label>
            <label>
              Причина
              <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Кран переставили, камера переезжает на мачту Б" maxLength={500} />
            </label>
          </div>
          <div className="form-actions">
            <button type="button" className="btn small primary" disabled={busy?.s === 'saving' || note.trim().length < 3 || !until} onClick={() => run(() => a.requestMove(camera.id, new Date(until).toISOString(), note.trim()))}>
              {admin ? 'Согласовать перенос' : 'Попросить перенос'}
            </button>
            <button type="button" className="btn small ghost" onClick={() => setForm(null)}>
              Отмена
            </button>
          </div>
        </div>
      ) : (
        !viewer && (
          <div className="form-actions">
            <button type="button" className="btn small" disabled={!live?.snapshot} onClick={() => { setNote(''); setForm('fix') }} title={live?.snapshot ? undefined : 'Нет текущего кадра'}>
              Предложить текущий ракурс
            </button>
            {a.canRequestMove && !move && ref && (
              <button type="button" className="btn small ghost" onClick={() => { setNote(''); setForm('move') }}>
                {admin ? 'Согласовать перенос' : 'Попросить перенос'}
              </button>
            )}
          </div>
        )
      )}
      {busy?.s === 'error' && <p className="hint bad">{busy.msg}</p>}
      {!!state?.history.length && (
        <div className="sv-hist">
          <button type="button" className="link-plain" onClick={() => setHist(!hist)} aria-expanded={hist}>
            История ракурса · {state.history.length}
          </button>
          {hist && (
            <ol>
              {state.history.map((h, i) => (
                <li key={i}>
                  <time className="mono">{atTime(new Date(h.at).getTime())}</time>
                  <span>
                    {VIEW_EVENT[h.kind] ?? h.kind}
                    {h.until ? ` до ${atTime(new Date(h.until).getTime())}` : ''}
                    {h.note ? ` · «${h.note}»` : ''}
                    {h.by ? <span className="dim"> · {h.by}</span> : ''}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  )
}
