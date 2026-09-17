import { useMemo, useState } from 'react'
import {
  activities,
  analytics,
  archiveResults,
  cameras,
  detections,
  evidenceCases,
  incidentsSeed,
  mockApi,
  projects,
  team,
  zones,
  type Incident,
  type IncidentStatus,
  type PageKey,
} from './data'
import cameraImage from './assets/construction-camera.png'

const nav: { id: PageKey; label: string; icon: string }[] = [
  { id: 'overview', label: 'Обзор', icon: 'grid' },
  { id: 'monitoring', label: 'Наблюдение', icon: 'video' },
  { id: 'space', label: 'Пространство', icon: 'layers' },
  { id: 'incidents', label: 'Инциденты', icon: 'alert' },
  { id: 'cases', label: 'Кейсы', icon: 'eye' },
  { id: 'archive', label: 'Видеоархив', icon: 'archive' },
  { id: 'progress', label: 'Прогресс', icon: 'progress' },
  { id: 'analytics', label: 'Аналитика', icon: 'chart' },
  { id: 'reports', label: 'Отчёты', icon: 'file' },
  { id: 'settings', label: 'Настройки', icon: 'settings' },
]

const titles: Record<PageKey, [string, string]> = {
  overview: ['Обзор', 'Состояние объекта и задачи, требующие решения'],
  monitoring: ['Наблюдение', 'Камеры, детекции и визуальные доказательства'],
  space: ['Пространство', 'Связь зон, камер, техники и работ'],
  incidents: ['Инциденты', 'Проверка, назначение и контроль устранения'],
  cases: ['Кейсы', 'Фотодоказательства для оценки качества распознавания'],
  archive: ['Видеоархив', 'Поиск событий по камерам и времени'],
  progress: ['Прогресс', 'Визуально подтверждаемые этапы работ'],
  analytics: ['Аналитика', 'Динамика подтверждённых наблюдений'],
  reports: ['Отчёты', 'Проверяемая сводка за смену'],
  settings: ['Настройки', 'Проекты, камеры, правила и уведомления'],
}

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, React.JSX.Element> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
    video: <><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/></>,
    layers: <><path d="m12 2 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/></>,
    alert: <><path d="M10.3 3.3 2.5 17a2 2 0 0 0 1.8 3h15.4a2 2 0 0 0 1.8-3L13.7 3.3a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></>,
    archive: <><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v12h14V8M10 12h4"/></>,
    progress: <><path d="M4 19V9M10 19V5M16 19v-7M22 19V2"/></>,
    chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></>,
    file: <><path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h8M9 17h8"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/></>,
    search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>,
    bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    check: <path d="m5 12 4 4L19 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    user: <><circle cx="12" cy="8" r="4"/><path d="M4 22c.5-5 3-7 8-7s7.5 2 8 7"/></>,
    eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/></>,
    arrow: <path d="M5 12h14m-5-5 5 5-5 5"/>,
    filter: <path d="M3 5h18l-7 8v6l-4 2v-8z"/>,
    menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5"/><path d="M4 21h16"/></>,
    link: <><path d="M10 13a5 5 0 0 0 7.5.5l2-2a5 5 0 0 0-7-7l-1.2 1.2"/><path d="M14 11a5 5 0 0 0-7.5-.5l-2 2a5 5 0 0 0 7 7l1.2-1.2"/></>,
  }
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name] ?? paths.grid}</svg>
}

function Status({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: string }) {
  return <span className={`status status-${tone}`}><span className="status-dot" />{children}</span>
}

function statusTone(status: IncidentStatus) {
  return status === 'Устранено' ? 'success' : status === 'Ложное срабатывание' ? 'neutral' : status === 'В работе' ? 'info' : status === 'Подтверждено' ? 'warning' : 'critical'
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><div className="empty-icon"><Icon name="search" /></div><h3>{title}</h3><p>{text}</p></div>
}

function CameraFrame({ boxes = true, compact = false }: { boxes?: boolean; compact?: boolean }) {
  return <div className={`camera-frame ${compact ? 'compact-frame' : ''}`}>
    <img src={cameraImage} alt="Кадр с камеры: котлован, экскаватор и самосвал" />
    {boxes && <>
      <div className="detection-box box-excavator"><span>Экскаватор · 96%</span></div>
      <div className="detection-box box-truck"><span>Самосвал · 92%</span></div>
      <div className="detection-box box-person"><span>Человек · 89%</span></div>
    </>}
    <div className="frame-meta"><span>CAM-03</span><span>16.09.2026 · 14:39:52</span></div>
  </div>
}

