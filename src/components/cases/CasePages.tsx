import { useEffect, useMemo, useState } from 'react'
import { type Incident, type IncidentStatus } from '../../data'
import { type ProjectItem } from '../../api/stroyControlApi'
import { incidentDateTime, incidentKind, isDeviation, isOpenIncident } from '../../domain/incidentPresentation'
import { Icon, Status } from '../ui/Primitives'
import { IncidentCostButton } from '../management/IncidentCost'
import './case-pages.css'

const kindLabels = { error: 'Ошибка', warning: 'Предупреждение', info: 'Информация' }
type KindFilter = 'all' | 'error' | 'warning' | 'info'
const incidentStatuses: IncidentStatus[] = ['Ожидает обработки', 'Требует проверки', 'Подтверждено', 'В работе', 'Устранено', 'Проблемы нет', 'Ложное срабатывание']

function EvidenceImage({ src, alt, contain = false }: { src?: string; alt: string; contain?: boolean }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  if (!src || failedUrl === src) {
    return <div className="case-pages-image-empty"><Icon name="camera" size={24} /><span>{src ? 'Фото недоступно' : 'Фото отсутствует'}</span></div>
  }
  return <img className={contain ? 'case-pages-image contain' : 'case-pages-image'} src={src} alt={alt} onError={() => setFailedUrl(src)} />
}

function KindBadge({ incident }: { incident: Incident }) {
  const kind = incidentKind(incident)
  return <span className={`case-pages-kind case-pages-kind-${kind}`}>{kindLabels[kind]}</span>
}

function CaseStatus({ incident, onChange }: { incident: Incident; onChange?: (id: string, status: IncidentStatus) => void }) {
  if (!isDeviation(incident)) return <Status tone="neutral">{incident.discrepancyType?.startsWith('STREAM_') ? 'Видеопоток' : 'Информация'}</Status>
  if (!onChange) return <Status tone={isOpenIncident(incident) ? 'warning' : 'neutral'}>{incident.status}</Status>
  return <select className="case-pages-status" aria-label={`Статус ${incident.id}`} value={incident.status} onChange={(e) => onChange(incident.id, e.target.value as IncidentStatus)}>{incidentStatuses.map((status) => <option key={status} value={status}>{status}</option>)}</select>
}

function CaseFilters({ query, onQuery, kind, onKind }: { query: string; onQuery: (value: string) => void; kind: KindFilter; onKind: (value: KindFilter) => void }) {
  return <div className="case-pages-toolbar">
    <label className="case-pages-search"><Icon name="search" size={18} /><input value={query} onChange={(e) => onQuery(e.target.value)} placeholder="Поиск по названию, участку или номеру" aria-label="Поиск записей" /></label>
    <label className="case-pages-filter"><Icon name="filter" size={16} /><select aria-label="Тип события" value={kind} onChange={(e) => onKind(e.target.value as KindFilter)}><option value="all">Все события</option><option value="error">Ошибки</option><option value="warning">Предупреждения</option><option value="info">Информация</option></select></label>
  </div>
}

function matchesIncident(incident: Incident, kind: KindFilter, query: string) {
  if (kind !== 'all' && incidentKind(incident) !== kind) return false
  return `${incident.id} ${incident.title} ${incident.note} ${incident.zone} ${incident.stageName || ''}`.toLowerCase().includes(query.trim().toLowerCase())
}

function albumFor(incident: Incident) {
  return incident.albumPhotos?.length ? incident.albumPhotos : incident.snapshotUrl ? [{ url: incident.snapshotUrl, cameraName: incident.camera, isPrimary: true }] : []
}

function PhotoViewer({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [onClose])
  return <div className="modal-backdrop case-pages-overlay" onClick={onClose}><div className="case-pages-fullscreen" role="dialog" aria-modal="true" aria-label="Просмотр фото" onClick={(e) => e.stopPropagation()}><EvidenceImage src={src} alt="Фотофиксация события" contain /><button className="button case-pages-close" onClick={onClose}><Icon name="close" size={16} />Закрыть</button></div></div>
}

