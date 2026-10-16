import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as api from './api'
import type { ApiProfile, CameraItem, ProjectItem, UserProfile, ZoneItem } from './api'
import { Engine } from './engine'
import type { Episode, EventStatus, Level, LocalRules, Observation, Settings, Stage, UiEvent, VerdictAction } from './model'
import { DEFAULTS, DEMO_LINE, LV_TO_CLS, OBSERVED_LINE, STATUS_WORD, evaluate, loadLocalRules, loadSettings, saveLocalRules, saveSettings, stageAt, toEvent, toProfile, toStages, verdictOf } from './model'
import { CODES, MACH, type Code } from './lib/machinery'
import { durShort, fmtDay, hhmm, hhmmss } from './lib/format'
import { Spring, clamp, lerp } from './lib/spring'
import { ToastProvider, useToast } from './parts/common'
import { Verdict } from './parts/Verdict'
import { Stage as StageView } from './parts/Stage'
import { Recon } from './parts/Recon'
import { Queue } from './parts/Queue'
import { Dock } from './parts/Dock'
import { CaseFile } from './parts/CaseFile'
import { RuleEditor } from './parts/RuleEditor'
import { SettingsSheet, type SheetTab } from './parts/Settings'
import { Setup } from './parts/Setup'
import { Auth } from './parts/Auth'

export function SverkaApp() {
  const [user, setUser] = useState<UserProfile | null | undefined>(undefined)
  const [offline, setOffline] = useState<string | null>(null)
  useEffect(() => {
    api.me().then(setUser, (e: Error) => {
      setOffline(e.message)
      setUser(null)
    })
  }, [])
  return (
    <ToastProvider>
      {user === undefined ? (
        <div className="auth" aria-busy="true" />
      ) : user ? (
        <Workspace
          user={user}
          onLogout={() => {
            api.logout()
            setUser(null)
          }}
        />
      ) : (
        <Auth onAuth={setUser} offline={offline} />
      )}
    </ToastProvider>
  )
}

function useObservation(engine: Engine): Observation {
  const [obs, setObs] = useState(() => engine.snapshot())
  useEffect(() => {
    engine.start()
    const un = engine.subscribe(() => setObs(engine.snapshot()))
    return () => {
      un()
      engine.stop()
    }
  }, [engine])
  return obs
}

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v)
    } catch {
      // storage unavailable
    }
  },
}