function EvidencePanel({ incident, onClose, updateIncident, toast }: { incident: Incident; onClose?: () => void; updateIncident: (id: string, patch: Partial<Incident>) => void; toast: (s: string) => void }) {
  const [assignOpen, setAssignOpen] = useState(false)
  const [rejectOpen, setRejectOpen] = useState(false)
  return <aside className="evidence-panel">
    <div className="evidence-head">
      <div><span className="eyebrow">{incident.id} · {incident.type}</span><h2>{incident.title}</h2></div>
      {onClose && <button className="icon-button" aria-label="Закрыть панель" onClick={onClose}><Icon name="close" /></button>}
    </div>
    <div className="evidence-tags"><span className="incident-category">{incident.type}</span><Status tone={statusTone(incident.status)}>{incident.status}</Status></div>
    <CameraFrame compact boxes={incident.type !== 'Камера'} />
    <div className="confidence-row"><span>Уверенность наблюдения</span><strong>{incident.confidence}%</strong><div className="meter"><i style={{ width: `${incident.confidence}%` }} /></div></div>
    <div className="fact-grid">
      <div><span>Зона</span><strong>{incident.zone}</strong></div><div><span>Камера</span><strong>{incident.camera}</strong></div>
      <div><span>Время</span><strong>{incident.time}</strong></div><div><span>Ответственный</span><strong>{incident.assignee}</strong></div>
    </div>
    <section className="explanation"><span className="section-kicker">Объяснение</span><p>{incident.note}</p>{incident.id === 'INC-247' && <div className="limitation"><Icon name="eye" /><span>Камера видит около 72% рабочей области. Отсутствие техники нельзя подтвердить автоматически.</span></div>}</section>
    <section className="history"><span className="section-kicker">История</span><div><i /><span>Событие объединено из {incident.grouped ?? 1} наблюдений</span><time>{incident.time}</time></div><div><i /><span>Правило выполнило первичную проверку</span><time>+1 мин</time></div></section>
    <div className="evidence-actions">
      {incident.status === 'Требует проверки' && <button className="button primary" onClick={() => updateIncident(incident.id, { status: 'Подтверждено' })}><Icon name="check" />Подтвердить</button>}
      {incident.status === 'Подтверждено' && <button className="button primary" onClick={() => updateIncident(incident.id, { status: 'В работе' })}>Взять в работу</button>}
      {incident.status === 'В работе' && <button className="button primary" onClick={() => updateIncident(incident.id, { status: 'Устранено' })}><Icon name="check" />Отметить устранённым</button>}
      <button className="button" onClick={() => setAssignOpen(!assignOpen)}><Icon name="user" />Назначить</button>
      {incident.id === 'INC-247' && <button className="button full" onClick={() => toast('Запрос на дополнительный ракурс отправлен оператору')}>Запросить другой ракурс</button>}
      <button className="text-button" onClick={() => setRejectOpen(true)}>Отклонить наблюдение</button>
    </div>
    {assignOpen && <div className="popover"><span className="section-kicker">Назначить ответственного</span>{team.map(person => <button key={person} onClick={() => { updateIncident(incident.id, { assignee: person }); setAssignOpen(false) }}>{person}<Icon name="arrow" /></button>)}</div>}
    {rejectOpen && <div className="modal-backdrop"><div className="dialog" role="dialog" aria-modal="true" aria-labelledby="reject-title"><h3 id="reject-title">Причина отклонения</h3><p>Выберите причину — она будет сохранена в истории.</p>{['Низкое качество кадра', 'Объект определён неверно', 'Событие не является нарушением'].map(reason => <button className="reason" key={reason} onClick={() => { updateIncident(incident.id, { status: 'Ложное срабатывание', note: reason }); setRejectOpen(false) }}>{reason}</button>)}<button className="button full" onClick={() => setRejectOpen(false)}>Отмена</button></div></div>}
  </aside>
}

function Overview({ incidents, openIncident, navigate }: { incidents: Incident[]; openIncident: (i: Incident) => void; navigate: (p: PageKey) => void }) {
  const attention = incidents.filter(i => !['Устранено', 'Ложное срабатывание'].includes(i.status)).slice(0, 4)
  return <div className="overview-page">
    <section className="object-heading"><div><span className="eyebrow">СТРОИТЕЛЬНЫЙ ОБЪЕКТ</span><h1>{projects[0].name}</h1><p>{projects[0].address} · {projects[0].stage}</p></div><div className="updated"><span className="live-dot" />Данные актуальны · 14:40</div></section>
    <section className="metric-strip" aria-label="Основные показатели">
      {[['Камеры онлайн','4 / 5','1 требует внимания'],['На проверке',String(incidents.filter(i => i.status === 'Требует проверки').length),'2 новых за час'],['Подтверждено',String(incidents.filter(i => i.status === 'Подтверждено').length),'ожидают реакции'],['Просрочено','3','по SLA реакции'],['Активные работы','3 / 6','текущая смена']].map(([label,value,note], idx) => <div key={label} className={idx === 3 ? 'metric-alert' : ''}><span>{label}</span><strong>{value}</strong><small>{note}</small></div>)}
    </section>
    <div className="overview-grid">
      <section className="panel site-panel"><div className="panel-head"><div><span className="section-kicker">ПЛАН ПЛОЩАДКИ</span><h2>Зоны и события</h2></div><div className="segmented"><button className="active">2D</button><button onClick={() => navigate('space')}>3D</button></div></div><SiteMap onSelect={(id) => id === 'C-02' ? openIncident(incidents[0]) : id === 'A-03' ? openIncident(incidents[1]) : navigate('space')} /><div className="map-legend"><span><i className="legend-camera" />Камера</span><span><i className="legend-incident" />Инцидент</span><span><i className="legend-zone" />Активная зона</span></div></section>
      <section className="panel attention-panel"><div className="panel-head"><div><span className="section-kicker">ОЧЕРЕДЬ</span><h2>Требует внимания</h2></div><button className="text-button" onClick={() => navigate('incidents')}>Все {attention.length + 2}</button></div><div className="attention-list">{attention.map(i => <button key={i.id} onClick={() => openIncident(i)}><div className="attention-top"><span className="incident-category">{i.type}</span><time>{i.age}</time></div><strong>{i.title}</strong><span>{i.zone} · {i.assignee}</span><div className="attention-foot"><small><Icon name="clock" size={13} /> {i.sla.includes('Просрочено') ? i.sla : `${i.sla} до SLA`}</small><Icon name="chevron" /></div></button>)}</div></section>
    </div>
    <div className="lower-grid"><section className="panel"><div className="panel-head"><div><span className="section-kicker">СМЕНА 08:00–20:00</span><h2>Активные работы</h2></div><button className="text-button" onClick={() => navigate('progress')}>Открыть план</button></div><div className="activity-table">{activities.map(a => <div key={a.zone}><span className="zone-code">{a.zone}</span><div><strong>{a.name}</strong><small>{a.time} · {a.planned}</small></div><Status tone={a.status === 'Требует проверки' ? 'warning' : 'success'}>{a.status}</Status></div>)}</div></section><section className="panel compact-insights"><div className="panel-head"><div><span className="section-kicker">КАЧЕСТВО НАБЛЮДЕНИЯ</span><h2>Ограничения камер</h2></div></div><div className="quality-row"><div><strong>CAM-02 · Корпус, восток</strong><span>Обзор перекрыт материалами</span></div><b>48%</b></div><div className="quality-row"><div><strong>CAM-09 · Склад, запад</strong><span>Нет связи 2 ч 14 мин</span></div><Status tone="critical">Вне сети</Status></div><MiniTrend /></section></div>
  </div>
}

