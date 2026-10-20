import { useEffect, useState } from 'react'
import * as customer from '../customerApi'
import type { CameraMoveRequestDTO, ContextDTO, ParticipantOptionsDTO } from '../customerApi'
import type { CameraMoveDecisionCommand, CoverageConfigurationDTO } from '../../api/generated/customerControl'
import * as api from '../api'
import { can, dateTime } from './CustomerWorkspace'
import { CustomerSourceSharing } from './CustomerSourceSharing'

const moveStatus: Record<CameraMoveRequestDTO['status'], string> = { requested: 'Ожидает решения заказчика', approved: 'Перенос согласован', in_progress: 'Перенос выполняется · покрытие ограничено', awaiting_reference: 'Новый ракурс ожидает утверждения', completed: 'Восстановление принято заказчиком', rejected: 'Запрос отклонён', cancelled: 'Отменён', expired: 'Срок истёк · контроль не восстановлен' }
export function CustomerCameras({ context }: { context: ContextDTO }) {
  const [cameras, setCameras] = useState<api.CameraItem[]>([])
  const [videos, setVideos] = useState<api.SavedVideo[]>([])
  const [moves, setMoves] = useState<CameraMoveRequestDTO[]>([])
  const [coverages, setCoverages] = useState<CoverageConfigurationDTO[]>([])
  const [options, setOptions] = useState<ParticipantOptionsDTO | null>(null)
  const [cameraId, setCameraId] = useState('')
  const [from, setFrom] = useState('')
  const [until, setUntil] = useState('')
  const [reason, setReason] = useState('')
  const [plan, setPlan] = useState('')
  const [areaId, setAreaId] = useState('')
  const [coverageCameras, setCoverageCameras] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refresh, setRefresh] = useState(0)
  const writable = !context.is_demo && context.lifecycle === 'active'
  useEffect(() => {
    const controller = new AbortController(); setLoading(true)
    api.cameras(context.project_id).then(async rows => {
      const results = await Promise.all(rows.map(camera => customer.cameraMoves(context.project_id, camera.id, controller.signal)))
      if (!controller.signal.aborted) { setCameras(rows); setMoves(results.flat()); setError('') }
    }).catch(failure => { if (!controller.signal.aborted) setError(customer.errorMessage(failure)) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    if (can(context, 'video.read')) api.savedVideos(context.project_id).then(setVideos, () => undefined)
    if (can(context, 'camera.configure')) {
      customer.participants(context.project_id, controller.signal).then(setOptions, () => undefined)
      customer.coverageConfigurations(context.project_id, controller.signal).then(setCoverages, failure => { if (!controller.signal.aborted) setError(customer.errorMessage(failure)) })
    }
    return () => controller.abort()
  }, [context, refresh])
  const request = async () => {
    if (!cameraId || !from || !until || !reason.trim() || !plan.trim()) return
    if (Date.parse(until) <= Date.parse(from)) { setError('Конец окна должен быть позже начала.'); return }
    setBusy(true); setError('')
    try { await customer.requestCameraMove(context.project_id, cameraId, { requested_from: new Date(from).toISOString(), requested_until: new Date(until).toISOString(), reason, coverage_plan: plan }); setRefresh(value => value + 1); setReason(''); setPlan('') }
    catch (failure) { setError(customer.errorMessage(failure)) }
    finally { setBusy(false) }
  }
  const coverage = async () => {
    if (!areaId || !from || !coverageCameras.length || !reason.trim()) return
    setBusy(true); setError('')
    try { await customer.configureCoverage(context.project_id, { area_id: areaId, camera_ids: coverageCameras, effective_from: new Date(from).toISOString(), reason }); setRefresh(value => value + 1) }
    catch (failure) { setError(customer.errorMessage(failure)) }
    finally { setBusy(false) }
  }
  return <>
    <div className="customer-title"><div><h2>Камеры, переносы и покрытие</h2><p>Запрос не останавливает наблюдение. Утверждается точное окно; после монтажа нужен свежий ракурс и явная проверка восстановления заказчиком.</p></div><button className="btn small" type="button" onClick={() => setRefresh(value => value + 1)} disabled={loading}>Обновить</button></div>
    {error && <p className="customer-notice" data-kind="error" role="alert">{error}</p>}{loading && <p role="status">Загружаем разрешённые камеры и переносы…</p>}
    {!loading && !cameras.length && !error && <div className="customer-state"><p>Камеры для вашей области пока не опубликованы.</p></div>}
    {writable && can(context, 'camera.move.request') && cameras.length > 0 && <section className="customer-card customer-form"><h3>Запросить перенос камеры</h3><label>Камера<select value={cameraId} onChange={event => setCameraId(event.target.value)}><option value="">Выберите доступную камеру</option>{cameras.map(camera => <option value={camera.id} key={camera.id}>{camera.name}</option>)}</select></label><label>Начало окна<input type="datetime-local" value={from} onChange={event => setFrom(event.target.value)} /></label><label>Конец окна<input type="datetime-local" value={until} onChange={event => setUntil(event.target.value)} /></label><label>Причина<textarea value={reason} maxLength={4000} onChange={event => setReason(event.target.value)} /></label><label>План временного покрытия<textarea value={plan} maxLength={4000} onChange={event => setPlan(event.target.value)} /></label><button className="btn" type="button" disabled={busy || !cameraId || !from || !until || !reason.trim() || !plan.trim()} onClick={() => void request()}>Передать запрос заказчику</button></section>}
    {writable && can(context, 'evidence.publish') && <><CustomerSourceSharing context={context} kind="camera" items={cameras.map(camera => ({ id: camera.id, name: camera.name }))} /><CustomerSourceSharing context={context} kind="video" items={videos.map(video => ({ id: video.video_id, name: `${video.filename} · ${dateTime(video.start_timestamp)}` }))} /></>}
    <div className="customer-grid" style={{ marginTop: 20 }}>{moves.map(move => <Move key={`${move.id}:${move.row_version}`} move={move} name={cameras.find(camera => camera.id === move.camera_id)?.name ?? 'Камера'} context={context} onChanged={() => setRefresh(value => value + 1)} />)}</div>
    {!loading && !moves.length && !error && <p className="customer-muted">Запросов на перенос нет.</p>}
    {can(context, 'camera.configure') && <section style={{ marginTop: 28 }}><h2>Утверждённое покрытие</h2>{coverages.map(item => <article className="customer-card" key={item.id}><strong>{options?.areas.find(area => area.id === item.area_id)?.name ?? 'Область контроля'}</strong><p>{item.camera_ids.map(id => cameras.find(camera => camera.id === id)?.name ?? 'Разрешённая камера').join(', ')}</p><p className="customer-muted">С {dateTime(item.effective_from)}{item.effective_until ? ` до ${dateTime(item.effective_until)}` : ''}</p></article>)}{!loading && !coverages.length && <p className="customer-muted">Утверждённых конфигураций покрытия нет. Достаточность наблюдения не подтверждена.</p>}{writable && <div className="customer-card customer-form" style={{ marginTop: 18 }}><h3>Утвердить конфигурацию покрытия</h3><label>Область<select value={areaId} onChange={event => setAreaId(event.target.value)}><option value="">Выберите область</option>{options?.areas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label><fieldset><legend>Источники области</legend>{cameras.map(camera => <label className="customer-check" key={camera.id}><input type="checkbox" checked={coverageCameras.includes(camera.id)} onChange={event => setCoverageCameras(ids => event.target.checked ? [...ids, camera.id] : ids.filter(id => id !== camera.id))} /><span>{camera.name}</span></label>)}</fieldset><label>Начало действия<input type="datetime-local" value={from} onChange={event => setFrom(event.target.value)} /></label><label>Основание проверки покрытия<textarea value={reason} maxLength={4000} onChange={event => setReason(event.target.value)} /></label><button className="btn" type="button" disabled={busy || !areaId || !coverageCameras.length || !from || !reason.trim()} onClick={() => void coverage()}>Утвердить покрытие</button></div>}</section>}
  </>
}
function Move({ move, name, context, onChanged }: { move: CameraMoveRequestDTO; name: string; context: ContextDTO; onChanged: () => void }) {
  const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const act = async (action: CameraMoveDecisionCommand['action']) => { setBusy(true); setError(''); try { await customer.decideCameraMove(move.id, { expected_version: move.row_version, action, note }); onChanged() } catch (failure) { setError(customer.errorMessage(failure)) } finally { setBusy(false) } }
  const writable = !context.is_demo && context.lifecycle === 'active'
  const manager = can(context, 'camera.move.decide')
  return <article className="customer-card customer-form"><span className="customer-status">{moveStatus[move.status]}</span><h3>{name}</h3><p>{dateTime(move.requested_from)} — {dateTime(move.requested_until)}</p><p>{move.reason}</p><p className="customer-muted">Временное покрытие: {move.coverage_plan}</p>{move.status === 'awaiting_reference' && <p>Предложите свежий кадр в разделе «Контроль и источники». Управляющий проверяет ракурс и утверждает его перед завершением переноса.</p>}{writable && !['completed', 'rejected', 'cancelled', 'expired'].includes(move.status) && <><label>Комментарий решения<textarea value={note} maxLength={4000} onChange={event => setNote(event.target.value)} /></label><div className="customer-actions">{manager && move.status === 'requested' && <><button type="button" className="btn" disabled={busy || !note.trim()} onClick={() => void act('approve')}>Согласовать точное окно</button><button type="button" className="btn" disabled={busy || !note.trim()} onClick={() => void act('reject')}>Отклонить</button></>}{move.status === 'approved' && <button type="button" className="btn" disabled={busy || !note.trim()} onClick={() => void act('start')}>Отметить начало переноса</button>}{move.status === 'in_progress' && <button type="button" className="btn" disabled={busy || !note.trim()} onClick={() => void act('propose_reference')}>Монтаж закончен — проверить ракурс</button>}{manager && move.status === 'awaiting_reference' && <button type="button" className="btn primary" disabled={busy || !note.trim()} onClick={() => void act('complete')}>Подтвердить восстановление контроля</button>}{['requested', 'approved'].includes(move.status) && <button type="button" className="btn" disabled={busy || !note.trim()} onClick={() => void act('cancel')}>Отменить запрос</button>}</div></>}{error && <p className="ppr-error" role="alert">{error}</p>}</article>
}