function Workspace({ user, onLogout }: { user: UserProfile; onLogout: () => void }) {
  const toast = useToast()
  const [engine] = useState(() => new Engine())
  const obs = useObservation(engine)

  const [projects, setProjects] = useState<ProjectItem[] | null>(null)
  const [projectId, setProjectId] = useState<string | null>(() => store.get('sverka:project'))
  const [zones, setZones] = useState<ZoneItem[]>([])
  const [cameras, setCameras] = useState<CameraItem[]>([])
  const [stages, setStages] = useState<Stage[]>([])
  const [loaded, setLoaded] = useState(false)
  const [apiProfiles, setApiProfiles] = useState<Map<string, ApiProfile>>(new Map())
  const [localRules, setLocalRules] = useState<Map<string, LocalRules>>(new Map())
  const [events, setEvents] = useState<UiEvent[]>([])
  const [episodes, setEpisodes] = useState<Map<string, Episode>>(new Map())
  const [settings, setSettingsState] = useState<Settings>(DEFAULTS)
  const [selected, setSelected] = useState<string | null>(null)
  const [focus, setFocus] = useState<Code | null>(null)
  const [boxes, setBoxes] = useState(true)
  const [dockOpen, setDockOpen] = useState(false)
  const [caseOpen, setCaseOpen] = useState<{ id: string; origin: DOMRect | null } | null>(null)
  const [rule, setRule] = useState<{ code: Code; stageId: string; anchor: DOMRect } | null>(null)
  const [sheet, setSheet] = useState<SheetTab | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const [menu, setMenu] = useState<null | { kind: 'project' | 'user'; anchor: DOMRect }>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const loadToken = useRef(0)
  const meta = useRef(new Map<string, { kind: 'missing' | 'oop'; code: Code; stageId: string }>())
  const created = useRef(new Map<string, string | number>())
  const lastSaveError = useRef(0)

  const visible = useMemo(() => (projects || []).filter((p) => user.role === 'admin' || !p.owner_username || p.owner_username === user.username), [projects, user])
  const project = creating ? null : visible.find((p) => p.id === projectId) ?? visible[0] ?? null

  /* projects */
  useEffect(() => {
    api.projects().then(setProjects, (e: Error) => {
      setLoadError(e.message)
      setProjects([])
    })
  }, [])

  /* everything below belongs to one object; a late answer for a previous object is dropped */
  useEffect(() => {
    const token = ++loadToken.current
    engine.reset()
    setZones([])
    setCameras([])
    setStages([])
    setApiProfiles(new Map())
    setEvents([])
    setEpisodes(new Map())
    meta.current.clear()
    created.current.clear()
    setLoaded(false)
    setSelected(null)
    setCaseOpen(null)
    setRule(null)
    if (!project) {
      if (projects) setSetupOpen(true)
      return
    }
    store.set('sverka:project', project.id)
    const local = loadSettings(project.id)
    setSettingsState(local)
    Promise.all([api.zones(project.id), api.cameras(project.id), api.stages(project.id), api.incidents(project.id), api.incidentConfig().catch(() => null)])
      .then(([z, c, s, inc, cfg]) => {
        if (token !== loadToken.current) return
        setZones(z)
        setCameras(c)
        engine.setCameras(c)
        setStages(toStages(s))
        setEvents(inc.map((i) => toEvent(i, api.mediaUrl)))
        if (cfg) setSettingsState((x) => ({ ...x, window: cfg.violation_evaluation_window_seconds }))
        setLoaded(true)
        setLoadError(null)
        if (!s.length || !c.length) setSetupOpen(true)
      })
      .catch((e: Error) => {
        if (token !== loadToken.current) return
        setLoadError(e.message)
        setLoaded(true)
      })
  }, [project?.id, projects == null])

  /* refresh the journal now and then (decisions from other operators) */
  useEffect(() => {
    if (!project) return
    const id = project.id
    const timer = window.setInterval(() => {
      api.incidents(id).then((inc) => {
        if (id !== project.id) return
        setEvents(inc.map((i) => toEvent(i, api.mediaUrl)))
      }, () => undefined)
    }, 60_000)
    return () => clearInterval(timer)
  }, [project])

  const setSettings = (s: Settings) => {
    const prev = settings
    setSettingsState(s)
    if (project) saveSettings(project.id, s)
    if (s.window !== prev.window)
      api.setIncidentConfig(s.window).catch((e: Error) => {
        toast(`Окно сверки не сохранено на сервере: ${e.message}`, { error: true })
      })
  }

  /* model */
  const profiles = useMemo(() => new Map([...apiProfiles].map(([k, v]) => [k, toProfile(v, settings, localRules.get(k) ?? loadLocalRules(k))])), [apiProfiles, settings, localRules])
  const t = obs.t
  const stage = stageAt(stages, t)
  const prof = stage ? profiles.get(stage.id) ?? null : null
  engine.conf = settings.conf
  engine.demo = settings.demo
  engine.windowMs = settings.window * 1000
  engine.stageName = stage?.name

  const loadProfile = useCallback(
    (stageId: string) => {
      if (apiProfiles.has(stageId)) return Promise.resolve()
      const token = loadToken.current
      return api.profile(stageId).then(
        (p) => {
          if (token !== loadToken.current) return
          setApiProfiles((m) => new Map(m).set(stageId, p))
        },
        (e: Error) => toast(`Профиль этапа не загрузился: ${e.message}`, { error: true }),
      )
    },
    [apiProfiles, toast],
  )
  useEffect(() => {
    if (stage) loadProfile(stage.id)
  }, [stage?.id])
  const caseStageId = caseOpen ? (() => { const e = events.find((x) => x.id === caseOpen.id); return e ? (stages.find((s) => s.id === e.stageId) ?? stageAt(stages, e.at))?.id : undefined })() : undefined
  useEffect(() => {
    if (caseStageId) loadProfile(caseStageId)
  }, [caseStageId])
  const needAll = useCallback(() => {
    for (const s of stages) loadProfile(s.id)
  }, [stages, loadProfile])

  const ev = evaluate(obs, stage, prof, settings)
  const verdict = loaded ? verdictOf({ ev, obs, events, episodes, prof, hasPlan: stages.length > 0, s: settings }) : { tone: 'none' as const, title: 'Загружаем объект', sub: loadError || 'Получаем план, камеры и журнал событий.' }

  // the observed set looks like another stage of the plan: a hint of lag or an outdated schedule
  const infer = useMemo(() => {
    if (!stage || !ev.covered) return null
    const seen = new Set<Code>([...ev.slots.filter((s) => s.state === 'seen').map((s) => s.code), ...ev.oop.map((o) => o.code)])
    if (seen.size < 2 || !ev.oop.length) return null
    const score = (st: Stage) => {
      const p = profiles.get(st.id)
      if (!p) return -1
      const req = new Set(CODES.filter((c) => p.rules[c].lvl === 'req' || p.rules[c].lvl === 'rec'))
      const inter = [...seen].filter((c) => req.has(c)).length
      return inter / (seen.size + req.size - inter)
    }
    const cur = score(stage)
    let best: Stage | null = null
    let bs = cur
    for (const s of stages) {
      const sc = score(s)
      if (s.id !== stage.id && sc > bs + 0.2) {
        best = s
        bs = sc
      }
    }
    return best
  }, [stage, stages, profiles, ev.covered, ev.slots, ev.oop])

  /* the system writes events itself, only when it really watched and the model answered */
  useEffect(() => {
    if (!project || !stage || !prof || !ev.covered || !ev.inShift || (obs.model !== 'ready' && obs.model !== 'demo')) return
    const live = obs.sources.filter((s) => s.status === 'live')
    const names = live.map((s) => s.name).join(', ')
    const demo = obs.model === 'demo'
    const quality = `Качество данных: кадры дают ${live.length} из ${obs.sources.length} источников${live.length < obs.sources.length ? ', вывод ограничен' : ''}; ${demo ? 'распознавание в демо-режиме' : 'распознавание работает'}, порог уверенности ${settings.conf}%, окно сверки ${settings.window} с.`
    // context the server has no fields for travels in the description and is read back on reload
    const tail = (since: number) => [`${OBSERVED_LINE}${new Date(since).toISOString()}`, ...(demo ? [DEMO_LINE] : [])]
    const open = (code: Code, kind: 'missing' | 'oop') => [...meta.current].some(([id, m]) => m.code === code && m.kind === kind && m.stageId === stage.id && !episodes.get(id)?.to)
    const make = (key: string, kind: 'missing' | 'oop', code: Code, since: number, payload: Omit<api.IncidentCreate, 'project_id'>) => {
      const c = created.current.get(key)
      if ((typeof c === 'string') || (typeof c === 'number' && Date.now() < c) || open(code, kind)) return
      // one open event per machine and stage: after a reload, adopt the pending one from the journal
      const known = events.find((e) => e.status === 'pending' && !e.sample && e.kind === kind && e.mach === code && e.stageId === stage.id)
      if (known) {
        created.current.set(key, known.id)
        meta.current.set(known.id, { kind, code, stageId: stage.id })
        setEpisodes((m) => (m.has(known.id) ? m : new Map(m).set(known.id, { from: Math.min(known.at, since) })))
        return
      }
      created.current.set(key, 'pending')
      const shots = engine.liveSnapshots()
      api
        .createIncident({
          ...payload,
          project_id: project.id,
          album_snapshots: shots.map((x, i) => ({ camera_name: x.name, snapshot_base64: x.snapshot, is_primary: selected ? x.id === selected : i === 0 })),
        })
        .then((res) => {
          created.current.set(key, res.id)
          meta.current.set(res.id, { kind, code, stageId: stage.id })
          setEpisodes((m) => new Map(m).set(res.id, { from: since }))
          setEvents((list) => [toEvent(res, api.mediaUrl), ...list.filter((e) => e.id !== res.id)])
        })
        .catch((e: Error) => {
          created.current.set(key, Date.now() + 30_000)
          if (Date.now() - lastSaveError.current > 60_000) {
            lastSaveError.current = Date.now()
            toast(`Событие не сохранено: ${e.message}. Повторим через 30 с.`, { error: true })
          }
        })
    }
    for (const s of ev.slots) {
      if (s.lvl !== 'req' || s.state !== 'missing' || !s.sev || s.since == null || s.missFor == null) continue
      const others = ev.slots.filter((x) => x.state === 'seen').map((x) => MACH[x.code].lower)
      make(`${stage.id}|miss|${s.code}|${Math.round(s.since / 1000)}`, 'missing', s.code, s.since, {
        stage_id: stage.id,
        stage_name: stage.name,
        zone_name: zones[0]?.name ?? null,
        camera_name: live[0]?.name ?? null,
        severity: s.sev === 'err' ? 'ERROR' : 'WARNING',
        discrepancy_type: 'MISSING_MANDATORY',
        machinery_type: MACH[s.code].name,
        stage_probability: s.p,
        observed_count: 0,
        title: `${MACH[s.code].name} не замечен ${durShort(s.missFor)}`,
        description: [
          `Правило: ${MACH[s.code].name} — обязательная техника этапа «${stage.name}» (${Math.round(s.p * 100)}% по справочнику${s.edited ? ', изменено вручную' : ''}); предупреждение через ${durShort(s.warnAfter * 1000)}.`,
          `Наблюдение: с ${hhmmss(s.since)} ${MACH[s.code].lower} не найден ни на одном источнике (${names}).${others.length ? ` При этом замечены: ${others.join(', ')}.` : ''}`,
          quality,
          ...tail(s.since),
        ].join('\n'),
      })
    }
    for (const o of ev.oop) {
      if (o.dur < settings.oopAfter * 1000) continue
      make(`${stage.id}|oop|${o.code}|${Math.round(o.since / 1000)}`, 'oop', o.code, o.since, {
        stage_id: stage.id,
        stage_name: stage.name,
        zone_name: zones[0]?.name ?? null,
        camera_name: live[0]?.name ?? null,
        severity: 'ERROR',
        discrepancy_type: 'UNCHARACTERISTIC_PRESENT',
        machinery_type: MACH[o.code].name,
        stage_probability: o.p,
        observed_count: o.cams.length,
        title: `${MACH[o.code].name} не по этапу`,
        description: [
          `Правило: ${MACH[o.code].name} — нехарактерная техника для этапа «${stage.name}» (${Math.round(o.p * 100)}% по справочнику).`,
          `Наблюдение: с ${hhmmss(o.since)} замечен на источниках: ${o.cams.map((c) => obs.sources.find((x) => x.id === c.src)?.name || c.src).join(', ')}.`,
          quality,
          ...tail(o.since),
        ].join('\n'),
      })
    }
  })
  /* an episode ends when the machine is back (or the wrong one has left) */
  useEffect(() => {
    if (!stage || !ev.covered) return
    let changed: Map<string, Episode> | null = null
    for (const [id, m] of meta.current) {
      const e = episodes.get(id)
      if (!e || e.to || m.stageId !== stage.id) continue
      const back = m.kind === 'missing' ? ev.slots.find((s) => s.code === m.code)?.state === 'seen' : !ev.oop.some((o) => o.code === m.code)
      if (back) (changed ||= new Map(episodes)).set(id, { ...e, to: t })
    }
    if (changed) setEpisodes(changed)
  })

  /* decisions */
  // a swipe answers instantly (undo right away); the case file waits for the server so "saving" stays visible
  const decide = async (id: string, status: EventStatus, quiet = false, optimistic = true) => {
    const before = events.find((e) => e.id === id)
    if (!before || before.sample) return
    const done = () => {
      if (!quiet && status !== 'pending') toast(`${STATUS_WORD[status]} · ${before.code}`, { undo: () => void decide(id, 'pending', true).catch(() => undefined) })
    }
    if (optimistic) {
      setEvents((l) => l.map((e) => (e.id === id ? { ...e, status, decidedAt: Date.now() } : e)))
      done()
    }
    try {
      const res = await api.setIncidentStatus(id, status)
      setEvents((l) => l.map((e) => (e.id === id ? { ...toEvent(res, api.mediaUrl), decidedAt: status === 'pending' ? null : Date.now() } : e)))
      if (!optimistic) done()
    } catch (e) {
      setEvents((l) => l.map((x) => (x.id === id ? before : x)))
      if (optimistic) toast(`Решение не сохранено: ${(e as Error).message}`, { error: true, retry: () => void decide(id, status).catch(() => undefined) })
      throw e
    }
  }

  /* rules */
  /* rules: the level goes to the server (shared); "не учитывать" and own timings stay in this browser */
  const writeLocal = (stageId: string, next: LocalRules) => {
    saveLocalRules(stageId, next)
    setLocalRules((m) => new Map(m).set(stageId, next))
  }
  const applyRule = async (stageId: string, code: Code, d: { lvl: Level; warnAfter: number | null; errAfter: number | null }) => {
    const r = profiles.get(stageId)!.rules[code]
    const local = { ...(localRules.get(stageId) ?? loadLocalRules(stageId)) }
    const serverLvl = r.lvl === 'skip' ? (apiLevel(stageId, code) ?? r.base) : r.lvl
    const rec = { ...(local[code] ?? { base: serverLvl, at: Date.now() }) }
    rec.skip = d.lvl === 'skip' || undefined
    rec.warnAfter = d.warnAfter ?? undefined
    rec.errAfter = d.errAfter ?? undefined
    const target = d.lvl === 'skip' ? serverLvl : d.lvl
    if (target !== serverLvl) {
      const res = await api.putOverrides(stageId, { [MACH[code].api]: LV_TO_CLS[target as Exclude<Level, 'skip'>] })
      setApiProfiles((m) => new Map(m).set(stageId, res))
    }
    // back to where it started and nothing local left: the mark is no longer needed
    if (target === rec.base && !rec.skip && rec.warnAfter == null && rec.errAfter == null) delete local[code]
    else local[code] = rec
    writeLocal(stageId, local)
    toast(`Правило для «${MACH[code].lower}» сохранено · действует с ${hhmm(Date.now())}`)
  }
  const resetRule = async (stageId: string, code: Code) => {
    const local = { ...(localRules.get(stageId) ?? loadLocalRules(stageId)) }
    const rec = local[code]
    if (!rec) return
    const serverLvl = apiLevel(stageId, code)
    if (serverLvl && serverLvl !== rec.base && rec.base !== 'skip') {
      const res = await api.putOverrides(stageId, { [MACH[code].api]: LV_TO_CLS[rec.base] })
      setApiProfiles((m) => new Map(m).set(stageId, res))
    }
    delete local[code]
    writeLocal(stageId, local)
    toast('Правило возвращено к исходному уровню')
  }
  const apiLevel = (stageId: string, code: Code): Level | null => {
    const p = apiProfiles.get(stageId)
    if (!p) return null
    return toProfile(p, settings).rules[code].lvl
  }

  /* sources */
  const addCamera = async (name: string, url: string) => {
    if (!project) return
    const cam = await api.createCamera(project.id, { name, stream_url: url, zone_id: zones[0]?.id ?? null })
    const next = [...cameras, cam]
    setCameras(next)
    engine.setCameras(next)
    toast(`Камера «${cam.name}» добавлена`)
  }
  const deleteCamera = async (id: string) => {
    if (!project) return
    try {
      await api.deleteCamera(project.id, id)
      const next = cameras.filter((c) => c.id !== id)
      setCameras(next)
      engine.setCameras(next)
    } catch (e) {
      toast((e as Error).message, { error: true })
    }
  }
  const openRecording = (file: File, start: number) => {
    engine.startRecording(file, start)
    setSelected('recording')
    if (project)
      api.uploadVideo(project.id, file, new Date(start).toISOString()).then(
        () => toast('Запись сохранена на сервере'),
        (e: Error) => toast(`Запись не сохранена на сервере: ${e.message}. Анализ в браузере продолжается.`, { error: true }),
      )
  }
  const closeRecording = () => {
    engine.stopRecording()
    engine.setCameras(cameras)
    setSelected(null)
  }

  /* plan */
  const importPlan = async (fn: () => Promise<api.ImportResult>) => {
    const res = await fn()
    setStages(toStages(res.stages))
    setApiProfiles(new Map())
    return res
  }

  const onAction = (a: VerdictAction | { act: string; id?: string }, el?: HTMLElement) => {
    if (a.act === 'case' && a.id) setCaseOpen({ id: a.id, origin: document.querySelector(`.q-item[data-id="${a.id}"] .q-card`)?.getBoundingClientRect() ?? el?.getBoundingClientRect() ?? null })
    else if (a.act === 'plan') setDockOpen(true)
    else if (a.act === 'setup') setSetupOpen(true)
    else if (a.act.startsWith('settings')) setSheet((a.act.split(':')[1] as SheetTab) || 'control')
  }
  const openRule = (code: Code, el: HTMLElement, stageId?: string) => {
    const sid = stageId || stage?.id
    if (!sid) return
    loadProfile(sid)
    setRule({ code, stageId: sid, anchor: el.getBoundingClientRect() })
  }

  /* keyboard */
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || caseOpen || rule || sheet) return
      if (e.key === 'Escape' && dockOpen) setDockOpen(false)
      if (e.key === 'p' || e.key === 'з') setDockOpen((o) => !o)
      if (['j', 'k', 'о', 'л'].includes(e.key)) {
        const cards = Array.from(document.querySelectorAll<HTMLElement>('.q-card'))
        if (!cards.length) return
        const i = cards.indexOf(document.activeElement as HTMLElement)
        cards[e.key === 'j' || e.key === 'о' ? Math.min(cards.length - 1, i + 1) : Math.max(0, i - 1)].focus()
      }
    }
    addEventListener('keydown', k)
    return () => removeEventListener('keydown', k)
  })

  const caseEvent = caseOpen ? events.find((e) => e.id === caseOpen.id) : null
  const caseStage = caseEvent ? stages.find((s) => s.id === caseEvent.stageId) ?? stageAt(stages, caseEvent.at) : null
  const ruleStage = rule ? stages.find((s) => s.id === rule.stageId) : null
  const ruleProf = rule ? profiles.get(rule.stageId) : null
  const setupVisible = setupOpen || (loaded && !project)
  const pending = events.filter((e) => e.status === 'pending')

  return (
    <div className="app" id="app">
      <header className="bar">
        <div className="brand" aria-hidden="true">
          СК
        </div>
        <button type="button" className="ctx" onClick={(e) => setMenu({ kind: 'project', anchor: e.currentTarget.getBoundingClientRect() })} aria-haspopup="menu">
          <small>Объект</small>
          <span>{project?.name || 'Новый объект'}</span>
        </button>
        {zones.length > 0 && (
          <>
            <span className="slash" aria-hidden="true">
              /
            </span>
            <span className="ctx" id="ctxZone" style={{ cursor: 'default' }}>
              <small>Зона</small>
              <span className="no-caret">{zones.length === 1 ? zones[0].name : `${zones.length} зоны`}</span>
            </span>
          </>
        )}
        <div className="grow" />
        {obs.model === 'demo' && (
          <button type="button" className="demo-badge" onClick={() => setSheet('control')} title={`Модель недоступна: ${obs.modelMessage || 'причина не сообщена'}. Детекции подставляются по демо-сцене.`}>
            <span className="db-full">Демо-распознавание</span>
            <span className="db-short">Демо</span>
          </button>
        )}
        <TimePill obs={obs} onExit={closeRecording} />
        <button type="button" className="icon-btn" onClick={() => setSheet('control')} aria-label="Настройки контроля">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="10" cy="17" r="2" />
          </svg>
        </button>
        <button type="button" className="avatar-btn" onClick={(e) => setMenu({ kind: 'user', anchor: e.currentTarget.getBoundingClientRect() })} aria-label={`Пользователь ${user.username}`} aria-haspopup="menu">
          <span className="avatar">{user.username.slice(0, 2).toUpperCase()}</span>
        </button>
      </header>

      <Verdict v={verdict} onAction={onAction} at={obs.mode === 'recording' ? `запись ${fmtDay(t)}` : undefined} />

      <main className="work">
        <StageView engine={engine} obs={obs} ev={ev} prof={prof} selected={selected} onSelect={setSelected} focus={focus} boxes={boxes} setBoxes={setBoxes} onAction={(act) => onAction({ act })} settings={settings} />
        <aside className="side" id="side">
          <Recon ev={ev} stage={stage} prof={prof} obs={obs} loading={!!stage && !prof} infer={infer} onRule={(c, el) => openRule(c, el)} onFocus={setFocus} />
          <Queue
            events={events}
            episodes={episodes}
            t={t}
            prof={prof}
            onOpen={(id, el) => setCaseOpen({ id, origin: el.getBoundingClientRect() })}
            onDecide={(id, status) => {
              decide(id, status).catch(() => undefined)
            }}
            onJournal={() => toast('Журнал с выгрузкой акта за период переносится следующим шагом. Пока он доступен в старом интерфейсе.')}
          />
        </aside>
        <QueueJump count={pending.length} err={pending.some((e) => e.sev === 'err')} />
      </main>

      {setupVisible && (
        <Setup
          project={project}
          stages={stages}
          sourcesCount={obs.mode === 'recording' ? 1 : cameras.length}
          obs={obs}
          stageNow={stage}
          onCreateProject={async (d) => {
            const p = await api.createProject({ ...d, owner_username: user.username })
            setProjects((l) => [...(l || []), p])
            setProjectId(p.id)
            setCreating(false)
          }}
          onDemoPlan={() => importPlan(() => api.loadDemoPlan(project!.id))}
          onUploadPlan={(f) => importPlan(() => api.uploadPlan(project!.id, f))}
          onAddCamera={addCamera}
          onCheck={api.probeCamera}
          onRecording={openRecording}
          onClose={() => {
            setSetupOpen(false)
            setCreating(false)
          }}
        />
      )}

      <Dock
        stages={stages}
        current={stage}
        t={t}
        obs={obs}
        events={events}
        profiles={profiles}
        needProfiles={needAll}
        onRule={(c, el, sid) => openRule(c, el, sid)}
        onOpenEvent={(id, el) => setCaseOpen({ id, origin: el.getBoundingClientRect() })}
        onUploadPlan={(f) => {
          if (!project) return
          importPlan(() => api.uploadPlan(project.id, f)).then(
            (r) => toast(`План загружен: ${r.total_stages_imported} этапов, сопоставлено ${r.matched_catalog_count}`),
            (e: Error) => toast(e.message, { error: true }),
          )
        }}
        onSeek={(v) => engine.seek(v)}
        open={dockOpen}
        setOpen={setDockOpen}
        shift={{ from: settings.shiftFrom, to: settings.shiftTo }}
      />

      {caseEvent && (
        <CaseFile
          key={caseEvent.id}
          ev={caseEvent}
          ep={episodes.get(caseEvent.id)}
          stage={caseStage}
          prof={caseStage ? profiles.get(caseStage.id) ?? null : null}
          obs={obs}
          origin={caseOpen!.origin}
          onClose={() => setCaseOpen(null)}
          onDecide={(status) => decide(caseEvent.id, status, false, false)}
          onRule={(code) => {
            const sid = caseStage?.id
            setCaseOpen(null)
            window.setTimeout(() => {
              const el = document.querySelector<HTMLElement>(`.slot[data-code="${code}"]`) || document.querySelector<HTMLElement>('.recon')
              if (el && sid) openRule(code, el, sid)
            }, 380)
          }}
          onPlan={() => {
            setCaseOpen(null)
            setDockOpen(true)
          }}
        />
      )}
      {rule && ruleStage && ruleProf && (
        <RuleEditor
          key={rule.code + rule.stageId}
          code={rule.code}
          stage={ruleStage}
          prof={ruleProf}
          obs={obs}
          settings={settings}
          anchor={rule.anchor}
          onApply={(d) => applyRule(rule.stageId, rule.code, d)}
          onReset={() => resetRule(rule.stageId, rule.code)}
          onClose={() => setRule(null)}
        />
      )}
      {sheet && project && (
        <SettingsSheet
          tab={sheet}
          settings={settings}
          onSettings={setSettings}
          obs={obs}
          cameras={cameras}
          project={project}
          zones={zones}
          onAddCamera={addCamera}
          onDeleteCamera={deleteCamera}
          onCheck={api.probeCamera}
          onRecording={openRecording}
          onClose={() => setSheet(null)}
        />
      )}
      {menu && (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)}>
          {menu.kind === 'project' ? (
            <>
              <div className="m-k kicker">Объекты</div>
              {visible.map((p) => (
                <button key={p.id} type="button" className="m-item" role="menuitemradio" aria-checked={p.id === project?.id} onClick={() => { setProjectId(p.id); setCreating(false); setMenu(null) }}>
                  <span className="chk">✓</span>
                  <span>
                    <b>{p.name}</b>
                    <small>{[p.object_kind, p.address].filter(Boolean).join(' · ') || p.code}</small>
                  </span>
                </button>
              ))}
              <div className="m-sep" />
              <button type="button" className="m-item" role="menuitem" onClick={() => { setCreating(true); setMenu(null); setSetupOpen(true) }}>
                <span>+</span>
                <span><b>Новый объект</b></span>
              </button>
            </>
          ) : (
            <>
              <div className="m-k kicker">{user.username} · {user.role === 'admin' ? 'администратор' : 'инженер технадзора'}</div>
              <button type="button" className="m-item" role="menuitem" onClick={() => { setMenu(null); setSetupOpen(true) }}>
                <span />
                <span><b>Первый запуск</b><small>План, источники, проверка</small></span>
              </button>
              <a className="m-item" role="menuitem" href="#legacy" onClick={() => setTimeout(() => location.reload(), 0)}>
                <span />
                <span><b>Старый интерфейс</b><small>Для сравнения</small></span>
              </a>
              <div className="m-sep" />
              <button type="button" className="m-item" role="menuitem" onClick={onLogout}>
                <span />
                <span><b>Выйти</b></span>
              </button>
            </>
          )}
        </Menu>
      )}
    </div>
  )
}