function SiteMap({ onSelect, selected }: { onSelect: (id: string) => void; selected?: string }) {
  return <div className="site-map" role="img" aria-label="Схема строительной площадки с четырьмя зонами">
    <div className="site-grid" />
    {zones.map(z => <button key={z.id} className={`zone-block zone-${z.risk} ${selected === z.id ? 'selected' : ''}`} style={{ left: `${z.x}%`, top: `${z.y}%`, width: `${z.w}%`, height: `${z.h}%` }} onClick={() => onSelect(z.id)}><span>{z.id}</span><strong>{z.name}</strong><small>{z.work}</small></button>)}
    <button className="camera-pin pin-1" aria-label="Камера CAM-03" onClick={() => onSelect('A-03')}><Icon name="video" size={15} /></button><button className="camera-pin pin-2" aria-label="Камера CAM-02" onClick={() => onSelect('C-02')}><Icon name="video" size={15} /></button>
    <span className="incident-pin incident-1">2</span><span className="incident-pin incident-2">1</span>
    <div className="building b1" /><div className="building b2" /><div className="road" />
  </div>
}

function MiniTrend() {
  return <div className="mini-trend"><div><span>Инциденты за 7 дней</span><strong>−18%</strong></div><svg viewBox="0 0 260 55" preserveAspectRatio="none"><path d="M2 12 L44 22 L86 16 L128 36 L170 29 L212 39 L258 43" /></svg><div className="week-labels"><span>10 сен</span><span>Сегодня</span></div></div>
}

function Monitoring({ incidents, openIncident, toast }: { incidents: Incident[]; openIncident: (i: Incident) => void; toast: (s: string) => void }) {
  const [cameraId, setCameraId] = useState('CAM-03')
  const [mode, setMode] = useState('Техника')
  const [boxes, setBoxes] = useState(true)
  const camera = cameras.find(c => c.id === cameraId)!
  return <div className="monitor-layout">
    <aside className="camera-list panel"><div className="camera-list-head"><span className="section-kicker">ОБЪЕКТ И КАМЕРЫ</span><h3>ЖК «Северный»</h3></div>{cameras.map(c => <button key={c.id} className={c.id === cameraId ? 'active' : ''} onClick={() => setCameraId(c.id)}><span className={`camera-status ${c.status}`} /><div><strong>{c.id} · {c.name}</strong><small>{c.zone}</small></div><span className="camera-fresh">{c.status === 'offline' ? 'Нет связи' : c.freshness}</span></button>)}</aside>
    <main className="monitor-main"><section className="panel viewer"><div className="viewer-head"><div><div className="viewer-title"><h2>{camera.id} · {camera.name}</h2><Status tone={camera.status === 'online' ? 'success' : camera.status === 'offline' ? 'critical' : 'warning'}>{camera.status === 'online' ? 'В эфире' : camera.status === 'offline' ? 'Вне сети' : 'Ограничено'}</Status></div><p>{camera.zone} · Кадр {camera.freshness}</p></div><div className="viewer-actions"><label className="switch"><input type="checkbox" checked={boxes} onChange={e => setBoxes(e.target.checked)} /><span />Рамки</label><button className="button" onClick={() => toast('Переход к архиву: CAM-03 · 14:39')}><Icon name="archive" />В архив</button></div></div>{camera.status === 'offline' ? <EmptyState title="Камера вне сети" text="Последний кадр получен 2 ч 14 мин назад. Проверьте питание или канал связи." /> : <CameraFrame boxes={boxes} />}{camera.status === 'degraded' && <div className="inline-warning"><Icon name="alert" />Кадр устарел, видимость 48%. Автоматические выводы требуют ручной проверки.</div>}<div className="analysis-tabs" role="tablist">{['Люди','Техника','СИЗ','Опасные зоны','Прогресс'].map(m => <button role="tab" aria-selected={mode === m} className={mode === m ? 'active' : ''} key={m} onClick={() => setMode(m)}>{m}</button>)}</div><Timeline /></section>
      <section className="panel detections"><div className="panel-head"><div><span className="section-kicker">14:39:40–14:40:00</span><h2>Найденные объекты · {mode}</h2></div><span className="muted">4 наблюдения</span></div><div className="detection-list">{detections.map(d => <button key={d.label}><div><strong>{d.label}</strong><small>{d.time}</small></div><span className={`confidence ${d.confidence < 70 ? 'low' : ''}`}>{d.confidence}%</span><Icon name="chevron" /></button>)}</div></section>
    </main>
    <aside className="context-panel panel"><div className="panel-head"><div><span className="section-kicker">КОНТЕКСТ</span><h2>A-03 · Котлован</h2></div></div><div className="context-work"><span>Активная работа</span><strong>Разработка грунта</strong><small>08:00–17:00 · по плану</small></div><div className="comparison"><div><span>Ожидается</span><strong>Экскаватор · 1</strong></div><div><span>Найдено</span><strong>Самосвал · 2</strong></div></div><div className="limitation"><Icon name="eye" /><span>72% рабочей зоны доступно для наблюдения. Западный сектор перекрыт.</span></div><button className="button primary full" onClick={() => openIncident(incidents[1])}>Открыть событие</button><button className="button full" onClick={() => toast('Создан черновик инцидента из текущего наблюдения')}>Создать инцидент</button></aside>
  </div>
}

