import { useEffect, useRef, useState } from 'react'
import { ApiError } from '../api'
import { OBSERVATION_LABELS, toObservationCode } from '../../domain/constructionObservations'
import { analyzeLive, liveConfig, liveSession, type LiveConfig, type LiveObservation } from '../liveDemoApi'
import './myvms-demo.css'

export function MyVmsDemo({ projectId }: { projectId: string }) {
  const [config, setConfig] = useState<LiveConfig | null>(null)
  const [channel, setChannel] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    liveConfig(projectId, controller.signal).then(result => {
      if (controller.signal.aborted) return
      setConfig(result); setChannel(result.cameras[0]?.channel ?? null); setError('')
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message) })
    return () => controller.abort()
  }, [projectId, retry])
  return <section className="myvms-demo" aria-label="Live-камеры MyVMS">
    <div className="myvms-heading"><div><span className="kicker">Демонстрация · реальная камера</span><h2>Прямой эфир со стройплощадки</h2><p>YOLO анализирует свежие кадры. Наблюдения этого сеанса не создают дела и не подтверждают нарушения.</p></div>
      {config?.enabled && <label>Камера <select aria-label="Live-камера MyVMS" value={channel ?? ''} onChange={event => setChannel(Number(event.target.value))}>{config.cameras.map(camera => <option key={camera.channel} value={camera.channel}>{camera.name}</option>)}</select></label>}
    </div>
    {error ? <div className="myvms-notice" role="alert">{error} <button type="button" className="btn small" onClick={() => setRetry(n => n + 1)}>Повторить подключение</button></div>
      : !config ? <p role="status">Подключаем демо-камеры…</p>
      : !config.enabled || channel === null ? <p role="status">Демо-подключение MyVMS ещё не включено на сервере.</p>
      : <LiveCamera key={`${projectId}:${channel}`} projectId={projectId} channel={channel} interval={Math.max(2000, config.analysis_interval_ms)} />}
  </section>
}

