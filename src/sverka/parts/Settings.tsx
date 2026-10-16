import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CameraItem, ProjectItem, StreamCheck, ZoneItem } from '../api'
import type { Observation, Settings as S } from '../model'
import { DEFAULTS, STEPS, THRESHOLDS } from '../model'
import { clock, durShort, hhmmss, toLocalInput } from '../lib/format'
import { Spring, clamp } from '../lib/spring'
import { CloseIcon } from './common'

export type SheetTab = 'control' | 'sources' | 'shift'

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
}: {
  tab: SheetTab
  settings: S
  onSettings: (s: S) => void
  obs: Observation
  cameras: CameraItem[]
  project: ProjectItem
  zones: ZoneItem[]
  onAddCamera: (name: string, url: string) => Promise<void>
  onDeleteCamera: (id: string) => Promise<void>
  onCheck: (url: string) => Promise<StreamCheck>
  onRecording: (f: File, start: number) => void
  onClose: () => void
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

  const set = (k: keyof S, d: number) => {
    const steps = STEPS[k]
    let i = steps.findIndex((v) => v >= settings[k])
    if (i < 0) i = steps.length - 1
    const n = { ...settings, [k]: steps[clamp(i + d, 0, steps.length - 1)] }
    if (n.errAfter <= n.warnAfter) n.errAfter = STEPS.errAfter.find((v) => v > n.warnAfter) ?? n.errAfter
    onSettings(n)
  }
  const row = (p: { k: keyof S; title: string; desc: string; where?: string }) => <SetRow key={p.k} {...p} settings={settings} onStep={set} onSettings={onSettings} />

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
              ['shift', 'Смена и объект'],
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
          {tab === 'sources' && <Sources obs={obs} cameras={cameras} onAdd={onAddCamera} onDelete={onDeleteCamera} onCheck={onCheck} onRecording={onRecording} />}
          {tab === 'shift' && (
            <>
              {row({ k: "shiftFrom", title: "Начало смены", desc: "Вне смены отсутствие техники не считается отклонением." })}
              {row({ k: "shiftTo", title: "Конец смены", desc: "После конца смены события об отсутствии техники не создаются." })}
              {row({ k: "startGrace", title: "Сбор техники после начала смены", desc: "Сколько ждать, прежде чем считать технику отсутствующей, если с начала смены её ещё не было." })}
              <div className="set-row">
                <div>
                  <h4>Тип объекта</h4>
                  <p>Определяет раздел справочника для профилей этапов.</p>
                </div>
                <span>{project.object_kind || 'не указан'}</span>
              </div>
              <div className="set-row">
                <div>
                  <h4>Зоны</h4>
                  <p>{zones.length ? zones.map((z) => z.name).join(', ') : 'Зоны не заданы. События относятся ко всему объекту.'}</p>
                </div>
                <span />
              </div>
            </>
          )}
        </div>
      </section>
    </>
  )
}

const fmtVal = (k: keyof S, v: number) => (k === 'conf' ? `${v}%` : k === 'window' ? `${v} с` : k === 'shiftFrom' || k === 'shiftTo' ? clock(v) : durShort(v * 1000))

function SetRow({ k, title, desc, where, settings, onStep, onSettings }: { k: keyof S; title: string; desc: string; where?: string; settings: S; onStep: (k: keyof S, d: number) => void; onSettings: (s: S) => void }) {
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

function Sources({ obs, cameras, onAdd, onDelete, onCheck, onRecording }: { obs: Observation; cameras: CameraItem[]; onAdd: (n: string, u: string) => Promise<void>; onDelete: (id: string) => Promise<void>; onCheck: (u: string) => Promise<StreamCheck>; onRecording: (f: File, start: number) => void }) {
  const [form, setForm] = useState<null | 'camera' | 'recording'>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
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
                        setChecks((x) => ({ ...x, [c.id]: r.status === 'online' ? `Отвечает: ${r.message || r.protocol}` : r.error || r.suggestion || 'Не отвечает' }))
                      } catch (e) {
                        setChecks((x) => ({ ...x, [c.id]: e instanceof Error ? e.message : 'Не удалось проверить' }))
                      }
                    }}
                  >
                    Проверить
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
          <p>{obs.model === 'ready' ? `Работает · проанализировано кадров в этом сеансе: ${obs.frames}` : obs.model === 'down' ? `Недоступно: ${obs.modelMessage || 'причина не сообщена'}` : 'Ждём первый ответ сервиса'}</p>
        </div>
        <span />
      </div>
      {form === 'camera' ? (
        <CameraForm onAdd={onAdd} onCancel={() => setForm(null)} onCheck={onCheck} />
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

export function CameraForm({ onAdd, onCancel, onCheck }: { onAdd: (n: string, u: string) => Promise<void>; onCancel?: () => void; onCheck: (u: string) => Promise<StreamCheck> }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [state, setState] = useState<{ s: 'idle' | 'busy' | 'error' | 'warn'; msg?: string }>({ s: 'idle' })
  const rtsp = /^rtsp:\/\//i.test(url.trim())
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !url.trim()) return
    setState({ s: 'busy', msg: 'Проверяем связь…' })
    try {
      const r = await onCheck(url.trim())
      if (r.status !== 'online' && r.status !== 'warning') {
        setState({ s: 'warn', msg: `Камера не ответила: ${r.error || r.suggestion || 'нет ответа'}. Камеру можно сохранить, но кадров не будет, пока связь не появится.` })
        return
      }
      await onAdd(name.trim(), url.trim())
      setName('')
      setUrl('')
      setState({ s: 'idle' })
      onCancel?.()
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
      {rtsp && <p className="hint">RTSP-поток браузер не воспроизводит: камера сохранится, но для анализа нужен HTTP/MJPEG-адрес или серверный шлюз.</p>}
      {state.msg && <p className={state.s === 'error' ? 'err-line' : 'hint'}>{state.msg}</p>}
      <div className="form-actions">
        <button type="submit" className="btn small primary" disabled={state.s === 'busy'}>
          {state.s === 'busy' ? 'Проверяем…' : 'Проверить и сохранить'}
        </button>
        {state.s === 'warn' && (
          <button type="button" className="btn small" onClick={() => onAdd(name.trim(), url.trim()).then(() => { setState({ s: 'idle' }); onCancel?.() }, (err) => setState({ s: 'error', msg: err.message }))}>
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