function Timeline() {
  return <div className="timeline"><div className="timeline-labels"><span>14:30</span><span>14:35</span><span>14:40</span></div><div className="timeline-track"><i className="track-fill" /><button aria-label="Текущий кадр в 14:39" /><span className="event-mark m1"/><span className="event-mark m2"/><span className="event-mark m3"/></div></div>
}

function Space({ incidents, openIncident, toast }: { incidents: Incident[]; openIncident: (i: Incident) => void; toast: (s: string) => void }) {
  const [selected, setSelected] = useState('A-03')
  const [mode, setMode] = useState('Наблюдение')
  const [is3d, setIs3d] = useState(true)
  const [layers, setLayers] = useState(['Камеры','Работы','Инциденты'])
  const zone = zones.find(z => z.id === selected)!
  const toggleLayer = (l: string) => setLayers(p => p.includes(l) ? p.filter(x => x !== l) : [...p,l])
  return <div className="space-layout"><aside className="panel layer-panel"><span className="section-kicker">СЛОИ</span>{['Камеры','Работы','Техника','Инциденты','Тепловая карта'].map(l => <label key={l}><input type="checkbox" checked={layers.includes(l)} onChange={() => toggleLayer(l)} /><span>{l}</span></label>)}<hr/><span className="section-kicker">ЗОНЫ</span>{zones.map(z => <button className={selected === z.id ? 'active' : ''} key={z.id} onClick={() => setSelected(z.id)}><span className={`zone-swatch zone-${z.risk}`} />{z.id} · {z.name}<small>{z.work}</small></button>)}</aside><main className="space-canvas panel"><div className="space-toolbar"><div className="segmented">{['Наблюдение','Сравнение','Расследование'].map(m => <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>{m}</button>)}</div><div className="segmented"><button className={!is3d ? 'active' : ''} onClick={() => setIs3d(false)}>2D</button><button className={is3d ? 'active' : ''} onClick={() => setIs3d(true)}>3D</button></div></div><div className={`spatial-scene ${is3d ? 'scene-3d' : ''}`}><div className="scene-ground" /><div className="scene-building building-main"><i/><i/><i/><i/></div><div className="scene-building building-side"><i/><i/></div><div className="scene-pit"/><div className="scene-road"/><button className={`scene-zone z-a ${selected === 'A-03' ? 'selected' : ''}`} onClick={() => setSelected('A-03')}><span>A-03</span></button><button className={`scene-zone z-b ${selected === 'B-01' ? 'selected' : ''}`} onClick={() => setSelected('B-01')}><span>B-01</span></button><button className={`scene-zone z-c ${selected === 'C-02' ? 'selected' : ''}`} onClick={() => setSelected('C-02')}><span>C-02</span></button>{layers.includes('Камеры') && <><button className="scene-camera sc1" aria-label="Выбрать камеру CAM-03" onClick={() => toast('CAM-03 выбрана: сектор обзора показан')}><Icon name="video" size={15}/></button><div className="camera-cone"/></>}{layers.includes('Инциденты') && <button className="scene-incident" onClick={() => openIncident(incidents[2])}><Icon name="alert" size={15}/>2</button>}<div className="scene-label"><span>{selected}</span><strong>{zone.name}</strong><small>{zone.work}</small></div></div><div className="space-timeline"><button aria-label="Предыдущий момент">‹</button><div><span>08:00</span><span>10:00</span><span>12:00</span><span>14:40</span><span>17:00</span><i style={{left:'71%'}} /></div><button aria-label="Следующий момент">›</button></div></main><aside className="panel space-evidence"><span className="section-kicker">ДОКАЗАТЕЛЬНАЯ ПАНЕЛЬ</span><h2>{zone.id} · {zone.name}</h2><Status tone={zone.risk === 'critical' ? 'critical' : zone.risk === 'attention' ? 'warning' : 'success'}>{zone.risk === 'critical' ? 'Есть инцидент' : zone.risk === 'attention' ? 'Требует проверки' : 'Без отклонений'}</Status><CameraFrame compact boxes={false}/><div className="fact-grid"><div><span>Работа</span><strong>{zone.work}</strong></div><div><span>Качество обзора</span><strong>{selected === 'A-03' ? '72%' : '86%'}</strong></div><div><span>Камера</span><strong>{selected === 'A-03' ? 'CAM-03' : 'CAM-02'}</strong></div><div><span>Кадр</span><strong>8 сек назад</strong></div></div>{selected === 'A-03' && <div className="explanation"><span className="section-kicker">ВЫВОД</span><p>По плану требуется минимум один экскаватор. В трёх наблюдениях он не найден, но камера видит только 72% зоны. Требуется дополнительный ракурс.</p></div>}<button className="button primary full" onClick={() => selected === 'A-03' ? openIncident(incidents[1]) : toast('Перешли к выбранной камере')}>Открыть доказательство</button></aside></div>
}