export function PhotoArchive({ incidents, violationWindowSeconds, highlightedIncidentId, onNavigateToReport, onStatusChange, toast }: {
  incidents: Incident[]
  violationWindowSeconds: number
  highlightedIncidentId?: string | null
  onNavigateToReport: (incidentId: string) => void
  onStatusChange?: (incidentId: string, newStatus: IncidentStatus) => void
  toast: (s: string) => void
}) {
  const [filterKind, setFilterKind] = useState<KindFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null)
  const [selectedAlbumId, setSelectedAlbumId] = useState<string | null>(null)
  const [activeAlbumPhotoIndex, setActiveAlbumPhotoIndex] = useState(0)
  const selectedAlbumIncident = incidents.find((incident) => incident.id === selectedAlbumId)
  const incidentsWithPhotos = incidents.filter((incident) => albumFor(incident).length > 0)
  const filteredIncidents = incidentsWithPhotos.filter((incident) => matchesIncident(incident, filterKind, searchQuery))
  const openAlbum = (incident: Incident, index = 0) => { setSelectedAlbumId(incident.id); setActiveAlbumPhotoIndex(index) }
  useEffect(() => {
    if (highlightedIncidentId && incidents.some((incident) => incident.id === highlightedIncidentId)) {
      setSelectedAlbumId(highlightedIncidentId)
      setActiveAlbumPhotoIndex(0)
    }
  }, [highlightedIncidentId, incidents])
  useEffect(() => {
    if (!selectedAlbumId) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !selectedPhoto) setSelectedAlbumId(null) }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [selectedAlbumId, selectedPhoto])
  return <div className="case-pages case-pages-archive">
    <CaseFilters query={searchQuery} onQuery={setSearchQuery} kind={filterKind} onKind={setFilterKind} />
    <div className="case-pages-caption"><span>Альбомы · {filteredIncidents.length}</span><span>Окно фиксации: {violationWindowSeconds} с</span></div>
    {filteredIncidents.length === 0 ? <div className="case-pages-empty panel"><Icon name="archive" size={28} /><h2>{incidentsWithPhotos.length ? 'Альбомы не найдены' : 'В архиве пока нет снимков'}</h2><p>{incidentsWithPhotos.length ? 'Измените поисковый запрос или тип события.' : 'Здесь появятся фотофиксации с камер выбранного участка.'}</p></div> : <div className="case-pages-grid">
      {filteredIncidents.map((incident) => {
        const album = albumFor(incident)
        const primaryPhoto = album.find((photo) => photo.isPrimary) || album[0]
        return <article key={incident.id} className={`case-pages-card ${highlightedIncidentId === incident.id ? 'case-pages-highlighted' : ''}`}>
          <button className="case-pages-card-image" onClick={() => openAlbum(incident)} aria-label={`Открыть альбом: ${incident.title}`}><EvidenceImage src={primaryPhoto?.url} alt={incident.title} /><span className="case-pages-photo-count"><Icon name="camera" size={14} />{album.length}</span></button>
          <div className="case-pages-card-body"><div className="case-pages-meta"><KindBadge incident={incident} /><span>{incidentDateTime(incident)}</span><span>{incident.id}</span></div><h2>{incident.title}</h2><p className="case-pages-note">{incident.note}</p><div className="case-pages-location">{[incident.zone, incident.camera].filter(Boolean).join(' · ')}</div>
            <div className="case-pages-card-status"><CaseStatus incident={incident} onChange={onStatusChange} />{incident.manual_override && <span className="case-pages-muted">Изменено вручную</span>}</div>
            <div className="case-pages-actions"><button className="button" onClick={() => openAlbum(incident)}>Открыть альбом<Icon name="arrow" size={15} /></button>{isDeviation(incident) && <IncidentCostButton incidentId={incident.uuid} title={incident.title} onOpenCase={() => onNavigateToReport(incident.id)} />}<details className="case-pages-menu"><summary aria-label={`Действия: ${incident.title}`}>···</summary><div><button onClick={() => { onNavigateToReport(incident.id); toast(`Запись ${incident.id} в отчёте`) }}>Открыть в отчёте</button></div></details></div>
          </div>
        </article>
      })}
    </div>}
    {selectedAlbumIncident && (() => {
      const album = albumFor(selectedAlbumIncident)
      const currentPhoto = album[activeAlbumPhotoIndex] || album[0]
      return <div className="modal-backdrop case-pages-album-overlay" onClick={() => setSelectedAlbumId(null)}><div className="case-pages-album" role="dialog" aria-modal="true" aria-label={selectedAlbumIncident.title} onClick={(e) => e.stopPropagation()}>
        <div className="case-pages-dialog-head"><div><div className="case-pages-meta"><KindBadge incident={selectedAlbumIncident} /><span>{selectedAlbumIncident.id}</span><span>{incidentDateTime(selectedAlbumIncident)}</span></div><h2>{selectedAlbumIncident.title}</h2><p>{selectedAlbumIncident.note}</p></div><button className="button" onClick={() => setSelectedAlbumId(null)} aria-label="Закрыть альбом"><Icon name="close" /></button></div>
        <div className="case-pages-album-tabs">{album.map((photo, index) => <button key={`${photo.url}-${index}`} className={`button ${index === activeAlbumPhotoIndex ? 'primary' : ''}`} onClick={() => setActiveAlbumPhotoIndex(index)}>{photo.cameraName || `Ракурс ${index + 1}`}{photo.isPrimary && <span className="case-pages-muted"> · Основной</span>}</button>)}</div>
        <button className="case-pages-album-main" onClick={() => currentPhoto?.url && setSelectedPhoto(currentPhoto.url)} aria-label="Открыть фото на весь экран"><EvidenceImage src={currentPhoto?.url} alt={currentPhoto?.cameraName || selectedAlbumIncident.title} contain /></button>
        {album.length > 1 && <div className="case-pages-thumbnails">{album.map((photo, index) => <button key={`${photo.url}-${index}`} className={index === activeAlbumPhotoIndex ? 'active' : ''} onClick={() => setActiveAlbumPhotoIndex(index)} aria-label={photo.cameraName || `Ракурс ${index + 1}`}><EvidenceImage src={photo.url} alt={photo.cameraName || `Ракурс ${index + 1}`} /></button>)}</div>}
        <div className="case-pages-dialog-footer"><span>В PDF включается основной ракурс.</span><button className="button" onClick={() => { onNavigateToReport(selectedAlbumIncident.id); setSelectedAlbumId(null); toast(`Запись ${selectedAlbumIncident.id} в отчёте`) }}>Открыть в отчёте<Icon name="arrow" size={16} /></button></div>
      </div></div>
    })()}
    {selectedPhoto && <PhotoViewer src={selectedPhoto} onClose={() => setSelectedPhoto(null)} />}
  </div>
}

