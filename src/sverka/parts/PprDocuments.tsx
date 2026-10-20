import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ProjectItem, UserProfile } from '../api'
import { listPprDocuments, readPprDocument, uploadPprDocument, pprOriginal, validatePprFile, PPR_ACCEPT, type PprDocument, type PprDocumentDetail } from '../pprApi'
import { CloseIcon, useToast } from './common'
import { PprAnalysisPanel } from './PprAnalysis'
import type { Stage } from '../model'
import '../ppr.css'
import { participants, type ParticipantOptionsDTO } from '../customerApi'

export function pprSize(bytes: number) {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} КБ` : `${(bytes / 1024 / 1024).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} МБ`
}
const stamp = (value: string) => new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' })
const kind = (doc: PprDocument) => doc.filename.split('.').pop()?.toUpperCase() || 'ФАЙЛ'
const message = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить действие'
const cancelled = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'

/** Project-scoped originals. Native modal keeps focus and makes the workspace inert. */
export function PprDocuments({ open, project, stages, permissions = [], requiresArea = false, onRulesChanged, onClose }: { open: boolean; project: ProjectItem; user: UserProfile; stages: Stage[]; permissions?: readonly string[]; requiresArea?: boolean; onRulesChanged: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const readerHeading = useRef<HTMLHeadingElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const listButtons = useRef(new Map<string, HTMLButtonElement>())
  const downloadSequence = useRef(0)
  const alive = useRef(true)
  const upload = useRef<AbortController | null>(null)
  const listGeneration = useRef(0)
  const toast = useToast()
  const [documents, setDocuments] = useState<PprDocument[]>([])
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [reading, setReading] = useState(false)
  const [detail, setDetail] = useState<PprDocumentDetail | null>(null)
  const [previewUrl, setPreviewUrl] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [previewRetry, setPreviewRetry] = useState(0)
  const [readerVisible, setReaderVisible] = useState(false)
  const [readerTab, setReaderTab] = useState<'original' | 'analysis'>('original')
  const [zoom, setZoom] = useState(false)
  const [uploading, setUploading] = useState<{ name: string; percent: number } | null>(null)
  const [uploadError, setUploadError] = useState('')
  const [notice, setNotice] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState('')
  const [options, setOptions] = useState<ParticipantOptionsDTO | null>(null)
  const [areaId, setAreaId] = useState('')
  const [seriesId, setSeriesId] = useState('')
  const selected = documents.find(doc => doc.id === selectedId)
  const filtered = documents.filter(doc => doc.filename.toLocaleLowerCase('ru-RU').includes(search.toLocaleLowerCase('ru-RU')))
  const canUpload = permissions.includes('document.upload')
  const canManage = permissions.includes('requirement.edit')
  useEffect(() => {
    if (!open || !canUpload) return
    const controller = new AbortController()
    participants(project.id, controller.signal).then(setOptions, error => { if (!controller.signal.aborted) setUploadError(message(error)) })
    return () => controller.abort()
  }, [open, project.id, canUpload])

  useEffect(() => {
    alive.current = true
    return () => { alive.current = false; upload.current?.abort() }
  }, [])
  useLayoutEffect(() => {
    const element = dialog.current
    if (!element) return
    if (open && !element.open) { element.showModal(); heading.current?.focus({ preventScroll: true }) }
    else if (!open && element.open) element.close()
  }, [open])
  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const generation = ++listGeneration.current
    setLoading(true)
    setListError('')
    listPprDocuments(project.id, controller.signal).then(docs => {
      if (controller.signal.aborted || generation !== listGeneration.current) return
      setDocuments(docs)
      setSelectedId(previous => docs.some(doc => doc.id === previous) ? previous : docs[0]?.id || null)
    }).catch(error => { if (!cancelled(error) && generation === listGeneration.current) setListError(message(error)) })
      .finally(() => { if (!controller.signal.aborted && generation === listGeneration.current) setLoading(false) })
    return () => controller.abort()
  }, [open, project.id, refresh])
  useEffect(() => {
    setDetail(null); setPreviewUrl(''); setPreviewError(''); setDownloadError(''); setZoom(false); setDownloading(false)
    downloadSequence.current++
    if (!open || !selectedId) { setReading(false); return }
    const controller = new AbortController()
    let url: string | undefined
    setReading(true)
    readPprDocument(project.id, selectedId, controller.signal).then(async doc => {
      if (controller.signal.aborted) return
      setDetail(doc)
      if (doc.preview_kind !== 'text') {
        const blob = await pprOriginal(project.id, selectedId, controller.signal)
        if (controller.signal.aborted) return
        url = URL.createObjectURL(blob)
        setPreviewUrl(url)
      }
    }).catch(error => { if (!cancelled(error)) setPreviewError(message(error)) })
      .finally(() => { if (!controller.signal.aborted) setReading(false) })
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url) }
  }, [open, project.id, selectedId, previewRetry])

  useLayoutEffect(() => {
    if (open && readerVisible && window.matchMedia('(max-width: 760px)').matches) readerHeading.current?.focus({ preventScroll: true })
  }, [open, readerVisible, selectedId])
  const backToList = () => {
    setReaderVisible(false)
    requestAnimationFrame(() => {
      const target = (selectedId && listButtons.current.get(selectedId)) || searchInput.current || heading.current
      target?.focus({ preventScroll: true })
    })
  }
  const choose = (doc: PprDocument) => { setSelectedId(doc.id); setReaderVisible(true); setReaderTab('original') }
  const send = async (file?: File) => {
    if (!file || upload.current) return
    if (requiresArea && !areaId) { setUploadError('Выберите назначенную область ответственности.'); return }
    const error = validatePprFile(file)
    setUploadError(error || '')
    if (error) return
    const controller = new AbortController()
    upload.current = controller
    setUploading({ name: file.name, percent: 0 }); setNotice('')
    try {
      const doc = await uploadPprDocument(project.id, file, controller.signal, percent => { if (alive.current) setUploading({ name: file.name, percent }) }, { area_id: areaId || undefined, series_id: seriesId || undefined })
      if (!alive.current) return
      listGeneration.current++
      setRefresh(value => value + 1)
      const existed = documents.some(item => item.id === doc.id)
      setDocuments(items => [doc, ...items.filter(item => item.id !== doc.id)])
      setSelectedId(doc.id); setSearch(''); setReaderVisible(true); setPreviewRetry(value => value + 1)
      setReaderTab('analysis')
      setNotice(existed ? 'Этот оригинал уже сохранён. Открыли документ из вашей библиотеки.' : 'Оригинал сохранён в библиотеке вашей организации. Требования начнут действовать после утверждения заказчиком.')
      toast(`ППР «${doc.filename}» сохранён · ${project.name}`)
    } catch (error) {
      if (alive.current) {
        if (cancelled(error)) setNotice('Загрузка отменена.')
        else setUploadError(message(error))
      }
    } finally { upload.current = null; if (alive.current) setUploading(null) }
  }
  const download = async () => {
    if (!selected || downloading) return
    const sequence = ++downloadSequence.current
    setDownloading(true); setDownloadError('')
    try {
      const blob = await pprOriginal(project.id, selected.id)
      if (!alive.current) return
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url; link.download = selected.filename
      document.body.append(link); link.click(); link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
    } catch (error) { if (alive.current && sequence === downloadSequence.current) setDownloadError(message(error)) }
    finally { if (alive.current && sequence === downloadSequence.current) setDownloading(false) }
  }

  return <dialog className="ppr-dialog" ref={dialog} aria-labelledby="ppr-title" onCancel={event => { event.preventDefault(); onClose() }} onClose={() => { if (open) onClose() }}>
    <header className="ppr-head">
      <div><span className="kicker">Документы объекта</span><h2 id="ppr-title" ref={heading} tabIndex={-1}>ППР объекта</h2><p>{project.name}</p></div>
      <button type="button" className="close-x" onClick={onClose} aria-label="Закрыть документы ППР"><CloseIcon /></button>
    </header>
    <div className="ppr-layout" data-reading={readerVisible}>
      <aside className="ppr-library" aria-label="Список документов ППР">
        <div className="ppr-library-top">
          {canUpload ? <div className="customer-form"><label>Версия документа<select value={seriesId} onChange={event => setSeriesId(event.target.value)} disabled={!!uploading}><option value="">Новая серия ППР</option>{documents.filter((doc, index, all) => doc.series_id && all.findIndex(item => item.series_id === doc.series_id) === index).map(doc => <option key={doc.series_id} value={doc.series_id!}>Новая версия: {doc.filename}</option>)}</select></label>{(requiresArea || !!options?.areas.length) && <label>Область ответственности<select value={areaId} onChange={event => setAreaId(event.target.value)} disabled={!!uploading}><option value="">{requiresArea ? 'Выберите область' : 'Объект'}</option>{options?.areas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label>}<button type="button" className="btn primary ppr-upload" disabled={!!uploading || (requiresArea && !areaId)} onClick={() => input.current?.click()}>+ Загрузить ППР</button><input ref={input} className="sr" type="file" accept={PPR_ACCEPT} tabIndex={-1} aria-label="Файл ППР" onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void send(file) }} /></div> : <p className="ppr-readonly">Вам доступны опубликованные оригиналы. Документы готовит инженер ПТО.</p>}
          <p className="ppr-formats">PDF без пароля, DOCX, JPG, PNG · до 50 МБ</p>
          {uploading && <div className="ppr-progress" role="status"><span>{uploading.percent === 100 ? 'Проверяем и сохраняем…' : `Загружаем · ${uploading.percent}%`}</span><strong>{uploading.name}</strong><progress max={100} value={uploading.percent} aria-label="Загрузка ППР" /><button type="button" className="btn small" onClick={() => upload.current?.abort()}>Отменить загрузку</button><small>Загрузка продолжится, если закрыть это окно.</small></div>}
          {uploadError && <p className="ppr-error" role="alert">{uploadError}</p>}
          {notice && <p className="ppr-notice" role="status">{notice}</p>}
          {documents.length > 0 && <label className="ppr-search"><span className="sr">Найти документ</span><input ref={searchInput} className="input" type="search" placeholder="Найти документ" value={search} onChange={event => setSearch(event.target.value)} /></label>}
        </div>
        {loading && !documents.length && <p className="ppr-list-state" role="status">Загружаем документы…</p>}
        {listError && <div className="ppr-list-state ppr-error" role="alert"><p>{listError}</p><button type="button" className="btn small" onClick={() => setRefresh(value => value + 1)}>Повторить</button></div>}
        {!loading && !listError && !documents.length && <div className="ppr-list-state"><strong>ППР пока не загружены</strong><p>Здесь хранятся исходные документы этого объекта. После загрузки их можно читать и скачивать в любое время.</p></div>}
        <ul className="ppr-files">
          {filtered.map(doc => <li key={doc.id}><button ref={node => { if (node) listButtons.current.set(doc.id, node); else listButtons.current.delete(doc.id) }} type="button" className={`ppr-file${selectedId === doc.id ? ' active' : ''}`} aria-current={selectedId === doc.id ? 'true' : undefined} onClick={() => choose(doc)}><span className="ppr-file-kind">{kind(doc)}</span><strong>{doc.filename}</strong><span>{pprSize(doc.size_bytes)} · {stamp(doc.created_at)}</span><small>Загрузил: {doc.uploaded_by}</small><span className="ppr-read-label">Читать <span aria-hidden="true">→</span></span></button></li>)}
        </ul>
        {search && !filtered.length && <div className="ppr-list-state"><p>Документы с таким названием не найдены.</p><button type="button" className="btn small" onClick={() => setSearch('')}>Сбросить поиск</button></div>}
      </aside>
      <section className="ppr-reader" aria-label="Просмотр документа">
        <button type="button" className="btn small ppr-back" onClick={backToList}>← К списку документов</button>
        {selected ? <>
          <header className="ppr-reader-head"><div><span className="kicker">{selected.preview_kind === 'text' ? 'Текст для чтения' : 'Оригинал документа'}</span><h3 ref={readerHeading} tabIndex={-1}>{selected.filename}</h3><p>{kind(selected)} · {pprSize(selected.size_bytes)}</p></div><button type="button" className="btn ppr-download" disabled={downloading} onClick={() => void download()}>{downloading ? 'Получаем оригинал…' : 'Скачать оригинал'}</button></header>
          {downloadError && <p className="ppr-error ppr-reader-note" role="alert">{downloadError}</p>}
          <div className="ppr-reader-tabs" role="tablist" aria-label="Документ и требования"><button className="btn small" type="button" role="tab" id="ppr-original-tab" aria-controls="ppr-original-panel" aria-selected={readerTab === 'original'} onClick={() => setReaderTab('original')}>Оригинал</button><button className="btn small" type="button" role="tab" id="ppr-analysis-tab" aria-controls="ppr-analysis-panel" aria-selected={readerTab === 'analysis'} onClick={() => setReaderTab('analysis')}>Требования ИИ</button></div>
          <div className="ppr-original-panel" id="ppr-original-panel" role="tabpanel" aria-labelledby="ppr-original-tab" hidden={readerTab !== 'original'}>
          {reading && <div className="ppr-preview-state" role="status">Открываем документ…</div>}
          {previewError && <div className="ppr-preview-state" role="alert"><strong>Не удалось показать документ</strong><p>{previewError}</p><button type="button" className="btn" onClick={() => setPreviewRetry(value => value + 1)}>Повторить просмотр</button><p>Вы также можете попробовать скачать оригинал.</p></div>}
          {!reading && !previewError && detail && <>
            {detail.preview_kind === 'pdf' && previewUrl && <><p className="ppr-reader-note">Для чтения на весь экран <a href={previewUrl} target="_blank" rel="noopener noreferrer">откройте оригинал PDF в новой вкладке ↗</a> или скачайте его.</p><iframe className="ppr-pdf" title={`Оригинал ППР: ${detail.filename}`} src={previewUrl} /></>}
            {detail.preview_kind === 'image' && previewUrl && <><div className="ppr-image-tools"><button type="button" className="btn small" aria-pressed={zoom} onClick={() => setZoom(value => !value)}>{zoom ? 'Вписать в окно' : 'Исходный размер'}</button></div><div className={`ppr-image-stage${zoom ? ' zoomed' : ''}`}><img src={previewUrl} alt={`Исходная страница ППР: ${detail.filename}`} onError={() => setPreviewError('Браузер не смог показать изображение. Скачайте оригинал.')} /></div></>}
            {detail.preview_kind === 'text' && <><p className="ppr-reader-note">Текст извлечён из DOCX для удобства чтения. Схемы, таблицы и оформление доступны в оригинале.</p><article className="ppr-text">{detail.display_text?.trim() ? <pre>{detail.display_text}</pre> : <div className="ppr-preview-state"><strong>В документе нет доступного текста</strong><p>Возможно, он содержит схемы или сканы. Скачайте оригинал, чтобы прочитать его полностью.</p></div>}</article></>}
          </>}
          </div>
          <PprAnalysisPanel key={selected.id} projectId={project.id} document={selected} open={open} visible={readerTab === 'analysis'} canManage={canManage} stages={stages} onRulesChanged={onRulesChanged} />
        </> : <div className="ppr-preview-state"><span className="ppr-empty-icon" aria-hidden="true">▤</span><h3>Исходные документы ППР</h3><p>{canUpload ? 'Выберите документ из списка или загрузите ППР для этого объекта.' : 'Выберите документ из списка. Если документов пока нет, их добавит ответственный за объект.'}</p><small>Здесь собраны исходные документы выбранного объекта.</small></div>}
      </section>
    </div>
  </dialog>
}