function Incidents({ incidents, selected, setSelected, updateIncident, toast }: { incidents: Incident[]; selected: Incident | null; setSelected: (i: Incident | null) => void; updateIncident: (id: string, patch: Partial<Incident>) => void; toast: (s: string) => void }) {
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('Все статусы')
  const filtered = incidents.filter(i => (filter === 'Все статусы' || i.status === filter) && `${i.id} ${i.title} ${i.zone}`.toLowerCase().includes(query.toLowerCase()))
  return <div className={`incidents-page ${selected ? 'has-detail' : ''}`}><section className="incident-workspace panel"><div className="table-toolbar"><label className="search-field"><Icon name="search"/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Поиск по событию, зоне или ID" aria-label="Поиск инцидентов"/></label><select value={filter} onChange={e => setFilter(e.target.value)} aria-label="Фильтр по статусу"><option>Все статусы</option>{['Требует проверки','Подтверждено','В работе','Устранено','Ложное срабатывание'].map(s => <option key={s}>{s}</option>)}</select><button className="button"><Icon name="filter"/>Фильтры</button></div><div className="table-summary"><strong>{filtered.length} событий</strong><span>Сначала события с истекающим SLA</span></div>{filtered.length === 0 ? <EmptyState title="Ничего не найдено" text="Измените запрос или сбросьте фильтр статуса."/> : <div className="incident-table" role="table"><div className="table-row table-head" role="row"><span>Категория</span><span>Событие</span><span>Зона / камера</span><span>Время</span><span>Ответственный</span><span>Статус</span><span>SLA</span></div>{filtered.map(i => <button role="row" className={`table-row ${selected?.id === i.id ? 'selected' : ''}`} key={i.id} onClick={() => setSelected(i)}><span className="incident-category">{i.type}</span><span><strong>{i.title}</strong><small>{i.id}{i.grouped ? ` · ${i.grouped} детекции` : ''}</small></span><span>{i.zone}<small>{i.camera}</small></span><span>{i.time}<small>{i.age}</small></span><span>{i.assignee}</span><span><Status tone={statusTone(i.status)}>{i.status}</Status></span><span className={i.sla.includes('Просрочено') ? 'overdue' : ''}>{i.sla}</span></button>)}</div>}</section>{selected && <EvidencePanel incident={incidents.find(i => i.id === selected.id) ?? selected} onClose={() => setSelected(null)} updateIncident={updateIncident} toast={toast}/>}</div>
}

function Cases({ navigate }: { navigate: (page: PageKey) => void }) {
  const [category, setCategory] = useState('Все категории')
  const [selectedCase, setSelectedCase] = useState<(typeof evidenceCases)[number] | null>(null)
  const categories = ['Все категории', ...Array.from(new Set(evidenceCases.map(item => item.category)))]
  const visible = category === 'Все категории' ? evidenceCases : evidenceCases.filter(item => item.category === category)
  return <div className={`cases-page ${selectedCase ? 'has-case-detail' : ''}`}>
    <section className="cases-main">
      <div className="cases-toolbar panel">
        <div><strong>{visible.length}</strong><span>{visible.length === 1 ? 'кейс' : visible.length < 5 ? 'кейса' : 'кейсов'} с фотодоказательствами</span></div>
        <select value={category} onChange={event => setCategory(event.target.value)} aria-label="Категория кейсов">{categories.map(item => <option key={item}>{item}</option>)}</select>
      </div>
      <div className="case-grid">{visible.map(item => <button className="case-card" key={item.id} onClick={() => setSelectedCase(item)}>
        <div className="case-photo"><img src={item.image} alt={`Фотодоказательство: ${item.title}`} loading="lazy"/><span>{item.id}</span></div>
        <div className="case-card-body"><div className="case-meta"><span>{item.category}</span><time>{item.time}</time></div><h2>{item.title}</h2><p>{item.zone} · {item.camera}</p><div className="case-measures"><span>Confidence <strong>{item.confidence}%</strong></span><span>Обзор <strong>{item.visibility}%</strong></span></div><div className="case-verdict"><span>{item.verdict}</span><Icon name="arrow" size={15}/></div></div>
      </button>)}</div>
    </section>
    {selectedCase && <aside className="case-detail panel"><div className="evidence-head"><div><span className="eyebrow">{selectedCase.id} · {selectedCase.category}</span><h2>{selectedCase.title}</h2></div><button className="icon-button" aria-label="Закрыть кейс" onClick={() => setSelectedCase(null)}><Icon name="close"/></button></div><img className="case-detail-image" src={selectedCase.image} alt={`Увеличенное фотодоказательство: ${selectedCase.title}`}/><div className="fact-grid"><div><span>Камера</span><strong>{selectedCase.camera}</strong></div><div><span>Зона</span><strong>{selectedCase.zone}</strong></div><div><span>Confidence</span><strong>{selectedCase.confidence}%</strong></div><div><span>Видимость</span><strong>{selectedCase.visibility}%</strong></div></div><section className="case-assessment"><span className="section-kicker">ОЦЕНКА</span><h3>{selectedCase.verdict}</h3><p>{selectedCase.note}</p></section><div className="case-scale"><div><span>Полнота визуального доказательства</span><strong>{selectedCase.visibility} / 100</strong></div><i><b style={{width:`${selectedCase.visibility}%`}}/></i></div><button className="button primary full" onClick={() => navigate('monitoring')}>Открыть исходное наблюдение</button></aside>}
  </div>
}