export function Reports({
  onOpenCase,
  activeProject,
  incidents,
  highlightedIncidentId,
  onNavigateToArchive,
  onStatusChange,
  toast,
}: {
  activeProject?: ProjectItem
  incidents: Incident[]
  onOpenCase: (id: string) => void
  highlightedIncidentId?: string | null
  onNavigateToArchive: (incidentId: string) => void
  onStatusChange?: (incidentId: string, newStatus: IncidentStatus) => void
  toast: (s: string) => void
}) {
  const [filterKind, setFilterKind] = useState<KindFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [selectedPhoto, setSelectedPhoto] = useState<string | null>(null)

  // PDF Export Modal State
  const [isExportModalOpen, setIsExportModalOpen] = useState(false)
  const [exportPreset, setExportPreset] = useState<'shift' | '24h' | 'week' | 'all' | 'custom'>('all')
  const [exportStartDate, setExportStartDate] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 1)
    return d.toISOString().slice(0, 10)
  })
  const [exportEndDate, setExportEndDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [exportSeverity, setExportSeverity] = useState<'ALL' | 'ERROR' | 'WARNING'>('ALL')
  const [includePhotos, setIncludePhotos] = useState(true)
  const [includeSignatures, setIncludeSignatures] = useState(true)
  const [includeStats, setIncludeStats] = useState(true)
  const [selectedIncidentIds, setSelectedIncidentIds] = useState<string[]>([])

  useEffect(() => {
    if (!isExportModalOpen) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setIsExportModalOpen(false) }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [isExportModalOpen])

  const errorsCount = incidents.filter((incident) => incidentKind(incident) === 'error').length
  const warningsCount = incidents.filter((incident) => incidentKind(incident) === 'warning').length
  const infoCount = incidents.filter((incident) => incidentKind(incident) === 'info').length
  const openCount = incidents.filter((incident) => isDeviation(incident) && isOpenIncident(incident)).length
  const filteredIncidents = incidents.filter((incident) => matchesIncident(incident, filterKind, searchQuery))

  const exportRange = useMemo(() => {
    const now = new Date()
    if (exportPreset === 'all') return null
    if (exportPreset === 'custom') {
      return { start: new Date(`${exportStartDate}T00:00:00`), end: new Date(`${exportEndDate}T23:59:59.999`) }
    }
    if (exportPreset === 'shift') {
      const start = new Date(now)
      start.setHours(8, 0, 0, 0)
      const end = new Date(start)
      end.setHours(20, 0, 0, 0)
      return { start, end }
    }
    return { start: new Date(now.getTime() - (exportPreset === '24h' ? 1 : 7) * 24 * 60 * 60 * 1000), end: now }
  }, [exportPreset, exportStartDate, exportEndDate])
  const invalidExportRange = Boolean(exportRange && (!Number.isFinite(exportRange.start.getTime()) || !Number.isFinite(exportRange.end.getTime()) || exportRange.start > exportRange.end))
  const undatedCount = incidents.filter((incident) => !incident.createdAt || !Number.isFinite(Date.parse(incident.createdAt))).length
  const rangeMatchedIncidents = useMemo(() => incidents.filter((incident) => {
    const kind = incidentKind(incident)
    if (exportSeverity === 'ERROR' && kind !== 'error') return false
    if (exportSeverity === 'WARNING' && kind !== 'warning') return false
    if (invalidExportRange) return false
    if (!exportRange) return true
    const timestamp = incident.createdAt ? Date.parse(incident.createdAt) : NaN
    return Number.isFinite(timestamp) && timestamp >= exportRange.start.getTime() && timestamp <= exportRange.end.getTime()
  }), [incidents, exportSeverity, exportRange, invalidExportRange])

  useEffect(() => {
    setSelectedIncidentIds(rangeMatchedIncidents.map((incident) => incident.id))
  }, [rangeMatchedIncidents])

  const getRangeLabel = () => {
    if (!exportRange) return 'Все доступные записи'
    return `${exportRange.start.toLocaleString('ru-RU')} — ${exportRange.end.toLocaleString('ru-RU')}`
  }

  const buildReportHtml = (itemsToExport: Incident[]) => {
    const rangeLabel = getRangeLabel()
    const todayDate = new Date().toLocaleDateString('ru-RU')
    const todayTime = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    const actNumber = `СК-${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, '0')}/${String(new Date().getDate()).padStart(2, '0')}-${Math.floor(10 + Math.random() * 90)}`

    const errCount = itemsToExport.filter((incident) => incidentKind(incident) === 'error').length
    const warnCount = itemsToExport.filter((incident) => incidentKind(incident) === 'warning').length
    const confirmedCount = itemsToExport.filter((i) => i.status === 'Подтверждено').length

    const esc = (s?: string) =>
      (s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')

    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>Акт строительного контроля № ${esc(actNumber)}</title>
  <style>
    @page {
      size: A4 portrait;
      margin: 12mm 14mm 12mm 14mm;
    }
    *, *::before, *::after {
      box-sizing: border-box;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
      color: #0f172a;
      background: #ffffff;
      margin: 0;
      padding: 0;
      font-size: 10pt;
      line-height: 1.4;
    }
    .header-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 2px solid #0f172a;
      padding-bottom: 10px;
      margin-bottom: 12px;
    }
    .brand-wrap {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .brand-badge {
      width: 42px;
      height: 42px;
      background: #0f172a;
      color: #cf9d3d;
      font-weight: 900;
      font-size: 18px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 6px;
      border: 1.5px solid #cf9d3d;
    }
    .brand-text-title {
      font-size: 12pt;
      font-weight: 800;
      letter-spacing: 0.5px;
      color: #0f172a;
      text-transform: uppercase;
      margin: 0;
    }
    .brand-text-sub {
      font-size: 8pt;
      color: #64748b;
      margin: 2px 0 0;
      text-transform: uppercase;
      letter-spacing: 0.8px;
    }
    .header-right {
      text-align: right;
      font-size: 8pt;
      color: #475569;
      line-height: 1.35;
    }
    .act-title-section {
      text-align: center;
      margin: 14px 0 12px;
    }
    .act-title {
      font-size: 13.5pt;
      font-weight: 800;
      color: #0f172a;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      margin: 0 0 4px;
    }
    .act-sub {
      font-size: 9pt;
      color: #475569;
      margin: 0;
    }
    .meta-box {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 14px;
      font-size: 9pt;
    }
    .meta-box td {
      padding: 5px 8px;
      border: 1px solid #cbd5e1;
      vertical-align: middle;
    }
    .meta-lbl {
      background: #f8fafc;
      color: #475569;
      font-weight: 600;
      width: 24%;
    }
    .meta-val {
      color: #0f172a;
      font-weight: 500;
      width: 76%;
    }
    .stats-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin-bottom: 14px;
    }
    .stat-tile {
      background: #f8fafc;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      padding: 8px 10px;
      text-align: center;
    }
    .stat-tile-val {
      font-size: 15pt;
      font-weight: 800;
      line-height: 1.2;
    }
    .stat-tile-lbl {
      font-size: 7.5pt;
      color: #64748b;
      font-weight: 600;
      text-transform: uppercase;
      margin-top: 2px;
    }
    .sec-heading {
      font-size: 10pt;
      font-weight: 700;
      color: #0f172a;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      border-bottom: 1.5px solid #0f172a;
      padding-bottom: 3px;
      margin: 16px 0 8px;
    }
    .table-incidents {
      width: 100%;
      border-collapse: collapse;
      font-size: 8.5pt;
      margin-bottom: 14px;
    }
    .table-incidents th {
      background: #f1f5f9;
      color: #1e293b;
      font-weight: 700;
      text-align: left;
      padding: 6px 8px;
      border: 1px solid #cbd5e1;
      font-size: 7.5pt;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .table-incidents td {
      padding: 6px 8px;
      border: 1px solid #cbd5e1;
      vertical-align: top;
    }
    .row-inc {
      page-break-inside: avoid !important;
      break-inside: avoid !important;
    }
    .tag-err {
      display: inline-block;
      padding: 2px 5px;
      background: #fee2e2;
      color: #991b1b;
      border: 1px solid #f87171;
      border-radius: 3px;
      font-size: 7pt;
      font-weight: 800;
      text-transform: uppercase;
    }
    .tag-warn {
      display: inline-block;
      padding: 2px 5px;
      background: #fef3c7;
      color: #92400e;
      border: 1px solid #facc15;
      border-radius: 3px;
      font-size: 7pt;
      font-weight: 800;
      text-transform: uppercase;
    }
    .tag-info { display: inline-block; padding: 2px 5px; background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; border-radius: 3px; font-size: 7pt; }
    .tag-status {
      display: inline-block;
      padding: 2px 5px;
      background: #f1f5f9;
      color: #334155;
      border-radius: 3px;
      font-size: 7pt;
      font-weight: 600;
      margin-top: 3px;
    }
    .thumb-cell {
      width: 130px;
      text-align: center;
    }
    .thumb-wrap {
      width: 120px;
      height: 75px;
      border-radius: 4px;
      overflow: hidden;
      border: 1px solid #cbd5e1;
      background: #0f172a;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .thumb-wrap img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .thumb-empty {
      font-size: 7pt;
      color: #94a3b8;
      text-align: center;
      padding: 4px;
    }
    .signatures-section {
      page-break-inside: avoid !important;
      break-inside: avoid !important;
      margin-top: 22px;
      padding-top: 10px;
      border-top: 1.5px solid #0f172a;
    }
    .sig-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin-top: 10px;
    }
    .sig-col {
      font-size: 8pt;
      color: #1e293b;
    }
    .sig-line {
      margin-top: 32px;
      border-bottom: 1px solid #334155;
      display: flex;
      justify-content: space-between;
      font-size: 7pt;
      color: #64748b;
      padding-bottom: 2px;
    }
    .stamp-box {
      border: 1.5px dashed #94a3b8;
      border-radius: 6px;
      width: 70px;
      height: 70px;
      margin: 12px auto 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #94a3b8;
      font-size: 8pt;
      font-weight: 700;
    }
    .footer-note {
      margin-top: 18px;
      text-align: center;
      font-size: 7.5pt;
      color: #94a3b8;
      border-top: 1px solid #e2e8f0;
      padding-top: 6px;
    }
  </style>
</head>
<body>
  <div class="header-bar">
    <div class="brand-wrap">
      <div class="brand-badge">СК</div>
      <div>
        <div class="brand-text-title">СТРОЙ-КОНТРОЛЬ</div>
        <div class="brand-text-sub">Автоматизированная система строительного надзора</div>
      </div>
    </div>
    <div class="header-right">
      <strong>АКТ № ${esc(actNumber)}</strong><br>
      Дата: ${todayDate} ${todayTime}<br>
      Журнал мониторинга
    </div>
  </div>

  <div class="act-title-section">
    <h1 class="act-title">АКТ СТРОИТЕЛЬНОГО КОНТРОЛЯ И МОНИТОРИНГА СПЕЦТЕХНИКИ</h1>
    <p class="act-sub">Сводная ведомость соблюдения технологического регламента и присутствия спецтехники</p>
  </div>

  <table class="meta-box">
    <tr>
      <td class="meta-lbl">Объект строительства:</td>
      <td class="meta-val"><strong>${esc(activeProject?.name || 'Строительный объект')}</strong></td>
    </tr>
    <tr>
      <td class="meta-lbl">Адрес объекта:</td>
      <td class="meta-val">${esc(activeProject?.address || 'Не указан')}</td>
    </tr>
    <tr>
      <td class="meta-lbl">Контролируемый диапазон:</td>
      <td class="meta-val"><strong>${esc(rangeLabel)}</strong></td>
    </tr>
    <tr>
      <td class="meta-lbl">Текущий этап СМР:</td>
      <td class="meta-val">${esc([...new Set(itemsToExport.map((i) => i.stageName).filter(Boolean))].join('; ') || 'Не указан')}</td>
    </tr>
  </table>

  ${
    includeStats
      ? `
  <div class="stats-row">
    <div class="stat-tile">
      <div class="stat-tile-val">${itemsToExport.length}</div>
      <div class="stat-tile-lbl">Всего событий</div>
    </div>
    <div class="stat-tile">
      <div class="stat-tile-val" style="color: #b91c1c;">${errCount}</div>
      <div class="stat-tile-lbl">Ошибок</div>
    </div>
    <div class="stat-tile">
      <div class="stat-tile-val" style="color: #b45309;">${warnCount}</div>
      <div class="stat-tile-lbl">Предупреждений</div>
    </div>
    <div class="stat-tile">
      <div class="stat-tile-val" style="color: #047857;">${confirmedCount}</div>
      <div class="stat-tile-lbl">Подтверждено</div>
    </div>
  </div>
  `
      : ''
  }

  <div class="sec-heading">Журнал событий (${itemsToExport.length} записей)</div>

  <table class="table-incidents">
    <thead>
      <tr>
        <th style="width: 28px; text-align: center;">№</th>
        ${includePhotos ? '<th style="width: 125px; text-align: center;">Основной ракурс</th>' : ''}
        <th style="width: 130px;">Время / Камера</th>
        <th style="width: 125px;">Тип и статус</th>
        <th>Событие и наблюдение</th>
        <th style="width: 110px;">Ответственный</th>
      </tr>
    </thead>
    <tbody>
      ${itemsToExport
        .map((inc, idx) => {
          const kind = incidentKind(inc)

          const album = albumFor(inc)
          const photoSrc = (album.find((photo) => photo.isPrimary) || album[0])?.url || ''

          return `
      <tr class="row-inc">
        <td style="text-align: center; font-weight: 700; color: #64748b;">${idx + 1}</td>
        ${
          includePhotos
            ? `
        <td class="thumb-cell">
          <div class="thumb-wrap">
            ${
              photoSrc
                ? `<img src="${esc(photoSrc)}" alt="Основной ракурс" onerror="this.style.display='none'; this.nextElementSibling.style.display='block';"><div class="thumb-empty" style="display:none;">Фото недоступно</div>`
                : `<div class="thumb-empty">Фото отсутствует</div>`
            }
          </div>
        </td>`
            : ''
        }
        <td>
          <strong>${esc(inc.createdAt ? new Date(inc.createdAt).toLocaleString('ru-RU') : inc.time)}</strong><br>
          <span style="color: #475569;">${esc(inc.camera)}</span><br>
          <span style="color: #64748b; font-size: 7.5pt;">${esc(inc.zone)}</span>
        </td>
        <td>
          <span class="${kind === 'error' ? 'tag-err' : kind === 'warning' ? 'tag-warn' : 'tag-info'}">${kindLabels[kind]}</span><br>
          <span class="tag-status">${esc(inc.status)}</span>
          ${inc.stageName ? `<br><span style="color: #64748b; font-size: 7pt;">${esc(inc.stageName)}</span>` : ''}
        </td>
        <td>
          <strong style="color: #0f172a; font-size: 9pt;">${esc(inc.title)}</strong>
          <p style="margin: 4px 0 0; color: #334155; font-size: 8pt; line-height: 1.35;">${esc(inc.note)}</p>
        </td>
        <td style="color: #1e293b;">
          ${esc(inc.assignee)}
        </td>
      </tr>
      `
        })
        .join('')}
    </tbody>
  </table>

  ${
    includeSignatures
      ? `
  <div class="signatures-section">
    <strong style="font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.4px;">Комиссия строительного контроля:</strong>
    <div class="sig-grid">
      <div class="sig-col">
        <strong>Инженер строительного контроля:</strong><br>
        <div class="sig-line"><span>(подпись)</span><span>/ ________________ /</span></div>
      </div>
      <div class="sig-col">
        <strong>Представитель генподрядчика:</strong><br>
        <div class="sig-line"><span>(подпись)</span><span>/ ________________ /</span></div>
      </div>
      <div class="sig-col">
        <strong>Ответственный за механизацию:</strong><br>
        <div class="sig-line"><span>(подпись)</span><span>/ ________________ /</span></div>
      </div>
    </div>
    <div class="stamp-box">М.П.</div>
  </div>
  `
      : ''
  }

  <div class="footer-note">
    Документ сгенерирован системой автоматизированного строительного контроля «СТРОЙ-КОНТРОЛЬ» · Дата формирования: ${todayDate} ${todayTime}
  </div>
</body>
</html>`
  }

  const handlePrintPdf = () => {
    const finalIncidents = incidents.filter((i) => selectedIncidentIds.includes(i.id))
    if (finalIncidents.length === 0) {
      toast('Не выбрано ни одной записи для включения в отчет')
      return
    }

    const htmlContent = buildReportHtml(finalIncidents)
    const iframe = document.createElement('iframe')
    iframe.style.position = 'fixed'
    iframe.style.right = '0'
    iframe.style.bottom = '0'
    iframe.style.width = '0'
    iframe.style.height = '0'
    iframe.style.border = '0'
    document.body.appendChild(iframe)

    const doc = iframe.contentWindow?.document
    if (!doc) {
      iframe.remove()
      toast('Ошибка инициализации печати')
      return
    }

    doc.open()
    doc.write(htmlContent)
    doc.close()

    const triggerPrint = () => {
      try {
        iframe.contentWindow?.focus()
        iframe.contentWindow?.print()
        toast('Диалог сохранения отчета в PDF запущен')
      } catch (e) {
        console.error('Print trigger error', e)
        toast('Ошибка вызова диалога печати')
      } finally {
        setTimeout(() => {
          if (document.body.contains(iframe)) {
            document.body.removeChild(iframe)
          }
        }, 3000)
      }
    }

    const imgs = Array.from(doc.images)
    if (imgs.length === 0) {
      setTimeout(triggerPrint, 300)
    } else {
      let loaded = 0
      let done = false
      const onImgDone = () => {
        loaded++
        if (loaded >= imgs.length && !done) {
          done = true
          setTimeout(triggerPrint, 350)
        }
      }
      imgs.forEach((img) => {
        if (img.complete) {
          onImgDone()
        } else {
          img.addEventListener('load', onImgDone, { once: true })
          img.addEventListener('error', onImgDone, { once: true })
        }
      })
      setTimeout(() => {
        if (!done) {
          done = true
          triggerPrint()
        }
      }, 2500)
    }

    setIsExportModalOpen(false)
  }

  const handleOpenInNewTab = () => {
    const finalIncidents = incidents.filter((i) => selectedIncidentIds.includes(i.id))
    if (finalIncidents.length === 0) {
      toast('Не выбрано ни одной записи для включения в отчет')
      return
    }
    const htmlContent = buildReportHtml(finalIncidents)
    const win = window.open('', '_blank')
    if (win) {
      win.document.open()
      win.document.write(htmlContent)
      win.document.close()
      setTimeout(() => {
        win.focus()
        win.print()
      }, 400)
    } else {
      toast('Браузер заблокировал новую вкладку. Используйте кнопку печати PDF.')
    }
  }

  return <div className="case-pages case-pages-reports">
    <div className="case-pages-journal-head"><div className="case-pages-summary"><span><strong>{incidents.length}</strong> событий</span><span><i className="case-pages-dot error" /><strong>{errorsCount}</strong> ошибок</span><span><i className="case-pages-dot warning" /><strong>{warningsCount}</strong> предупреждений</span><span><strong>{infoCount}</strong> информационных</span><span><strong>{openCount}</strong> открыто</span></div><button className="button" onClick={() => setIsExportModalOpen(true)}><Icon name="download" size={17} />Экспорт PDF</button></div>
    <CaseFilters query={searchQuery} onQuery={setSearchQuery} kind={filterKind} onKind={setFilterKind} />
    <div className="case-pages-caption"><span>Журнал событий · {filteredIncidents.length}</span>{activeProject?.name && <span>{activeProject.name}</span>}</div>
    {filteredIncidents.length === 0 ? <div className="case-pages-empty panel"><Icon name="file" size={28} /><h2>{incidents.length ? 'Записи не найдены' : 'В журнале пока нет событий'}</h2><p>{incidents.length ? 'Измените поисковый запрос или тип события.' : 'Здесь появятся события мониторинга выбранного участка.'}</p></div> : <div className="case-pages-journal panel">{filteredIncidents.map((incident) => {
      const photo = albumFor(incident).find((item) => item.isPrimary) || albumFor(incident)[0]
      return <article key={incident.id} id={`report-item-${incident.id}`} tabIndex={-1} className={`case-pages-journal-row ${highlightedIncidentId === incident.id ? 'case-pages-highlighted' : ''}`}>
        <div className="case-pages-row-time"><span>{incidentDateTime(incident)}</span><small>{incident.id}</small></div>
        {photo ? <button className="case-pages-row-image" onClick={() => setSelectedPhoto(photo.url)} aria-label={`Фото: ${incident.title}`}><EvidenceImage src={photo.url} alt={incident.title} /></button> : <div className="case-pages-row-image case-pages-no-evidence"><Icon name={isDeviation(incident) ? 'camera' : 'video'} size={22} /><span>{isDeviation(incident) ? 'Без фото' : 'Связь'}</span></div>}
        <div className="case-pages-row-content"><div className="case-pages-meta"><KindBadge incident={incident} />{incident.stageName && <span>{incident.stageName}</span>}</div><h2><button onClick={() => onOpenCase(incident.uuid || incident.id)}>{incident.title}</button></h2><p className="case-pages-note">{incident.note}</p><div className="case-pages-location">{[incident.zone, incident.camera, incident.assignee].filter(Boolean).join(' · ')}</div></div>
        <div className="case-pages-row-actions"><CaseStatus incident={incident} onChange={onStatusChange} /><div className="case-pages-actions">{isDeviation(incident) && <IncidentCostButton incidentId={incident.uuid} title={incident.title} onOpenCase={() => onOpenCase(incident.uuid || incident.id)} />}<details className="case-pages-menu"><summary aria-label={`Действия: ${incident.title}`}>···</summary><div><button onClick={() => onOpenCase(incident.uuid || incident.id)}>Открыть случай</button>{photo && <button onClick={() => { onNavigateToArchive(incident.id); toast(`Альбом ${incident.id} в фотоархиве`) }}>Открыть альбом</button>}</div></details></div>{incident.manual_override && <span className="case-pages-muted">Изменено вручную</span>}</div>
      </article>
    })}</div>}
    {selectedPhoto && <PhotoViewer src={selectedPhoto} onClose={() => setSelectedPhoto(null)} />}
    {isExportModalOpen && <div className="modal-backdrop case-pages-export-overlay" onClick={() => setIsExportModalOpen(false)}><div className="case-pages-export" role="dialog" aria-modal="true" aria-labelledby="case-pages-export-title" onClick={(event) => event.stopPropagation()}>
      <div className="case-pages-dialog-head"><div><h2 id="case-pages-export-title">Экспорт отчёта</h2><p>Выберите период и записи для печатной формы.</p></div><button className="button" onClick={() => setIsExportModalOpen(false)} aria-label="Закрыть параметры экспорта"><Icon name="close" /></button></div>
      <fieldset className="case-pages-export-section"><legend>Период</legend><div className="case-pages-presets">{[
        { id: 'shift' as const, label: 'Сегодня, 08:00–20:00' },
        { id: '24h' as const, label: 'Последние 24 часа' },
        { id: 'week' as const, label: 'Последние 7 дней' },
        { id: 'all' as const, label: 'Весь период' },
        { id: 'custom' as const, label: 'Указать даты' },
      ].map((preset) => <button key={preset.id} className={`button ${exportPreset === preset.id ? 'primary' : ''}`} onClick={() => setExportPreset(preset.id)} aria-pressed={exportPreset === preset.id}>{preset.label}</button>)}</div>
      {exportPreset === 'custom' && <div className="case-pages-date-range"><label>С даты<input type="date" value={exportStartDate} onChange={(event) => setExportStartDate(event.target.value)} /></label><label>По дату<input type="date" value={exportEndDate} onChange={(event) => setExportEndDate(event.target.value)} /></label></div>}
      {invalidExportRange && <p className="case-pages-validation" role="alert">Укажите корректный период: дата начала должна быть не позже даты окончания.</p>}
      {exportRange && undatedCount > 0 && <p className="case-pages-muted">Записи без даты события ({undatedCount}) доступны при выборе всего периода.</p>}
      </fieldset>
      <fieldset className="case-pages-export-section"><legend>Тип событий</legend><div className="case-pages-presets"><button className={`button ${exportSeverity === 'ALL' ? 'primary' : ''}`} onClick={() => setExportSeverity('ALL')}>Все ({incidents.length})</button><button className={`button ${exportSeverity === 'ERROR' ? 'primary' : ''}`} onClick={() => setExportSeverity('ERROR')}>Ошибки ({errorsCount})</button><button className={`button ${exportSeverity === 'WARNING' ? 'primary' : ''}`} onClick={() => setExportSeverity('WARNING')}>Предупреждения ({warningsCount})</button></div></fieldset>
      <fieldset className="case-pages-export-section"><legend>Состав документа</legend><div className="case-pages-export-options"><label><input type="checkbox" checked={includePhotos} onChange={(event) => setIncludePhotos(event.target.checked)} />Основной ракурс</label><label><input type="checkbox" checked={includeStats} onChange={(event) => setIncludeStats(event.target.checked)} />Сводные показатели</label><label><input type="checkbox" checked={includeSignatures} onChange={(event) => setIncludeSignatures(event.target.checked)} />Поля для подписей</label></div></fieldset>
      <section className="case-pages-export-section"><div className="case-pages-export-selection"><strong>Записи: {selectedIncidentIds.length} из {rangeMatchedIncidents.length}</strong><button className="button" onClick={() => setSelectedIncidentIds(selectedIncidentIds.length === rangeMatchedIncidents.length ? [] : rangeMatchedIncidents.map((incident) => incident.id))}>{selectedIncidentIds.length === rangeMatchedIncidents.length ? 'Снять все' : 'Выбрать все'}</button></div><div className="case-pages-export-records">{rangeMatchedIncidents.length ? rangeMatchedIncidents.map((incident) => <label key={incident.id}><input type="checkbox" checked={selectedIncidentIds.includes(incident.id)} onChange={(event) => setSelectedIncidentIds((previous) => event.target.checked ? [...previous, incident.id] : previous.filter((id) => id !== incident.id))} /><KindBadge incident={incident} /><span>{incident.title}</span><small>{incidentDateTime(incident)}</small></label>) : <p className="case-pages-muted">За выбранный период записей нет.</p>}</div></section>
      <div className="case-pages-dialog-footer"><button className="button" onClick={handleOpenInNewTab} disabled={selectedIncidentIds.length === 0}>Печатная форма<Icon name="link" size={15} /></button><div className="case-pages-actions"><button className="button" onClick={() => setIsExportModalOpen(false)}>Отмена</button><button className="button primary" onClick={handlePrintPdf} disabled={selectedIncidentIds.length === 0}><Icon name="download" size={16} />Печать / сохранить PDF</button></div></div>
    </div></div>}
  </div>
}
