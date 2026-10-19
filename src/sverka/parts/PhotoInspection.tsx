import { useEffect, useRef, useState } from 'react'
import { detectPhoto, type DetectResponse } from '../api'
import { OBSERVATION_CODES, OBSERVATION_LABELS, toObservationCode } from '../../domain/constructionObservations'

const FALLBACK = { not_requested: 'Не запрашивалось', not_needed: 'Не потребовалось: есть результаты YOLO', used: 'Использован VLM', empty: 'VLM не нашёл объектов', unavailable: 'VLM недоступен', timeout: 'Время ожидания VLM истекло', error: 'Ошибка VLM' }

export function PhotoInspection() {
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState('')
  const [result, setResult] = useState<DetectResponse | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [threshold, setThreshold] = useState(0.5)
  const [boxes, setBoxes] = useState(true)
  const generation = useRef(0)
  useEffect(() => {
    generation.current++
    setResult(null)
    setError('')
    setBusy(false)
    const objectUrl = file ? URL.createObjectURL(file) : ''
    setUrl(objectUrl)
    return () => { generation.current++; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [file])
  const run = async () => {
    if (!file || busy) return
    const request = ++generation.current
    setBusy(true); setError(''); setResult(null)
    try {
      const response = await detectPhoto(file)
      if (request === generation.current) setResult(response)
    } catch (e) {
      if (request === generation.current) setError(e instanceof Error ? e.message : 'Сервис не ответил')
    } finally {
      if (request === generation.current) setBusy(false)
    }
  }
  const visible = result?.detections.filter(d => d.confidence >= threshold) ?? []
  const label = (raw: string, ru: string) => { const code = toObservationCode(raw); return code ? OBSERVATION_LABELS[code] : ru || raw }
  return <section className="photo-inspection" aria-label="Проверка фотографии">
    <h3>Распознавание на фото</h3>
    <p>YOLO анализирует фото на сервере. Если объектов нет, сервер может отправить фото в OpenRouter для VLM, когда этот резервный сервис настроен. Для видео VLM не используется.</p>
    <div className="photo-controls">
      <label>Фотография <input type="file" accept="image/jpeg,image/png,image/webp" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
      <button type="button" className="btn primary" disabled={!file || busy} onClick={() => void run()}>{busy ? 'Распознаём…' : 'Распознать фото'}</button>
    </div>
    <div className="photo-controls">
      <label>Порог уверенности {Math.round(threshold * 100)}% <input aria-label="Порог уверенности на фото" type="range" min="0.1" max="0.9" step="0.05" value={threshold} onChange={e => setThreshold(Number(e.target.value))} /></label>
      <label><input type="checkbox" checked={boxes} onChange={e => setBoxes(e.target.checked)} /> Показать рамки</label>
    </div>
    <p>Уверенность модели не является измеренной точностью. Число рамок не означает число уникальных машин.</p>
    {error && <p role="alert">{error}</p>}
    {result && <div role="status">
      <p>Источник: {(result.source ?? 'yolo').toUpperCase()} · {result.model_ready ? 'Модель готова' : 'Модель недоступна'} · рамок выше порога: {visible.length} из {result.detections.length}</p>
      <p>Резервное распознавание: {FALLBACK[result.fallback_status ?? 'not_requested']}{result.fallback_message ? ` · ${result.fallback_message}` : ''}</p>
      {result.message && <p>{result.message}</p>}
      {result.model_sha256 && <p className="photo-hash">SHA256 модели: {result.model_sha256}</p>}
    </div>}
    {url && <div className="photo-canvas">
      <img src={url} alt={file?.name ?? 'Исходная фотография'} />
      {boxes && <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Рамки распознавания">{visible.map((d, i) => <g key={i}>
        <rect x={d.x1 * 100} y={d.y1 * 100} width={(d.x2 - d.x1) * 100} height={(d.y2 - d.y1) * 100} />
        <text x={d.x1 * 100} y={Math.max(2, d.y1 * 100 - 0.5)}>{label(d.canonical_code || d.raw_label, d.label_ru)} {Math.round(d.confidence * 100)}%</text>
      </g>)}</svg>}
    </div>}
    {visible.length > 0 && <ul>{visible.map((d, i) => <li key={i}>{label(d.canonical_code || d.raw_label, d.label_ru)} · {Math.round(d.confidence * 100)}% · [{[d.x1, d.y1, d.x2, d.y2].map(v => v.toFixed(3)).join(', ')}]</li>)}</ul>}
    <details><summary>Классы модели: {OBSERVATION_CODES.length}</summary><p>{OBSERVATION_CODES.map(c => OBSERVATION_LABELS[c]).join(' · ')}</p></details>
  </section>
}