function Archive({ incidents, openIncident, toast }: { incidents: Incident[]; openIncident: (i: Incident) => void; toast: (s: string) => void }) {
  const [query, setQuery] = useState('Покажи простои мобильного крана дольше 20 минут')
  const [searched, setSearched] = useState(true)
  const [loading, setLoading] = useState(false)
  const search = async () => { setLoading(true); await mockApi.runArchiveSearch(query); setLoading(false); setSearched(true) }
  return <div className="archive-page"><section className="archive-search"><span className="eyebrow">ПОИСК ПО ВИДЕОАРХИВУ</span><h1>Найдите событие без ручной перемотки</h1><div className="archive-searchbar"><Icon name="search" size={20}/><input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && search()} aria-label="Запрос для поиска по видео"/><button className="button primary" onClick={search}>Найти</button></div><div className="query-examples"><span>Примеры:</span><button onClick={() => setQuery('Рабочие без касок на втором участке')}>Без касок на втором участке</button><button onClick={() => setQuery('Входы людей в опасную зону за вчера')}>Входы в опасную зону</button></div></section>{searched && <><div className="parsed-filters"><span>Применённые фильтры</span><Status>Техника: мобильный кран</Status><Status>Длительность: от 20 минут</Status><Status>Период: 7 дней</Status></div><section className="archive-results panel"><div className="panel-head"><div><span className="section-kicker">РЕЗУЛЬТАТЫ</span><h2>{loading ? 'Ищем совпадения…' : `${archiveResults.length} фрагмента`}</h2></div><select aria-label="Сортировка результатов"><option>По релевантности</option><option>Сначала новые</option></select></div>{loading ? <div className="skeleton-list">{[1,2,3].map(n => <i key={n}/>)}</div> : <div className="video-results">{archiveResults.map((r, idx) => <article key={r.time}><div className="video-preview"><img src={cameraImage} alt="Превью видеофрагмента"/><button aria-label="Открыть видеофрагмент">▶</button><time>{r.duration}</time></div><div className="video-copy"><span className="eyebrow">{r.camera} · {r.zone} · {r.time}</span><h3>{r.title}</h3><p>Движение не зафиксировано в пределах видимой области. Наблюдение требует проверки по журналу работ.</p><div><Status tone={r.confidence > 80 ? 'success' : 'warning'}>Уверенность {r.confidence}%</Status><button className="text-button" onClick={() => idx === 0 ? openIncident(incidents[4]) : toast('Фрагмент открыт на временной шкале')}>Открыть фрагмент <Icon name="arrow" size={14}/></button><button className="text-button" onClick={() => toast('Черновик инцидента создан из видеофрагмента')}>Создать инцидент</button></div></div></article>)}</div>}</section></>}</div>
}

function Progress() {
  const [active, setActive] = useState(0)
  const steps = [
    { name: 'Армирование стен −1 этажа', zone: 'C-02', period: '12–16 сентября', progress: 68, plan: 75, status: 'Возможное отставание', quality: 'Среднее' },
    { name: 'Разработка грунта', zone: 'A-03', period: '10–18 сентября', progress: 61, plan: 64, status: 'В пределах плана', quality: 'Высокое' },
    { name: 'Подготовка зоны разгрузки', zone: 'B-01', period: '15–17 сентября', progress: 82, plan: 80, status: 'В пределах плана', quality: 'Высокое' },
  ]
  const step = steps[active]
  return <div className="progress-page"><div className="progress-sidebar panel"><span className="section-kicker">ВИЗУАЛЬНЫЕ ЭТАПЫ</span>{steps.map((s,i) => <button className={i === active ? 'active' : ''} key={s.name} onClick={() => setActive(i)}><div><strong>{s.name}</strong><small>{s.zone} · {s.period}</small></div><Status tone={s.status.includes('отставание') ? 'warning' : 'success'}>{s.status}</Status></button>)}</div><section className="progress-detail panel"><div className="progress-title"><div><span className="eyebrow">{step.zone} · {step.period}</span><h2>{step.name}</h2></div><Status tone={step.status.includes('отставание') ? 'warning' : 'success'}>{step.status}</Status></div><div className="before-after"><figure><CameraFrame compact boxes={false}/><figcaption>Было · 12 сентября, 09:00</figcaption></figure><figure><CameraFrame compact boxes={false}/><div className="progress-mask"/><figcaption>Стало · Сегодня, 14:20</figcaption></figure></div><div className="plan-fact"><div><span>Плановый диапазон</span><strong>{step.plan - 3}–{step.plan + 3}%</strong><i><b style={{width:`${step.plan}%`}}/></i></div><div><span>Наблюдаемый прогресс</span><strong>≈ {step.progress}%</strong><i><b className={step.progress < step.plan - 3 ? 'warning' : ''} style={{width:`${step.progress}%`}}/></i></div><div><span>Качество доказательств</span><strong>{step.quality}</strong><p>3 ракурса · 18 кадров · видимость 76%</p></div></div><div className="limitation"><Icon name="alert"/><span>Оценка основана только на видимой части конструкций и не заменяет исполнительную документацию. Требуется проверка инженером.</span></div></section></div>
}

