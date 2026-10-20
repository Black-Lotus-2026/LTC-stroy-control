import '../safety.css'
import { polygonProblem } from '../safetyGeometry'
import { useEffect, useRef, useState } from 'react'
import type { CameraItem, UserProfile } from '../api'
import type { Observation } from '../model'
import * as safety from '../safetyApi'
import type { Point, SafetyConfiguration, SafetyEvent, SafetyZone, ZoneInput } from '../safetyApi'
import { PprCitations } from './PprSourceLink'
import { OBSERVATION_LABELS, toObservationCode } from '../../domain/constructionObservations'

const message = (e: unknown) => e instanceof Error ? e.message : 'Не удалось выполнить запрос'
const stamp = (s?: string) => s ? s.startsWith('Позиция') ? s : new Date(/^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(s) ? s + 'Z' : s).toLocaleString('ru-RU') : 'Не указано'
const words = (row: Record<string, unknown>, ...keys: string[]) => keys.map(k => row[k]).filter(v => typeof v === 'string' || typeof v === 'number').join(' · ')
const statusLabel = { pending: 'Требует проверки', confirmed: 'Наблюдение подтверждено', rejected: 'Отклонено' }

export function SafetyPanel({ projectId, cameras, obs, recordingCameraId, onRecordingCamera, onDirtyChange }: {
  projectId: string; cameras: CameraItem[]; obs: Observation; user: UserProfile;
  recordingCameraId: string; onRecordingCamera: (id: string) => void; onDirtyChange?: (dirty: boolean) => void;
}) {
  const [dirty, setDirty] = useState(false)
  const dirtyHandler = useRef(onDirtyChange)
  useEffect(() => { dirtyHandler.current = onDirtyChange }, [onDirtyChange])
  useEffect(() => { dirtyHandler.current?.(dirty); return () => dirtyHandler.current?.(false) }, [dirty])
  const leave = () => !dirty || window.confirm('Есть несохранённые изменения. Отменить их?')
  const [config, setConfig] = useState<SafetyConfiguration | null>(null)
  const [zones, setZones] = useState<SafetyZone[]>([])
  const [events, setEvents] = useState<SafetyEvent[]>([])
  const [error, setError] = useState('')
  const [eventsError, setEventsError] = useState('')
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const [page, setPage] = useState<'events' | 'zones' | 'norms'>('events')
  const [editor, setEditor] = useState<SafetyZone | 'new' | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof safety.safetyCatalog>> | null>(null)
  useEffect(() => {
    let alive = true
    setLoading(true); setError('')
    Promise.all([safety.safetyConfiguration(projectId), safety.safetyZones(projectId), safety.safetyEvents(projectId), safety.safetyCatalog()]).then(([c, z, e, n]) => {
      if (!alive) return
      setConfig(c); setZones(z); setEvents(e); setCatalog(n)
    }, e => { if (alive) setError(message(e)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [projectId, refresh])
  useEffect(() => {
    let alive = true
    const timer = window.setInterval(() => {
      safety.safetyEvents(projectId).then(e => { if (alive) { setEvents(e); setEventsError('') } }, e => { if (alive) setEventsError(message(e)) })
    }, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [projectId])
  const event = events.find(e => e.id === selected)
  const enabled = zones.filter(z => z.enabled)
  const hasFrames = obs.model === 'ready' && obs.sources.some(s => s.status === 'live' && enabled.some(z => z.camera_id === (s.kind === 'video' ? recordingCameraId : s.id)))
  return <section className="safety-panel" aria-label="Контроль безопасности">
    <div className="safety-heading"><div><span className="kicker">Безопасность площадки</span><h3>Зоны, наблюдения и основания</h3></div><button className="btn small ghost" onClick={() => { if (leave()) { setDirty(false); setRefresh(x => x + 1) } }} disabled={loading || dirty}>Обновить</button></div>
    <p className="hint">Камера отмечает возможную опасную ситуацию. Ответственный проверяет кадр и применимость требования. Подтверждение наблюдения не назначает штраф.</p>
    <div className="safety-state" role="status">{!enabled.length ? 'Контроль зон не включён. Настройте первую зону.' : hasFrames ? `Включено зон: ${enabled.length}. Кадры анализируются, пока открыт рабочий экран.` : 'Нет текущих анализируемых кадров. Отсутствие событий не означает отсутствие нарушений.'}</div>
    {obs.mode === 'recording' && <label className="safety-field">Камера, с которой сделана запись<select className="select" value={recordingCameraId} onChange={e => onRecordingCamera(e.target.value)}><option value="">Не привязана: контроль зон выключен для записи</option>{cameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select><small>Выберите только при совпадении ракурса. Для другого ракурса нужна новая зона.</small></label>}
    <div className="safety-nav" role="group" aria-label="Раздел безопасности">{([['events', 'События'], ['zones', 'Зоны контроля'], ['norms', 'Нормативная база']] as const).map(([key, title]) => <button className="btn small" aria-pressed={page === key} key={key} onClick={() => { if (key !== page && leave()) { setDirty(false); setPage(key); setEditor(null); setSelected(null) } }}>{title}{key === 'events' && events.filter(e => e.status === 'pending').length ? ` · ${events.filter(e => e.status === 'pending').length}` : ''}</button>)}</div>
    {error && <p className="err-line" role="alert">{error}. <button className="btn small" onClick={() => setRefresh(x => x + 1)}>Повторить</button></p>}
    {eventsError && <p className="err-line" role="alert">Обновление событий недоступно: {eventsError}</p>}
    {loading && <p role="status">Загружаем правила и события…</p>}
    {!loading && config && page === 'zones' && <>
      <p className="hint">Зоны привязаны к ракурсу конкретной камеры. После поворота, зума или перемещения камеры отключите зону и проверьте границы заново.</p>
      {editor ? <ZoneEditor key={typeof editor === 'string' ? editor : editor.id} initial={editor === 'new' ? undefined : editor} config={config} obs={obs} onDirtyChange={setDirty} onCancel={() => { if (leave()) { setDirty(false); setEditor(null) } }} onSave={async (input) => { const z = await safety.saveSafetyZone(projectId, input, editor === 'new' ? undefined : editor.id); setZones(old => [...old.filter(x => x.id !== z.id), z]); setDirty(false); setEditor(null) }} /> : <>
        {config.can_manage && <button className="btn primary" onClick={() => setEditor('new')} disabled={!cameras.length}>Добавить зону</button>}
        {!cameras.length && <p>Сначала добавьте камеру в разделе «Источники».</p>}
        {!zones.length && <p>Зоны ещё не настроены. Выберите сценарий и отметьте его границы на кадре.</p>}
        {zones.map(z => <article className="safety-card" key={z.id}><div className="safety-heading"><h4>{z.name}</h4><span className="safety-status">{z.enabled ? 'Включена' : 'Черновик / выключена'}</span></div><p>{safety.SAFETY_SCENARIOS[z.scenario]} · {cameras.find(c => c.id === z.camera_id)?.name ?? 'Камера недоступна'}</p><p className="hint">{z.site_basis || 'Основание не указано'} · наблюдение от {z.min_duration_seconds} с</p>{config.can_manage && <button className="btn small" onClick={() => setEditor(z)}>Настроить</button>}</article>)}
      </>}
    </>}
    {!loading && page === 'events' && <>{event ? <SafetyCase key={event.id} projectId={projectId} event={event} config={config} onDirtyChange={setDirty} onBack={() => { if (leave()) { setDirty(false); setSelected(null) } }} onReview={async (decision, comment) => { const updated = await safety.reviewSafetyEvent(event.id, decision, comment); setEvents(old => old.map(e => e.id === updated.id ? updated : e)) }} /> : <>
      {!events.length && <div className="safety-empty"><h4>Событий пока нет</h4><p>{enabled.length ? 'Здесь появятся повторные наблюдения в настроенных зонах. Проверьте, что камера передаёт кадры и анализ доступен.' : 'Добавьте зону контроля и включите её после проверки границ и основания.'}</p><button className="btn small" onClick={() => setPage('zones')}>К зонам контроля</button></div>}
      {events.map(e => <button className="safety-event" key={e.id} onClick={() => setSelected(e.id)}><span className="safety-status">{statusLabel[e.status]}</span><strong>{safety.SAFETY_SCENARIOS[e.scenario]}</strong><span>{e.zone_snapshot.name} · {cameras.find(c => c.id === e.camera_name)?.name ?? e.camera_name}</span><small>{stamp(e.first_seen)} · открыть доказательства →</small></button>)}
    </>}</>}
    {!loading && page === 'norms' && catalog && <><p className="hint">Справочник хранится на сервере и переносится миграцией. Для события сохраняется снимок требований и возможной ответственности. Применимость к площадке проверяет ответственный.</p><NormRecords rows={catalog.documents} /><NormRecords rows={catalog.requirements} /><h4>Возможная ответственность</h4><NormRecords rows={catalog.sanctions} /></>}
  </section>
}


function ZoneEditor({ initial, config, obs, onSave, onCancel, onDirtyChange }: { initial?: SafetyZone; config: SafetyConfiguration; obs: Observation; onSave: (input: ZoneInput) => Promise<void>; onCancel: () => void; onDirtyChange: (dirty: boolean) => void }) {
  const [draft, setDraft] = useState<ZoneInput>(initial ? { camera_id: initial.camera_id, name: initial.name, scenario: initial.scenario, polygon: initial.polygon, site_basis: initial.site_basis, responsible_user_id: initial.responsible_user_id, min_duration_seconds: initial.min_duration_seconds, confidence_threshold: initial.confidence_threshold, allowed_classes: initial.allowed_classes, enabled: initial.enabled } : { camera_id: config.cameras[0]?.id ?? '', name: '', scenario: 'worker_danger_zone', polygon: [], site_basis: '', responsible_user_id: '', min_duration_seconds: 3, confidence_threshold: .5, allowed_classes: [], enabled: false })
  const [snapshot, setSnapshot] = useState('')
  const [closed, setClosed] = useState(!!initial)
  const [checked, setChecked] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [imageError, setImageError] = useState(false)
  const [imageLoaded, setImageLoaded] = useState(false)
  const [imageRevision, setImageRevision] = useState(0)
  const [localFile, setLocalFile] = useState<File | null>(null)
  const [dirty, setDirty] = useState(false)
  const [keyboardPoint, setKeyboardPoint] = useState<Point>([.5,.5])
  const image = useRef<HTMLDivElement>(null)
  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])
  useEffect(() => {
    if (localFile) { const url = URL.createObjectURL(localFile); setSnapshot(url); return () => URL.revokeObjectURL(url) }
  }, [localFile])
  const change = <K extends keyof ZoneInput>(key: K, value: ZoneInput[K]) => { setDraft(d => ({ ...d, [key]: value })); setChecked(false); setDirty(true) }
  const setReference = () => { setImageError(false); setImageLoaded(false); setImageRevision(x => x+1); setChecked(false) }
  const capture = () => {
    const source = obs.sources.find(s => s.id === draft.camera_id) ?? (obs.mode === 'recording' ? obs.sources[0] : undefined)
    if (!source?.snapshot) { setError('Нет доступного кадра. Дождитесь камеры или загрузите кадр с тем же ракурсом.'); return }
    setLocalFile(null); setSnapshot(source.snapshot); setReference(); setError('')
  }
  const geometryError = polygonProblem(draft.polygon)
  const missing = [!draft.name.trim() && 'название', !draft.camera_id && 'камера', geometryError, !closed && 'замкните зону', draft.site_basis.trim().length < 10 && 'основание площадки от 10 символов', !draft.responsible_user_id && 'ответственный', (!Number.isFinite(draft.min_duration_seconds) || draft.min_duration_seconds < 1 || draft.min_duration_seconds > 300) && 'время от 1 до 300 секунд', (!Number.isFinite(draft.confidence_threshold) || draft.confidence_threshold < .5 || draft.confidence_threshold > .99) && 'порог от 0,5 до 0,99', draft.enabled && !imageLoaded && 'откройте кадр и проверьте ракурс', draft.enabled && !checked && 'подтверждение проверки'].filter(Boolean)
  const canSave = !missing.length
  const addPoint = (point: Point) => { if (closed || busy || draft.polygon.length >= 32) return; change('polygon', [...draft.polygon, point]) }
  const vehicles = Object.entries(OBSERVATION_LABELS).filter(([key]) => !['worker','hanging_head','grader'].includes(key))
  return <form className="safety-form" onSubmit={async e => { e.preventDefault(); if (!canSave) return; setBusy(true); setError(''); try { await onSave(draft) } catch (e) { setError(message(e)); setBusy(false) } }}>
    <h4>{initial ? 'Настройка зоны' : 'Новая зона контроля'}</h4><p className="hint">{dirty ? 'Есть несохранённые изменения. ' : ''}Изменения вступят в силу после сохранения. Порог времени — настройка наблюдения, а не нормативный допуск.</p>
    <label className="safety-field">Сценарий<select className="select" disabled={busy} value={draft.scenario} onChange={e => { change('scenario', e.target.value as ZoneInput['scenario']); change('allowed_classes', []) }}>{Object.entries(safety.SAFETY_SCENARIOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
    <label className="safety-field">Название зоны<input className="input" disabled={busy} required maxLength={120} value={draft.name} onChange={e => change('name', e.target.value)} placeholder="Например, проход к секции А" /></label>
    <label className="safety-field">Камера<select className="select" disabled={busy} value={draft.camera_id} onChange={e => { change('camera_id', e.target.value); change('polygon', []); setLocalFile(null); setSnapshot(''); setReference(); setClosed(false) }}>{config.cameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
    <div className="safety-actions"><button type="button" className="btn small" disabled={busy} onClick={capture}>Взять текущий кадр</button><label className="safety-field">Или кадр с этой камеры<input type="file" disabled={busy} accept="image/png,image/jpeg,image/webp" onChange={e => { const file=e.target.files?.[0]; if(file) { setLocalFile(file); setReference() } }} /></label></div>
    <p className="hint">Нажмите по границам зоны на изображении, затем «Замкнуть зону». Изображение используется для настройки; анализ идёт по поступающим кадрам.</p>
    {snapshot && !imageError ? <div className="safety-image safety-draw" ref={image} onClick={e => { if (!imageLoaded) return; const r = image.current!.getBoundingClientRect(); addPoint([Math.max(0, Math.min(1, (e.clientX-r.left)/r.width)), Math.max(0, Math.min(1, (e.clientY-r.top)/r.height))]) }}><img key={imageRevision} src={snapshot} alt="Кадр для настройки границ зоны" draggable={false} onLoad={() => setImageLoaded(true)} onError={() => { setImageError(true); setImageLoaded(false) }} /><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Границы зоны"><polygon points={draft.polygon.map(([x,y]) => `${x*100},${y*100}`).join(' ')} />{draft.polygon.map(([x,y], i) => <circle key={i} cx={x*100} cy={y*100} r=".8" />)}</svg></div> : <p className="safety-state">{imageError ? 'Кадр не удалось открыть. Загрузите другое изображение.' : 'Возьмите кадр камеры или загрузите изображение для разметки зоны.'}</p>}
    <div className="safety-actions"><span>Точек: {draft.polygon.length}/32{closed ? ' · зона замкнута' : ''}</span><button type="button" className="btn small" disabled={!draft.polygon.length || busy} onClick={() => { change('polygon', draft.polygon.slice(0, -1)); setClosed(false) }}>Отменить точку</button><button type="button" className="btn small" disabled={!draft.polygon.length || busy} onClick={() => { change('polygon', []); setClosed(false) }}>Очистить</button><button type="button" className="btn small" disabled={!!geometryError || closed || busy} onClick={() => { setClosed(true); setDirty(true) }}>Замкнуть зону</button></div>
    {draft.polygon.length >= 3 && geometryError && <p className="err-line" role="alert">{geometryError}</p>}
    <details><summary>Ввести точки с клавиатуры</summary><p className="hint">Координаты от 0 до 1: X слева направо, Y сверху вниз. Порядок точек — по границе зоны.</p><div className="safety-actions">{(['X','Y'] as const).map((label,i) => <label className="safety-field" key={label}>{label}<input className="input" type="number" min="0" max="1" step=".001" value={keyboardPoint[i]} onChange={e => setKeyboardPoint(p => i === 0 ? [Number(e.target.value),p[1]] : [p[0],Number(e.target.value)])} /></label>)}<button type="button" className="btn small" disabled={busy || closed || draft.polygon.length >= 32 || keyboardPoint.some(v => !Number.isFinite(v) || v<0 || v>1)} onClick={() => addPoint(keyboardPoint)}>Добавить точку</button></div><ol>{draft.polygon.map(([x,y],i) => <li key={i}>{i+1}: X {x.toFixed(3)}, Y {y.toFixed(3)}</li>)}</ol></details>
    <label className="safety-field">Основание площадки<textarea className="input" disabled={busy} rows={3} maxLength={4000} value={draft.site_basis} onChange={e => change('site_basis', e.target.value)} placeholder="Документ, номер, дата и пункт: утверждённая схема движения, ППР или инструкция. Объясните, почему здесь действует ограничение." /></label>
    <label className="safety-field">Ответственный<select className="select" disabled={busy} value={draft.responsible_user_id} onChange={e => change('responsible_user_id', e.target.value)}><option value="">Выберите ответственного</option>{config.responsibles.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
    {draft.scenario === 'vehicle_restricted_zone' && <fieldset className="safety-classes"><legend>Разрешённые классы техники</legend><p className="hint">{draft.allowed_classes.length ? 'Выбранные классы не создают события в этой зоне.' : 'Ничего не выбрано: вся поддерживаемая техника запрещена.'}</p>{vehicles.map(([key,label]) => <label className="safety-check" key={key}><input type="checkbox" disabled={busy} checked={draft.allowed_classes.includes(key)} onChange={e => change('allowed_classes', e.target.checked ? [...draft.allowed_classes,key] : draft.allowed_classes.filter(x => x !== key))} />{label}</label>)}</fieldset>}
    <div className="form-grid two-col"><label className="safety-field">Наблюдение не менее, секунд<input className="input" disabled={busy} type="number" min="1" max="300" required value={draft.min_duration_seconds} onChange={e => change('min_duration_seconds', Number(e.target.value))} /></label><label className="safety-field">Порог детекции<input className="input" disabled={busy} type="number" min="0.5" max="0.99" step=".01" required value={draft.confidence_threshold} onChange={e => change('confidence_threshold', Number(e.target.value))} /></label></div>
    <label className="safety-check"><input type="checkbox" disabled={busy || !imageLoaded} checked={checked} onChange={e => { setChecked(e.target.checked); setDirty(true) }} />Я проверил границы, ракурс и применимость основания к этой зоне</label>
    <label className="safety-check"><input type="checkbox" disabled={busy} checked={draft.enabled} onChange={e => change('enabled', e.target.checked)} />Включить контроль после сохранения</label>
    {!canSave && <p className="hint" role="status">Для сохранения нужно: {missing.join('; ')}. Выключенная зона тоже сохраняется с корректными границами и основанием.</p>}
    {error && <p className="err-line" role="alert">{error}</p>}
    <div className="safety-actions"><button className="btn primary" disabled={!canSave || busy}>{busy ? 'Сохраняем…' : draft.enabled ? 'Сохранить и включить' : 'Сохранить выключенной'}</button><button type="button" className="btn ghost" disabled={busy} onClick={onCancel}>Отменить изменения</button></div>
  </form>
}

function NormRecords({ rows }: { rows: Record<string, unknown>[] }) {
  return <>{rows.map((r, i) => <div className="safety-norm" key={String(r.id ?? i)}><strong>{[String(r.title ?? r.code ?? r.document_title ?? ''), ...[r.code, r.clause, r.article].filter(v => typeof v === 'string' && !String(r.title ?? r.code ?? r.document_title ?? '').includes(v))].join(' · ')}</strong><p>{words(r, 'summary', 'text', 'description', 'requirement', 'condition', 'conditions', 'applicability', 'applicability_note', 'document_applicability_note')}</p>
    {typeof r.subject === 'string' && <p><strong>{r.subject}</strong>{typeof r.min_amount === 'number' && typeof r.max_amount === 'number' ? `: ${r.min_amount.toLocaleString('ru-RU')}–${r.max_amount.toLocaleString('ru-RU')} ${r.currency === 'RUB' ? '₽' : String(r.currency ?? '')}` : ''}</p>}
    <dl className="safety-meta">{[['edition','Редакция'],['effective_from','Действует с'],['effective_to','Действует до'],['verified_at','Проверено'],['verification_status','Статус проверки']].map(([key,label]) => typeof r[key] === 'string' ? <div key={key}><dt>{label}</dt><dd>{String(r[key])}</dd></div> : null)}</dl>
    {typeof r.url === 'string' && /^https:\/\//.test(r.url) && <a href={r.url} target="_blank" rel="noreferrer">Открыть источник ↗</a>}</div>)}</>
}

function SafetyCase({ projectId, event, config, onBack, onReview, onDirtyChange }: { projectId: string; event: SafetyEvent; config: SafetyConfiguration | null; onBack: () => void; onReview: (decision: 'confirmed' | 'rejected', comment: string) => Promise<void>; onDirtyChange: (dirty: boolean) => void }) {
  const [kind, setKind] = useState<'first' | 'last'>('last')
  const [imageUrl, setImageUrl] = useState('')
  const [imageError, setImageError] = useState('')
  const [imageLoaded, setImageLoaded] = useState(false)
  const [viewedLast, setViewedLast] = useState(false)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [decision, setDecision] = useState<'confirmed' | 'rejected' | null>(null)
  useEffect(() => { onDirtyChange(!!decision || !!comment); }, [decision, comment, onDirtyChange])
  useEffect(() => {
    const controller = new AbortController(); let url = ''
    setImageUrl(''); setImageError(''); setImageLoaded(false)
    safety.safetyEvidence(event.id, controller.signal, kind).then(blob => { if (!controller.signal.aborted) { url = URL.createObjectURL(blob); setImageUrl(url) } }, e => { if (!controller.signal.aborted) setImageError(message(e)) })
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url) }
  }, [event.id, kind])
  const allowed = event.can_review === true
  const reviewer = config?.responsibles.find(u => u.id === event.reviewed_by)?.name ?? 'Ответственный'
  const cameraName = config?.cameras.find(c => c.id === event.camera_name)?.name ?? event.camera_name
  return <article className="safety-case"><button className="btn small ghost" disabled={busy} onClick={onBack}>← Все события</button><p className="kicker">{statusLabel[event.status]}</p><h3>{safety.SAFETY_SCENARIOS[event.scenario]}</h3><p>{event.zone_snapshot.name} · {cameraName}</p>
    <div className="safety-actions" role="group" aria-label="Сохранённые кадры">{(['first','last'] as const).map(k => <button className="btn small" key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{k === 'first' ? 'Первый кадр' : 'Последний кадр'}</button>)}</div>
    <p className="hint">Время по источнику: {stamp(kind === 'first' ? event.first_seen : event.last_seen)}. {kind === 'first' ? 'На первом кадре показана только зона: рамки последнего кадра сюда не переносятся.' : 'Рамки относятся к последнему сохранённому кадру.'}</p>
    {imageUrl && !imageError ? <div className="safety-image"><img src={imageUrl} alt={kind === 'first' ? 'Первый сохранённый кадр события' : 'Последний сохранённый кадр события'} onLoad={() => { setImageLoaded(true); if (kind === 'last') setViewedLast(true) }} onError={() => { setImageError('Кадр доказательства недоступен'); setImageLoaded(false) }} /><svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Зона и обнаруженные объекты"><polygon points={event.zone_snapshot.polygon.map(([x,y]) => `${x*100},${y*100}`).join(' ')} />{kind === 'last' && event.detections.map((d, i) => <rect key={i} x={d.x1*100} y={d.y1*100} width={(d.x2-d.x1)*100} height={(d.y2-d.y1)*100} />)}</svg></div> : <p className="safety-state" role="status">{imageError || 'Загружаем сохранённый кадр…'}</p>}
    <h4>Наблюдение</h4><p>{event.candidate_reason}</p><p>Начало по источнику: {stamp(event.first_seen)}<br />Последний кадр по источнику: {stamp(event.last_seen)}<br />Зарегистрировано сервером: {stamp(event.created_at)}</p><p className="hint">Наблюдаемое время: {Math.max(0, Math.round((event.last_position_ms-event.first_position_ms)/1000))} с · кадров: {event.observations}. Это серия кадров, а не непрерывное доказательство нахождения одного объекта.</p>
    <ul>{event.detections.map((d,i) => { const code = toObservationCode(d.raw_label); return <li key={i}>{code ? OBSERVATION_LABELS[code] : d.raw_label} · оценка модели {Math.round(d.confidence*100)}%</li> })}</ul><p className="hint">Оценка модели не является вероятностью нарушения. Расстояния и свободную ширину прохода по рамке определить нельзя.</p><p className="hint">{event.limitations}</p>
    <h4>Условие правила</h4><p>{event.zone_snapshot.site_basis}</p><p className="hint">Сохранённая версия зоны · порог {event.zone_snapshot.min_duration_seconds} с · ответственный: {event.zone_snapshot.responsible_name ?? config?.responsibles.find(u => u.id === event.zone_snapshot.responsible_user_id)?.name ?? 'Указан в настройках события'}</p>
    {!!event.pprRequirements?.length && <><h4>Основание ППР объекта</h4><PprCitations projectId={projectId} citations={event.pprRequirements} /></>}
    <h4>Нормативное основание</h4><NormRecords rows={event.norm_snapshot} />
    <h4>Возможная ответственность</h4><p className="hint">Сумма не начислена. Нужны проверка применимости нормы и установление состава правонарушения. Решение принимает уполномоченный орган.</p><NormRecords rows={event.sanction_snapshot} />
    <details><summary>Данные доказательства</summary><p className="safety-hash">Модель SHA256: {event.model_sha256}</p><p className="safety-hash">Первый кадр SHA256: {event.first_evidence_sha256}</p><p className="safety-hash">Последний кадр SHA256: {event.evidence_sha256}</p><p className="safety-hash">Событие: {event.id} · источник: {event.source_id}</p><p>Алгоритм: {event.algorithm_version}. В карточке сохранены версии зоны и нормативного основания на момент события.</p>{event.reviewed_by && <p className="safety-hash">Идентификатор проверяющего: {event.reviewed_by}</p>}</details>
    {event.status === 'pending' && allowed ? <div className="safety-review"><h4>Проверка ответственным</h4><p>Подтвердите только видимое наблюдение после проверки кадра и основания площадки. Комментарий — не менее 5 символов.</p>{!viewedLast && <p className="hint">Для подтверждения дождитесь открытия последнего кадра. При недоступном доказательстве можно отклонить событие с объяснением.</p>}<div className="safety-actions"><button className="btn" aria-pressed={decision === 'confirmed'} disabled={busy || !viewedLast || !imageLoaded} onClick={() => setDecision('confirmed')}>Подтвердить наблюдение</button><button className="btn" aria-pressed={decision === 'rejected'} disabled={busy} onClick={() => setDecision('rejected')}>Отклонить</button></div>{decision && <><label className="safety-field">Комментарий проверки<textarea className="input" disabled={busy} rows={3} maxLength={4000} value={comment} onChange={e => setComment(e.target.value)} placeholder={decision === 'rejected' ? 'Объясните причину отклонения' : 'Что видно на кадре и почему применимо основание'} /></label><button className="btn primary" disabled={busy || comment.trim().length < 5 || (decision === 'confirmed' && (!viewedLast || !imageLoaded))} onClick={async () => { setBusy(true); setError(''); try { await onReview(decision, comment.trim()); setDecision(null); setComment(''); onDirtyChange(false) } catch (e) { setError(message(e)) } finally { setBusy(false) } }}>{busy ? 'Сохраняем решение…' : 'Сохранить решение'}</button></>}{error && <p role="alert" className="err-line">{error}</p>}</div> : <div className="safety-state">{event.status === 'pending' ? 'Решение доступно назначенному ответственному или владельцу объекта.' : `${statusLabel[event.status]} · ${reviewer} · ${stamp(event.reviewed_at)}`}<p>{event.review_comment}</p></div>}
  </article>
}