function LiveCamera({ projectId, channel, interval }: { projectId: string; channel: number; interval: number }) {
  const [running, setRunning] = useState(true)
  const [view, setView] = useState<'analysis' | 'video'>('analysis')
  const [observation, setObservation] = useState<LiveObservation | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [frames, setFrames] = useState(0)
  const [peaks, setPeaks] = useState<Record<string, number>>({})
  const [history, setHistory] = useState<{ at: string; summary: string }[]>([])
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => {
    if (!running) return
    const controller = new AbortController()
    let timer = 0
    const poll = async () => {
      setBusy(true)
      const attempt = new AbortController()
      const cancelAttempt = () => attempt.abort()
      controller.signal.addEventListener('abort', cancelAttempt, { once: true })
      const timeout = setTimeout(() => attempt.abort(), 60_000)
      try {
        const next = await analyzeLive(projectId, channel, attempt.signal)
        if (controller.signal.aborted) return
        setObservation(next); setError('')
        if (next.analysis?.model_ready) {
          const counts = countLabels(next)
          setFrames(n => n + 1)
          setPeaks(previous => {
            const result = { ...previous }
            for (const [label, count] of Object.entries(counts)) result[label] = Math.max(result[label] ?? 0, count)
            return result
          })
          const summary = Object.entries(counts).map(([label, count]) => `${label}: ${count}`).join(', ') || 'Объекты не распознаны'
          setHistory(previous => [{ at: next.captured_at, summary }, ...previous].slice(0, 8))
        }
      } catch (failure) {
        if (controller.signal.aborted) return
        setError(attempt.signal.aborted ? 'Сервер не завершил анализ за 60 секунд' : failure instanceof Error ? failure.message : 'Камера недоступна')
        if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) setRunning(false)
      } finally {
        clearTimeout(timeout)
        controller.signal.removeEventListener('abort', cancelAttempt)
        if (!controller.signal.aborted) { setBusy(false); timer = window.setTimeout(poll, interval) }
      }
    }
    void poll()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [running, projectId, channel, interval])
  const age = observation ? Math.max(0, now - Date.parse(observation.captured_at)) : Infinity
  const fresh = running && !error && age < 15_000
  const valid = fresh && observation?.analysis?.model_ready === true
  const detections = valid ? observation.analysis!.detections : []
  const counts = valid ? countLabels(observation!) : {}
  const analysisError = observation?.analysis_error || (observation?.analysis && !observation.analysis.model_ready ? observation.analysis.message || 'Модель недоступна' : '')
  return <>
    <div className="myvms-controls"><div role="group" aria-label="Режим live-просмотра"><button className="btn small" type="button" aria-pressed={view === 'analysis'} onClick={() => setView('analysis')}>Кадр с детекцией</button><button className="btn small" type="button" aria-pressed={view === 'video'} onClick={() => setView('video')}>Видеопоток</button></div><button className="btn small" type="button" onClick={() => setRunning(value => !value)}>{running ? 'Пауза анализа' : 'Запустить live-анализ'}</button><span role="status">{!running ? 'Анализ приостановлен' : busy ? 'Получаем и анализируем кадр…' : 'Live-анализ включён'}</span></div>
    {error && <p className="myvms-notice" role="alert">{error}. Повторяем подключение; предыдущий кадр не считается свежим.</p>}
    {analysisError && <p className="myvms-notice" role="alert">Распознавание недоступно: {analysisError}. Видеопоток можно смотреть отдельно.</p>}
    <div className="myvms-layout"><div>
      {view === 'video' ? <LiveVideo projectId={projectId} channel={channel} /> : <div className="myvms-frame" data-stale={!fresh}>
        {observation ? <><img src={observation.frame} alt={`Кадр Camera ${channel + 1} для анализа`} /><div className="myvms-boxes">{detections.map((item, index) => <div className="myvms-box" key={index} style={{ left: `${item.x1 * 100}%`, top: `${item.y1 * 100}%`, width: `${(item.x2 - item.x1) * 100}%`, height: `${(item.y2 - item.y1) * 100}%` }}><span title={item.label_ru}>{shortLabel(item.raw_label, item.label_ru)} · {Math.round(item.confidence * 100)}%</span></div>)}</div><div className="myvms-frame-label">{fresh ? 'Свежий кадр' : running ? 'Ожидаем свежий кадр' : 'Последний кадр · пауза'} · {clock(observation.captured_at)}</div></> : <p role="status">Ожидаем первый кадр камеры…</p>}
      </div>}
      <p className="myvms-caption">{view === 'video' ? 'Непрерывный видеопоток. Рамки доступны на вкладке «Кадр с детекцией».' : 'Рамки относятся именно к показанному кадру. Следующий запрос — через 2 секунды после завершения анализа.'}</p>
    </div><aside className="myvms-analysis" aria-label="Результаты live-анализа"><h3>На последнем кадре</h3>
      {!valid ? <p>{!running ? 'Анализ на паузе.' : analysisError ? 'Нет результата распознавания.' : 'Ожидаем успешный анализ свежего кадра.'}</p> : Object.keys(counts).length ? <ul>{Object.entries(counts).map(([label, count]) => <li key={label}><span>{label}</span><strong>{count}</strong></li>)}</ul> : <p>Объекты не распознаны. Это не доказывает отсутствие техники.</p>}
      <dl><div><dt>Проанализировано кадров</dt><dd>{frames}</dd></div><div><dt>Возраст кадра</dt><dd>{Number.isFinite(age) ? `${Math.floor(age / 1000)} с` : '—'}</dd></div><div><dt>Время распознавания</dt><dd>{observation ? `${observation.inference_ms} мс` : '—'}</dd></div></dl>
      {Object.keys(peaks).length > 0 && <><h3>Максимум одновременно за сеанс</h3><ul>{Object.entries(peaks).map(([label, count]) => <li key={label}><span>{label}</span><strong>{count}</strong></li>)}</ul><p>Это число объектов на одном кадре, без подсчёта уникальных машин.</p></>}
    </aside></div>
    {history.length > 0 && <details className="myvms-history"><summary>Последние наблюдения этого сеанса</summary><ol>{history.map((item, index) => <li key={`${item.at}:${index}`}><time>{clock(item.at)}</time> {item.summary}</li>)}</ol></details>}
    <p className="myvms-caption">Анализ работает, пока этот экран открыт. Модель может ошибаться; наблюдения требуют проверки. Live-камеры не привязаны к историческому плану демо-объекта.</p>
  </>
}

function LiveVideo({ projectId, channel }: { projectId: string; channel: number }) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    const element = video.current!
    const connect = async () => {
      try {
        const url = await liveSession(projectId, channel, controller.signal)
        if (controller.signal.aborted) return
        setError(''); element.src = url; element.load()
        await element.play().catch(() => undefined)
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Нет связи с камерой') }
    }
    void connect()
    const renew = setInterval(() => { void connect() }, 240_000)
    return () => { controller.abort(); clearInterval(renew); element.pause(); element.removeAttribute('src'); element.load() }
  }, [projectId, channel, retry])
  return <div className="myvms-video"><video ref={video} aria-label={`Прямой видеопоток Camera ${channel + 1}`} crossOrigin="use-credentials" muted playsInline controls onError={() => setError('Видеопоток прервался или формат не поддерживается браузером')} />{error && <p className="myvms-notice" role="alert">{error}. <button className="btn small" type="button" onClick={() => setRetry(n => n + 1)}>Переподключить видео</button></p>}</div>
}

function clock(at: string) { return new Date(at).toLocaleTimeString('ru-RU') }
function shortLabel(raw: string, fallback: string) { const code = toObservationCode(raw); return code ? OBSERVATION_LABELS[code] : fallback }
function countLabels(observation: LiveObservation) {
  const counts: Record<string, number> = {}
  for (const item of observation.analysis?.detections ?? []) counts[item.label_ru] = (counts[item.label_ru] ?? 0) + 1
  return counts
}