function Analytics() {
  const [metric, setMetric] = useState('Инциденты')
  const max = Math.max(...analytics.map(d => d.incidents))
  return <div className="analytics-page"><div className="filter-bar panel"><select><option>Все камеры</option><option>CAM-03 · Кран, север</option></select><select><option>Все зоны</option><option>A-03 · Котлован</option></select><select><option>7 дней</option><option>Текущая смена</option></select><select><option>Подтверждённые</option><option>Все наблюдения</option></select></div><div className="analytics-summary"><div><span>Подтверждённые инциденты</span><strong>39</strong><small>−18% к предыдущим 7 дням</small></div><div><span>Медиана реакции</span><strong>18 мин</strong><small>цель · до 30 минут</small></div><div><span>Устранено в SLA</span><strong>84%</strong><small>33 из 39 событий</small></div><div><span>Камер с ограничениями</span><strong>2 из 5</strong><small>требуют обслуживания</small></div></div><section className="panel analytics-chart"><div className="panel-head"><div><span className="section-kicker">ДИНАМИКА</span><h2>{metric} по дням</h2></div><div className="segmented"><button className={metric === 'Инциденты' ? 'active' : ''} onClick={() => setMetric('Инциденты')}>Инциденты</button><button className={metric === 'Реакция' ? 'active' : ''} onClick={() => setMetric('Реакция')}>Время реакции</button></div></div><div className="bar-chart" aria-label="Столбчатый график по дням">{analytics.map(d => { const value = metric === 'Инциденты' ? d.incidents : d.response; const scale = metric === 'Инциденты' ? max : 30; return <div key={d.day}><span>{value}{metric === 'Реакция' ? ' мин' : ''}</span><i style={{height:`${Math.max(12, value/scale*100)}%`}}/><small>{d.day}</small></div> })}</div></section><div className="analytics-grid"><section className="panel"><div className="panel-head"><div><span className="section-kicker">ПО ТИПАМ</span><h2>Структура инцидентов</h2></div></div>{[['СИЗ',14,36],['Опасные зоны',9,23],['Техника',8,21],['Камеры',5,13],['Прогресс',3,7]].map(([n,v,p]) => <div className="rank-row" key={String(n)}><span>{n}</span><i><b style={{width:`${p}%`}}/></i><strong>{v}</strong><small>{p}%</small></div>)}</section><section className="panel evidence-table"><div className="panel-head"><div><span className="section-kicker">ДОКАЗАТЕЛЬСТВА</span><h2>Проблемные зоны</h2></div></div>{[['C-02 · Корпус 2','12 событий','48% видимость'],['A-03 · Котлован','9 событий','2 просрочено'],['B-01 · Складирование','6 событий','1 камера вне сети']].map(r => <button key={r[0]}><strong>{r[0]}</strong><span>{r[1]}</span><small>{r[2]}</small><Icon name="chevron"/></button>)}</section></div></div>
}

function Reports({ incidents, toast }: { incidents: Incident[]; toast: (s: string) => void }) {
  const sections = ['Состояние камер','Подтверждённые события','Время реакции','Люди и техника','Наблюдаемый прогресс','Ключевые доказательства','Недостающие данные']
  const [enabled, setEnabled] = useState(sections)
  return <div className="reports-page"><aside className="report-options panel"><span className="section-kicker">РАЗДЕЛЫ ОТЧЁТА</span>{sections.map(s => <label key={s}><input type="checkbox" checked={enabled.includes(s)} onChange={() => setEnabled(p => p.includes(s) ? p.filter(x => x!==s) : [...p,s])}/><span>{s}</span></label>)}<hr/><button className="button full" onClick={() => toast('Ссылка на отчёт скопирована')}><Icon name="link"/>Копировать ссылку</button><button className="button primary full" onClick={() => toast('Отчёт подготовлен к экспорту в PDF')}><Icon name="download"/>Экспорт PDF</button><button className="text-button full" onClick={() => toast('Демонстрационная отправка выполнена')}>Отправить участникам</button></aside><main className="report-preview panel"><div className="report-cover"><div className="brand-mark small"><span>СК</span></div><span>СТРОЙ-КОНТРОЛЬ · СВОДКА ЗА СМЕНУ</span><h1>ЖК «Северный», корпус 2</h1><p>16 сентября 2026 · 08:00–20:00</p><div><Status tone="success">4 из 5 камер онлайн</Status><span>Сформировано в 14:40</span></div></div>{enabled.includes('Подтверждённые события') && <section><h2>События смены</h2><div className="report-stats"><div><strong>{incidents.filter(i=>i.status === 'Устранено').length}</strong><span>устранено</span></div><div><strong>{incidents.filter(i=>i.status === 'В работе').length}</strong><span>в работе</span></div><div><strong>{incidents.filter(i=>i.status === 'Требует проверки').length}</strong><span>на проверке</span></div><div><strong>18 мин</strong><span>медиана реакции</span></div></div>{incidents.filter(i => ['Устранено','В работе'].includes(i.status)).slice(0,3).map(i => <div className="report-event" key={i.id}><div className="report-thumb"><img src={cameraImage} alt="Кадр-доказательство"/></div><div><span className="eyebrow">{i.id} · {i.time} · {i.camera}</span><h3>{i.title}</h3><p>{i.zone} · {i.assignee}</p></div><Status tone={statusTone(i.status)}>{i.status}</Status></div>)}</section>}{enabled.includes('Наблюдаемый прогресс') && <section><h2>Наблюдаемый прогресс</h2><div className="report-note"><strong>Армирование стен −1 этажа · C-02</strong><span>Возможное отставание: наблюдаемо ≈68%, плановый диапазон 72–78%.</span><small>Качество доказательств: среднее. Требуется сверка с журналом работ.</small></div></section>}{enabled.includes('Недостающие данные') && <section><h2>Недостающие данные</h2><div className="limitation"><Icon name="alert"/><span>CAM-09 вне сети с 12:26. Западный сектор C-02 перекрыт складируемыми материалами. Выводы для этих зон ограничены.</span></div></section>}</main></div>
}