function TimePill({ obs, onExit }: { obs: Observation; onExit: () => void }) {
  if (obs.mode === 'recording')
    return (
      <div className="time-pill" data-live="false">
        <i className="dot" aria-hidden="true" />
        <b>Запись</b>
        <span className="mono">{hhmmss(obs.t)}</span>
        <span className="date">{fmtDay(obs.t)}</span>
        <button type="button" className="exit" onClick={onExit}>
          К камерам
        </button>
      </div>
    )
  return (
    <div className="time-pill" data-live="true" aria-label="Время наблюдения">
      <i className="dot" aria-hidden="true" />
      <b>Сейчас</b>
      <span className="mono">{hhmmss(obs.t)}</span>
      <span className="date">{fmtDay(obs.t)}</span>
    </div>
  )
}

function Menu({ anchor, onClose, children }: { anchor: DOMRect; onClose: () => void; children: React.ReactNode }) {
  const el = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const m = el.current!
    const w = m.offsetWidth
    const left = clamp(anchor.right - w, 8, innerWidth - w - 8)
    const leftAligned = anchor.left < innerWidth / 2
    Object.assign(m.style, { left: (leftAligned ? clamp(anchor.left, 8, innerWidth - w - 8) : left) + 'px', top: anchor.bottom + 8 + 'px', transformOrigin: leftAligned ? '0 0' : '100% 0' })
    const s = new Spring(0, {
      response: 0.34,
      damping: 0.95,
      rest: 0.002,
      onUpdate: (p) => {
        m.style.opacity = String(clamp(p * 1.3, 0, 1))
        m.style.transform = `translateY(${(1 - p) * -6}px) scale(${lerp(0.96, 1, p)})`
      },
    })
    s.set(0)
    s.to(1)
    m.querySelector<HTMLElement>('[aria-checked="true"], .m-item')?.focus()
    const down = (e: PointerEvent) => !m.contains(e.target as Node) && onClose()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      const items = Array.from(m.querySelectorAll<HTMLElement>('.m-item'))
      const i = items.indexOf(document.activeElement as HTMLElement)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        items[(i + 1) % items.length]?.focus()
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        items[(i - 1 + items.length) % items.length]?.focus()
      }
    }
    addEventListener('pointerdown', down, true)
    addEventListener('keydown', key)
    return () => {
      removeEventListener('pointerdown', down, true)
      removeEventListener('keydown', key)
    }
  }, [anchor, onClose])
  return (
    <div className="menu" ref={el} role="menu" style={{ opacity: 0 }}>
      {children}
    </div>
  )
}

function QueueJump({ count, err }: { count: number; err: boolean }) {
  const [hidden, setHidden] = useState(true)
  useEffect(() => {
    const side = document.getElementById('side')
    const q = document.getElementById('queue')
    if (!side || !q) return
    const head = q.querySelector('.queue-head') || q
    const io = new IntersectionObserver(([en]) => setHidden(en.isIntersecting), { root: side, threshold: 0 })
    io.observe(head)
    return () => io.disconnect()
  }, [])
  if (hidden || !count) return null
  return (
    <button
      type="button"
      className="q-jump"
      data-sev={err ? 'err' : 'warn'}
      onClick={() => {
        const side = document.getElementById('side')
        const q = document.getElementById('queue')
        side?.scrollTo({ top: (q?.offsetTop ?? 0) - 8, behavior: 'smooth' })
      }}
    >
      <i />
      Требуют решения · {count}
    </button>
  )
}