function Settings({ toast }: { toast: (s: string) => void }) {
  const [rules, setRules] = useState([true,true,true,false])
  return <div className="settings-page"><nav className="settings-nav panel"><button className="active">Общие</button><button>Камеры</button><button>Правила наблюдения</button><button>Команда и роли</button><button>Уведомления</button><button>Интеграции</button></nav><section className="settings-content panel"><div className="settings-heading"><div><span className="section-kicker">ПРОЕКТ</span><h2>Общие настройки</h2><p>Базовые параметры объекта и автоматических наблюдений.</p></div><button className="button primary" onClick={() => toast('Настройки сохранены')}>Сохранить</button></div><div className="form-grid"><label>Название проекта<input defaultValue="ЖК «Северный», корпус 2"/></label><label>Часовой пояс<select defaultValue="Москва (UTC+3)"><option>Москва (UTC+3)</option></select></label><label>Адрес<input defaultValue="Москва, ул. Полярная, 18"/></label><label>Длительность смены<select defaultValue="08:00–20:00"><option>08:00–20:00</option></select></label></div><hr/><h3>Правила наблюдения</h3>{['Отсутствие каски','Вход в опасную зону','Опасное сближение с техникой','Предполагаемый простой'].map((r,i) => <div className="setting-row" key={r}><div><strong>{r}</strong><span>{i === 3 ? 'После 20 минут без видимого движения' : 'Создавать событие для ручной проверки'}</span></div><label className="switch"><input type="checkbox" checked={rules[i]} onChange={() => setRules(p => p.map((v,idx)=>idx===i?!v:v))}/><span/></label></div>)}</section></div>
}

export default function App() {
  const [page, setPage] = useState<PageKey>('overview')
  const [collapsed, setCollapsed] = useState(false)
  const [mobileNav, setMobileNav] = useState(false)
  const [incidents, setIncidents] = useState(incidentsSeed)
  const [selected, setSelected] = useState<Incident | null>(null)
  const [toastText, setToastText] = useState('')
  const [globalSearch, setGlobalSearch] = useState('')
  const title = titles[page]
  const openIncident = (incident: Incident) => { setSelected(incident); setPage('incidents') }
  const toast = (text: string) => { setToastText(text); window.setTimeout(() => setToastText(''), 2600) }
  const updateIncident = async (id: string, patch: Partial<Incident>) => { await mockApi.updateIncident(id, patch); setIncidents(old => old.map(i => i.id === id ? { ...i, ...patch } : i)); setSelected(old => old?.id === id ? { ...old, ...patch } : old); toast(patch.assignee ? `Ответственный: ${patch.assignee}` : `Статус изменён: ${patch.status}`) }
  const pageBody = useMemo(() => {
    switch(page) {
      case 'overview': return <Overview incidents={incidents} openIncident={openIncident} navigate={setPage}/>
      case 'monitoring': return <Monitoring incidents={incidents} openIncident={openIncident} toast={toast}/>
      case 'space': return <Space incidents={incidents} openIncident={openIncident} toast={toast}/>
      case 'incidents': return <Incidents incidents={incidents} selected={selected} setSelected={setSelected} updateIncident={updateIncident} toast={toast}/>
      case 'cases': return <Cases navigate={setPage}/>
      case 'archive': return <Archive incidents={incidents} openIncident={openIncident} toast={toast}/>
      case 'progress': return <Progress/>
      case 'analytics': return <Analytics/>
      case 'reports': return <Reports incidents={incidents} toast={toast}/>
      case 'settings': return <Settings toast={toast}/>
    }
  }, [page, incidents, selected])
  return <div className={`app-shell ${collapsed ? 'nav-collapsed' : ''}`}>
    <aside className={`sidebar ${mobileNav ? 'mobile-open' : ''}`}><div className="brand"><div className="brand-mark"><span>СК</span></div>{!collapsed && <div><strong>Строй-контроль</strong><small>Мониторинг объекта</small></div>}<button className="collapse" aria-label={collapsed ? 'Раскрыть меню' : 'Свернуть меню'} onClick={() => setCollapsed(!collapsed)}><Icon name="chevron" size={16}/></button></div><nav aria-label="Основная навигация">{nav.map(n => <button key={n.id} aria-label={n.label} title={collapsed ? n.label : undefined} className={page === n.id ? 'active' : ''} onClick={() => { setPage(n.id); setMobileNav(false); if (n.id !== 'incidents') setSelected(null) }}><Icon name={n.icon}/>{!collapsed && <span>{n.label}</span>}{n.id === 'incidents' && <b>{incidents.filter(i=>i.status === 'Требует проверки').length}</b>}{n.id === 'cases' && <b>{evidenceCases.length}</b>}</button>)}</nav><div className="sidebar-foot"><div className="system-state"><span/><div><strong>Система работает</strong><small>Обновлено 8 сек назад</small></div></div></div></aside>
    <div className="workspace"><header className="topbar"><button className="mobile-menu icon-button" aria-label="Открыть меню" onClick={() => setMobileNav(true)}><Icon name="menu"/></button><button className="project-switch"><span className="project-icon">С2</span><div><small>Текущий проект</small><strong>ЖК «Северный», корпус 2</strong></div><span>⌄</span></button><div className="topbar-spacer"/><label className="global-search"><Icon name="search" size={17}/><input value={globalSearch} onChange={e => setGlobalSearch(e.target.value)} placeholder="Поиск" aria-label="Глобальный поиск"/><kbd>⌘ K</kbd></label><button className="date-button"><Icon name="clock" size={16}/>Сегодня, 08:00–14:40</button><button className="icon-button notification" aria-label="Уведомления"><Icon name="bell"/><i/></button><button className="avatar" aria-label="Меню пользователя">ИС</button></header><div className="page-heading"><div><h1>{title[0]}</h1><p>{title[1]}</p></div>{page !== 'overview' && <div className="data-fresh"><span/>Данные актуальны · 8 сек</div>}</div><div className="page-content">{pageBody}</div></div>
    {mobileNav && <button className="nav-backdrop" aria-label="Закрыть меню" onClick={() => setMobileNav(false)}/>} {toastText && <div className="toast" role="status"><Icon name="check"/><span>{toastText}</span></div>}
  </div>
}
