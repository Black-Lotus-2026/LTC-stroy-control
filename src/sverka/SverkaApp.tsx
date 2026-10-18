import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as api from './api'
import type { AdminRecipient, ApiAlert, ApiProfile, CameraItem, ProjectItem, UserProfile, ZoneItem } from './api'
import { Engine } from './engine'
import type { Episode, EventStatus, Level, LocalRules, Observation, Settings, SourceView, Stage, UiEvent, VerdictAction } from './model'
import { DEFAULTS, DEMO_LINE, ROLE_LABEL, LV_TO_CLS, STATUS_WORD, evaluate, loadLocalRules, loadSettings, rightsFor, saveLocalRules, saveSettings, stageAt, toEvent, toProfile, toStages, verdictOf } from './model'
import { CODES, MACH, type Code } from './lib/machinery'
import { DAY_MS, durShort, fmtDay, hhmm, hhmmss, isoDay, plural } from './lib/format'
import { Spring, clamp, lerp } from './lib/spring'
import { Seg, ToastProvider, useToast } from './parts/common'
import { setThemePref, useThemePref, type ThemePref } from './lib/theme'
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
import { Journal } from './parts/Journal'
import { Intro, Showcase } from './parts/Intro'
import { TaskList } from './parts/Tasks'

export function SverkaApp() {
  const [user, setUser] = useState<UserProfile | null | undefined>(undefined)
  const [offline, setOffline] = useState<string | null>(null)
  // the intro page comes after sign-in and before the workspace; it can be called back from the
  // workspace, which then stays mounted underneath and keeps observing
  const [intro, setIntro] = useState<'on' | 'leaving' | 'off'>('on')
  const [entered, setEntered] = useState(false)
  const leaveIntro = useCallback(() => {
    setEntered(true)
    setIntro((s) => (s === 'on' ? 'leaving' : s))
  }, [])
  const dropIntro = useCallback(() => setIntro('off'), [])
  const showIntro = useCallback(() => setIntro('on'), [])
  useEffect(() => {
    api.me().then(setUser, (e: Error) => {
      setOffline(e.message)
      setUser(null)
    })
  }, [])
  // sign-in and the intro share one backdrop, so the drawing carries over from one to the other
  const showcase = user === null || (!!user && intro !== 'off')
  return (
    <ToastProvider>
      {user === undefined ? (
        <div className="auth" aria-busy="true" />
      ) : (
        <>
          {user && entered && (
            <div className="ws-host" inert={intro === 'on'}>
              <Workspace
                user={user}
                onUser={setUser}
                covered={intro === 'on'}
                onIntro={showIntro}
                onLogout={() => {
                  api.logout()
                  setUser(null)
                  setIntro('on')
                  setEntered(false)
                }}
              />
            </div>
          )}
          {showcase && (
            <Showcase mode={user ? 'intro' : 'auth'} leaving={!!user && intro === 'leaving'} onGone={dropIntro}>
              {user ? <Intro user={user} leaving={intro === 'leaving'} onContinue={leaveIntro} /> : <Auth onAuth={setUser} offline={offline} />}
            </Showcase>
          )}
        </>
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

function Workspace({ user, onUser, covered, onIntro, onLogout }: { user: UserProfile; onUser: (u: UserProfile) => void; covered: boolean; onIntro: () => void; onLogout: () => void }) {
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
  const [journal, setJournal] = useState<{ origin: DOMRect | null } | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const [menu, setMenu] = useState<null | { kind: 'project' | 'user' | 'tasks'; anchor: DOMRect }>(null)
  const [alerts, setAlerts] = useState<ApiAlert[]>([])
  // the forecast for the object's address; null where the server has none
  const [weather, setWeather] = useState<api.Weather | null>(null)
  const [admins, setAdmins] = useState<AdminRecipient[]>([])
  // an event to open once its object has loaded (a task of another object)
  const wantCase = useRef<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const loadToken = useRef(0)
  const meta = useRef(new Map<string, { kind: 'missing' | 'oop'; code: Code; stageId: string }>())
  // per camera: was it live in this session, and the loss we are writing (resolves true once it is in the journal)
  const signal = useRef(new Map<string, { live: boolean; lost?: { at: number; written: Promise<boolean> } }>())
  const created = useRef(new Map<string, string | number>())
  const lastSaveError = useRef(0)

  // the server gives a non-admin only the objects they own (an object without an owner is the administrator's)
  const visible = useMemo(() => (projects || []).filter((p) => user.role === 'admin' || p.owner_username === user.username), [projects, user])
  const project = creating ? null : visible.find((p) => p.id === projectId) ?? visible[0] ?? null

  /* projects */
  useEffect(() => {
    api.projects().then(setProjects, (e: Error) => {
      setLoadError(e.message)
      setProjects([])
    })
    api.admins().then(setAdmins, () => undefined)
  }, [])

  /* tasks of this user across objects: assignments, escalations, confirmed fixes */
  useEffect(() => {
    let alive = true
    const load = () =>
      api.alerts().then(
        (a) => alive && setAlerts(a),
        () => undefined,
      )
    load()
    const timer = window.setInterval(load, 15_000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [user.id])

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
    signal.current.clear()
    setLoaded(false)
    setSelected(null)
    setCaseOpen(null)
    setRule(null)
    setJournal(null)
    setWeather(null)
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
        setEvents((old) => inc.map((i) => keepUnsent(toEvent(i, api.mediaUrl), old)))
        if (cfg) setSettingsState((x) => ({ ...x, window: cfg.violation_evaluation_window_seconds }))
        setLoaded(true)
        setLoadError(null)
        const want = wantCase.current
        wantCase.current = null
        if (want && inc.some((i) => i.id === want)) setCaseOpen({ id: want, origin: null })
        else if (!s.length || !c.length) setSetupOpen(true)
      })
      .catch((e: Error) => {
        if (token !== loadToken.current) return
        setLoadError(e.message)
        setLoaded(true)
      })
    loadWeather(project.id, token)
  }, [project?.id, projects == null])

  /* the forecast is extra: a server without it (404) or a weather service that is down leaves the plan as it was */
  const noWeather = useRef(false)
  const loadWeather = (id: string, token: number, fresh = false) => {
    if (noWeather.current) return
    const ask = fresh ? api.refreshWeather(id) : api.weather(id)
    ask
      .then((w) => {
        if (token !== loadToken.current) return
        setWeather(w)
        // a saved forecast that is short or for an old address is asked for again, once
        if (!fresh && w.location_configured && (w.days.length < 7 || !w.resolved_address)) loadWeather(id, token, true)
      })
      .catch((e) => {
        // the server has no forecast at all: do not ask again in this session
        if (!fresh && e instanceof api.ApiError && e.status === 404) noWeather.current = true
      })
  }

  /* refresh the journal now and then: decisions of others, deadlines, the server's rechecks */
  useEffect(() => {
    if (!project) return
    const id = project.id
    const timer = window.setInterval(() => {
      api.incidents(id).then((inc) => {
        if (id !== project.id) return
        setEvents((old) => inc.map((i) => keepUnsent(toEvent(i, api.mediaUrl), old)))
      }, () => undefined)
    }, 15_000)
    return () => clearInterval(timer)
  }, [project])

  const setSettings = (s: Settings) => {
    const prev = settings
    setSettingsState(s)
    if (project) saveSettings(project.id, s)
    if (s.window !== prev.window && user.role === 'admin')
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

  // the server computes a profile per request (seconds each): never ask twice for the same stage
  const inflight = useRef(new Set<string>())
  const loadProfile = useCallback(
    (stageId: string) => {
      if (apiProfiles.has(stageId) || inflight.current.has(stageId)) return Promise.resolve()
      const token = loadToken.current
      inflight.current.add(stageId)
      return api
        .profile(stageId)
        .then(
          (p) => {
            if (token !== loadToken.current) return
            setApiProfiles((m) => new Map(m).set(stageId, p))
          },
          (e: Error) => toast(`Профиль этапа не загрузился: ${e.message}`, { error: true }),
        )
        .finally(() => inflight.current.delete(stageId))
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
    // demo recognition has no field on the server: it travels in the description and is read back on reload
    const tail = demo ? [DEMO_LINE] : []
    // the event belongs to the source it is shown on, and to that camera's zone
    const src = live.find((x) => x.id === selected) ?? live[0]
    const where = { zone_id: zoneIdOf(src?.id), zone_name: zoneOf(src?.id), camera_id: cameras.some((c) => c.id === src?.id) ? src!.id : null, camera_name: src?.name ?? null }
    const open = (code: Code, kind: 'missing' | 'oop') => [...meta.current].some(([id, m]) => m.code === code && m.kind === kind && m.stageId === stage.id && !episodes.get(id)?.to)
    const make = (key: string, kind: 'missing' | 'oop', code: Code, since: number, payload: Omit<api.IncidentCreate, 'project_id' | keyof typeof where>) => {
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
          ...where,
          ...payload,
          project_id: project.id,
          captured_at: new Date(since).toISOString(),
          observation_key: key,
          // demo detections are not the model's: the server is not told they are
          ...(demo ? {} : { model_status: 'valid' as const }),
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
          ...tail,
        ].join('\n'),
      })
    }
    // recommended machinery only warns, and only once per absence (the legacy UI repeated it every window)
    for (const s of ev.slots) {
      if (s.lvl !== 'rec' || s.state !== 'missing' || s.since == null || s.missFor == null || s.missFor < s.warnAfter * 1000) continue
      make(`${stage.id}|rec|${s.code}|${Math.round(s.since / 1000)}`, 'missing', s.code, s.since, {
        stage_id: stage.id,
        stage_name: stage.name,
        severity: 'WARNING',
        discrepancy_type: 'MISSING_RECOMMENDED',
        machinery_type: MACH[s.code].name,
        stage_probability: s.p,
        observed_count: 0,
        title: `${MACH[s.code].name} не замечен ${durShort(s.missFor)}`,
        description: [
          `Правило: ${MACH[s.code].name} — рекомендуемая техника этапа «${stage.name}» (${Math.round(s.p * 100)}% по справочнику${s.edited ? ', изменено вручную' : ''}); предупреждение через ${durShort(s.warnAfter * 1000)}, отклонением не становится.`,
          `Наблюдение: с ${hhmmss(s.since)} ${MACH[s.code].lower} не найден ни на одном источнике (${names}).`,
          quality,
          ...tail,
        ].join('\n'),
      })
    }
    for (const o of ev.oop) {
      if (o.dur < settings.oopAfter * 1000) continue
      make(`${stage.id}|oop|${o.code}|${Math.round(o.since / 1000)}`, 'oop', o.code, o.since, {
        stage_id: stage.id,
        stage_name: stage.name,
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
          ...tail,
        ].join('\n'),
      })
    }
  })
  /* camera signal goes to the journal as in the legacy UI: one record when it is lost, one when it is back */
  useEffect(() => {
    if (!project || !loaded) return
    const now = Date.now()
    const total = obs.sources.length
    const liveN = obs.sources.filter((x) => x.status === 'live').length
    const write = (src: SourceView, type: 'STREAM_LOST' | 'STREAM_OFFLINE' | 'STREAM_ONLINE', at: number, title: string, observation: string, quality: string) =>
      api
        .createIncident({
          project_id: project.id,
          stage_id: stage?.id ?? null,
          stage_name: stage?.name ?? null,
          zone_id: zoneIdOf(src.id),
          zone_name: zoneOf(src.id),
          camera_id: src.id,
          camera_name: src.name,
          captured_at: new Date(at).toISOString(),
          observation_key: `${src.id}|${type}|${Math.round(at / 1000)}`,
          severity: type === 'STREAM_LOST' ? 'ERROR' : 'WARNING',
          discrepancy_type: type,
          title,
          description: [`Наблюдение: ${observation}`, `Качество данных: ${quality}`].join('\n'),
        })
        .then((res) => {
          setEvents((list) => [toEvent(res, api.mediaUrl), ...list.filter((e) => e.id !== res.id)])
          return true
        })
    for (const src of obs.sources) {
      if (src.kind !== 'camera') continue
      const m = signal.current.get(src.id) ?? { live: false }
      signal.current.set(src.id, m)
      if (src.status === 'live') {
        const lost = m.lost
        if (lost)
          void lost.written.then((ok) => ok && write(src, 'STREAM_ONLINE', now, `Видеопоток восстановлен: ${src.name}`, `камера «${src.name}» снова присылает кадры с ${hhmmss(now)}; перерыв длился ${durShort(now - lost.at)}.`, `кадры дают ${liveN} из ${total} источников.`)).catch(() => undefined)
        m.lost = undefined
        m.live = true
        continue
      }
      const down = src.status === 'offline' || src.status === 'stale'
      if (!down || m.lost || !src.since || now - src.since < settings.window * 1000 || !ev.inShift) continue
      // after a reload the loss may already be in the journal: do not write it twice
      const last = events.filter((e) => e.kind === 'stream' && e.camera === src.name).sort((x, y) => y.at - x.at)[0]
      if (last && last.type !== 'STREAM_ONLINE') {
        m.lost = { at: last.at, written: Promise.resolve(true) }
        continue
      }
      const stale = src.status === 'stale'
      const type = m.live ? 'STREAM_LOST' : 'STREAM_OFFLINE'
      const title = stale ? `Кадр не меняется: ${src.name}` : m.live ? `Потеря видеопотока: ${src.name}` : `Нет видеопотока: ${src.name}`
      const msg = src.message ? ` ${src.message.replace(/[.\s]*$/, '.')}` : ''
      const what = stale
        ? `кадр с камеры «${src.name}» не меняется с ${hhmmss(src.since)}.`
        : m.live
          ? `камера «${src.name}» перестала присылать кадры в ${hhmmss(src.since)}.${msg}`
          : `с начала наблюдения камера «${src.name}» не присылает кадров.${msg}`
      const lost: { at: number; written: Promise<boolean> } = { at: src.since, written: Promise.resolve(false) }
      lost.written = write(src, type, src.since, title, what, `кадры дают ${liveN} из ${total} источников. Пока кадров нет, по зоне этой камеры вывод об отсутствии техники не делается.`).catch(() => {
        // the server did not take it: try again on a later pass
        if (m.lost === lost) m.lost = undefined
        return false
      })
      m.lost = lost
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
  const rightsOf = (e: UiEvent) => rightsFor(e, user, project?.owner_username)
  // The server keeps no way back to "ждёт решения". So a swipe answers on screen at once and
  // leaves for the server only when its undo has expired; until then "Отменить" simply keeps it.
  const sending = useRef(new Map<string, { status: EventStatus; timer: number }>())
  const keepUnsent = (e: UiEvent, old: UiEvent[]) => {
    const w = sending.current.get(e.id)
    return w ? { ...e, status: w.status, decidedAt: old.find((x) => x.id === e.id)?.decidedAt ?? Date.now() } : e
  }
  const sendDecision = async (id: string, status: EventStatus) => {
    const res = await api.setIncidentStatus(id, status)
    setEvents((l) => l.map((e) => (e.id === id ? { ...toEvent(res, api.mediaUrl), decidedAt: Date.now() } : e)))
  }
  const decideSoon = (id: string, status: EventStatus) => {
    const before = events.find((e) => e.id === id)
    if (!before || before.sample || sending.current.has(id)) return
    setEvents((l) => l.map((e) => (e.id === id ? { ...e, status, decidedAt: Date.now() } : e)))
    // a little longer than the toast, so the undo is gone before the decision leaves
    const timer = window.setTimeout(() => {
      sending.current.delete(id)
      sendDecision(id, status).catch((e: Error) => {
        setEvents((l) => l.map((x) => (x.id === id ? before : x)))
        toast(`Решение не сохранено: ${e.message}`, { error: true, retry: () => decideSoon(id, status) })
      })
    }, 7200)
    sending.current.set(id, { status, timer })
    toast(`${STATUS_WORD[status]} · ${before.code}`, {
      undo: () => {
        clearTimeout(timer)
        sending.current.delete(id)
        setEvents((l) => l.map((x) => (x.id === id ? before : x)))
      },
    })
  }
  /** The case file waits for the server, so "Сохраняем…" and a refusal stay visible there. */
  const decideNow = async (id: string, status: EventStatus) => {
    const before = events.find((e) => e.id === id)
    if (!before || before.sample) return
    await sendDecision(id, status)
    toast(status === 'resolved' ? `Проверка исправления запрошена · ${before.code}` : `${STATUS_WORD[status]} · ${before.code}`)
  }
  // decisions still waiting for their undo leave with the page, or before signing out
  const flushSending = () => {
    for (const [id, w] of sending.current) {
      clearTimeout(w.timer)
      void api.setIncidentStatus(id, w.status, true).catch(() => undefined)
    }
    sending.current.clear()
  }
  useEffect(() => {
    addEventListener('pagehide', flushSending)
    return () => removeEventListener('pagehide', flushSending)
  })

  /* tasks */
  const unread = alerts.filter((a) => !a.read_at).length
  const readAlert = (a: ApiAlert) => {
    if (a.read_at) return
    setAlerts((l) => l.map((x) => (x.id === a.id ? { ...x, read_at: new Date().toISOString() } : x)))
    api.markAlertRead(a.id).catch(() => undefined)
  }
  /** A task opens its event: here, or after switching to its object. */
  const openAlert = (a: ApiAlert) => {
    readAlert(a)
    setMenu(null)
    if (a.project_id === project?.id) {
      if (events.some((e) => e.id === a.incident_id)) setCaseOpen({ id: a.incident_id, origin: null })
      else toast(`${a.incident_code} нет среди последних ${api.JOURNAL_LIMIT} событий объекта`, { error: true })
    } else if (visible.some((p) => p.id === a.project_id)) {
      wantCase.current = a.incident_id
      setProjectId(a.project_id)
      setCreating(false)
    } else toast(`${a.incident_code}: объект недоступен в вашем списке. ${a.body}`, { error: true })
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
  /** Every manual change of the stage at once: levels back on the server, local marks dropped. */
  const resetStage = async (stageId: string) => {
    const local = localRules.get(stageId) ?? loadLocalRules(stageId)
    const back: Record<string, string> = {}
    for (const code of Object.keys(local) as Code[]) {
      const rec = local[code]!
      const serverLvl = apiLevel(stageId, code)
      if (serverLvl && rec.base !== 'skip' && serverLvl !== rec.base) back[MACH[code].api] = LV_TO_CLS[rec.base]
    }
    try {
      if (Object.keys(back).length) {
        const res = await api.putOverrides(stageId, back)
        setApiProfiles((m) => new Map(m).set(stageId, res))
      }
      writeLocal(stageId, {})
      toast('Правила этапа возвращены к исходным уровням')
    } catch (e) {
      toast(`Не удалось вернуть правила: ${(e as Error).message}`, { error: true })
    }
  }
  const apiLevel = (stageId: string, code: Code): Level | null => {
    const p = apiProfiles.get(stageId)
    if (!p) return null
    return toProfile(p, settings).rules[code].lvl
  }

  /* sources */
  const addCamera = async (name: string, url: string, zoneId?: string | null, code?: string) => {
    if (!project) return
    const cam = await api.createCamera(project.id, { name, code: code || undefined, stream_url: url, zone_id: zoneId === undefined ? zones[0]?.id ?? null : zoneId })
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
  const updateCamera = async (id: string, name: string, url: string, zoneId: string | null, code?: string) => {
    if (!project) return
    const cam = await api.updateCamera(project.id, id, { name, code: code || undefined, stream_url: url, zone_id: zoneId })
    const next = cameras.map((c) => (c.id === id ? cam : c))
    setCameras(next)
    engine.setCameras(next)
    toast(`Камера «${cam.name}» сохранена`)
  }

  /* the object itself */
  const updateProject = async (d: { name: string; code: string; address: string; object_kind: string }) => {
    if (!project) return
    const res = await api.updateProject(project.id, d)
    setProjects((l) => (l || []).map((p) => (p.id === res.id ? { ...p, ...res, owner_username: p.owner_username } : p)))
    if (weather && (d.address || '').trim() !== (project.address || '').trim()) loadWeather(project.id, loadToken.current, true)
  }
  const deleteProject = async () => {
    if (!project) return
    const gone = project
    await api.deleteProject(gone.id)
    setSheet(null)
    const rest = (projects || []).filter((p) => p.id !== gone.id)
    setProjects(rest)
    const next = rest.find((p) => user.role === 'admin' || !p.owner_username || p.owner_username === user.username)
    setProjectId(next?.id ?? null)
    toast(`Объект «${gone.name}» удалён`)
  }
  const createZone = async (d: { name: string; code: string; description: string }) => {
    if (!project) return
    const z = await api.createZone(project.id, { name: d.name, code: d.code || undefined, description: d.description || undefined })
    setZones((l) => [...l, z])
  }
  const updateZone = async (id: string, d: { name: string; code: string; description: string }) => {
    if (!project) return
    const z = await api.updateZone(project.id, id, d)
    setZones((l) => l.map((x) => (x.id === id ? z : x)))
  }
  const deleteZone = async (id: string) => {
    if (!project) return
    try {
      await api.deleteZone(project.id, id)
      setZones((l) => l.filter((x) => x.id !== id))
      // the server unlinks the cameras of the zone (ON DELETE SET NULL)
      setCameras((l) => l.map((c) => (c.zone_id === id ? { ...c, zone_id: null } : c)))
    } catch (e) {
      toast((e as Error).message, { error: true })
    }
  }
  /** The zone an event belongs to: the zone of the camera it was seen on. */
  const zoneOf = (sourceId?: string) => {
    const cam = cameras.find((c) => c.id === sourceId)
    const z = zones.find((x) => x.id === cam?.zone_id)
    return z?.name ?? (zones.length === 1 ? zones[0].name : null)
  }
  const zoneIdOf = (sourceId?: string) => {
    const cam = cameras.find((c) => c.id === sourceId)
    return zones.find((x) => x.id === cam?.zone_id)?.id ?? (zones.length === 1 ? zones[0].id : null)
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

  /* plan dates: one PUT per changed stage, then the plan is read back from the server */
  const writeDates = async (list: { id: string; start: number; end: number }[]) => {
    if (!project) return
    const id = project.id
    await Promise.all(list.map((c) => api.updateStage(c.id, { planned_start: isoDay(c.start), planned_end: isoDay(c.end), duration_days: Math.round((c.end - c.start) / DAY_MS) + 1 })))
    const fresh = await api.stages(id)
    if (project?.id === id) setStages(toStages(fresh))
  }
  const saveSchedule = async (changes: { id: string; start: number; end: number }[]) => {
    const before = changes.map((c) => {
      const s = stages.find((x) => x.id === c.id)!
      return { id: c.id, start: s.start, end: s.end }
    })
    const main = stages.find((x) => x.id === changes[0]?.id)
    await writeDates(changes)
    const others = changes.length - 1
    toast(`Сроки этапа ${main?.n ?? ''} сохранены${others ? ` · ещё ${others} ${plural(others, 'этап сдвинут', 'этапа сдвинуты', 'этапов сдвинуты')}` : ''}`, {
      undo: () =>
        void writeDates(before).then(
          () => toast('Сроки возвращены'),
          (e: Error) => toast(`Не удалось вернуть сроки: ${e.message}`, { error: true }),
        ),
    })
  }
  const clearPlan = async () => {
    if (!project) return
    try {
      await api.clearPlan(project.id)
      setStages([])
      setApiProfiles(new Map())
      setDockOpen(false)
      toast('План очищен. Загрузите новый план, чтобы продолжить сверку.')
    } catch (e) {
      toast((e as Error).message, { error: true })
    }
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
      if (covered || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || caseOpen || rule || sheet || journal) return
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

  // flights from the camera to the queue would cross the journal: keep them under it
  useEffect(() => {
    document.body.dataset.journal = journal ? 'open' : ''
  }, [journal])

  const caseEvent = caseOpen ? events.find((e) => e.id === caseOpen.id) : null
  const caseStage = caseEvent ? stages.find((s) => s.id === caseEvent.stageId) ?? stageAt(stages, caseEvent.at) : null
  const ruleStage = rule ? stages.find((s) => s.id === rule.stageId) : null
  const ruleProf = rule ? profiles.get(rule.stageId) : null
  const setupVisible = setupOpen || (loaded && !project)
  const pending = events.filter((e) => e.status === 'pending' && e.kind !== 'stream')

  return (
    <div className="app" id="app">
      <header className="bar">
        <button type="button" className="brand brand-btn" onClick={onIntro} aria-label="Заставка" title="Заставка">
          СК
        </button>
        <button type="button" className="ctx" onClick={(e) => setMenu({ kind: 'project', anchor: e.currentTarget.getBoundingClientRect() })} aria-haspopup="menu">
          <small>Объект</small>
          <span>{project?.name || 'Новый объект'}</span>
        </button>
        {zones.length > 0 && (
          <>
            <span className="slash" aria-hidden="true">
              /
            </span>
            <button type="button" className="ctx" id="ctxZone" onClick={() => setSheet('object')} title="Зоны площадки">
              <small>Зона</small>
              <span className="no-caret">{zones.length === 1 ? zones[0].name : `${zones.length} ${plural(zones.length, 'зона', 'зоны', 'зон')}`}</span>
            </button>
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
        {alerts.length > 0 && (
          <button type="button" className="icon-btn tasks-btn" onClick={(e) => setMenu({ kind: 'tasks', anchor: e.currentTarget.getBoundingClientRect() })} aria-haspopup="menu" aria-label={unread ? `Задачи: ${unread} ${plural(unread, 'новая', 'новые', 'новых')}` : 'Задачи'} title="Задачи">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z" />
              <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
            </svg>
            {unread > 0 && <span className="t-count">{unread > 9 ? '9+' : unread}</span>}
          </button>
        )}
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
            rightsOf={rightsOf}
            onOpen={(id, el) => setCaseOpen({ id, origin: el.getBoundingClientRect() })}
            onDecide={(id, status) => decideSoon(id, status)}
            onJournal={(el) => setJournal({ origin: el.getBoundingClientRect() })}
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
        onResetStage={resetStage}
        onOpenEvent={(id, el) => setCaseOpen({ id, origin: el.getBoundingClientRect() })}
        onUploadPlan={(f) => {
          if (!project) return
          importPlan(() => api.uploadPlan(project.id, f)).then(
            (r) => toast(`План загружен: ${r.total_stages_imported} этапов, сопоставлено ${r.matched_catalog_count}`),
            (e: Error) => toast(e.message, { error: true }),
          )
        }}
        onSaveSchedule={saveSchedule}
        onClearPlan={clearPlan}
        onSeek={(v) => engine.seek(v)}
        open={dockOpen}
        setOpen={setDockOpen}
        shift={{ from: settings.shiftFrom, to: settings.shiftTo }}
        weather={weather}
      />

      {journal && project && (
        <Journal
          events={events}
          stages={stages}
          project={project}
          user={user.username}
          settings={settings}
          t={t}
          origin={journal.origin}
          onOpen={(id, el) => setCaseOpen({ id, origin: el.getBoundingClientRect() })}
          onClose={() => setJournal(null)}
        />
      )}
      {caseEvent && (
        <CaseFile
          key={caseEvent.id}
          ev={caseEvent}
          ep={episodes.get(caseEvent.id)}
          stage={caseStage}
          prof={caseStage ? profiles.get(caseStage.id) ?? null : null}
          obs={obs}
          origin={caseOpen!.origin}
          rights={rightsOf(caseEvent)}
          user={user}
          admins={admins}
          onClose={() => setCaseOpen(null)}
          onDecide={(status) => decideNow(caseEvent.id, status)}
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
          user={user}
          admins={admins}
          weather={weather}
          tasks={{
            load: () => api.alertSettings(project.id),
            save: async (d) => {
              const r = await api.saveAlertSettings(project.id, d)
              setProjects((l) => (l || []).map((p) => (p.id === r.project_id ? { ...p, ...r } : p)))
              return r
            },
            saveEmail: async (email) => onUser(await api.setMyEmail(email)),
          }}
          objectActions={{
            counts: { stages: stages.length, events: events.filter((e) => !e.sample).length },
            onUpdateProject: updateProject,
            onDeleteProject: deleteProject,
            onCreateZone: createZone,
            onUpdateZone: updateZone,
            onDeleteZone: deleteZone,
            onUpdateCamera: updateCamera,
          }}
        />
      )}
      {menu && (
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} wide={menu.kind === 'tasks'}>
          {menu.kind === 'tasks' ? (
            <TaskList alerts={alerts} projects={visible} current={project?.id ?? null} onOpen={openAlert} />
          ) : menu.kind === 'project' ? (
            <>
              <div className="m-k kicker">Объекты</div>
              {visible.map((p) => (
                <button key={p.id} type="button" className="m-item" role="menuitemradio" aria-checked={p.id === project?.id} onClick={() => { setProjectId(p.id); setCreating(false); setMenu(null) }}>
                  <span className="chk">✓</span>
                  <span>
                    <b>{p.name}</b>
                    <small>{[p.object_kind, p.address, user.role === 'admin' && p.owner_username ? `владелец ${p.owner_username}` : ''].filter(Boolean).join(' · ') || p.code}</small>
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
              <div className="m-k kicker">{user.username} · {ROLE_LABEL.toLowerCase()}</div>
              <button type="button" className="m-item" role="menuitem" onClick={() => { setMenu(null); setJournal({ origin: menu.anchor }) }}>
                <span />
                <span><b>Журнал и акт</b><small>События за период, выгрузка акта</small></span>
              </button>
              <button type="button" className="m-item" role="menuitem" onClick={() => { setMenu(null); setSetupOpen(true) }}>
                <span />
                <span><b>Первый запуск</b><small>План, источники, проверка</small></span>
              </button>
              <button type="button" className="m-item" role="menuitem" onClick={() => { setMenu(null); onIntro() }}>
                <span />
                <span><b>Заставка</b><small>Стартовый экран с ролью</small></span>
              </button>
              <a className="m-item" role="menuitem" href="#legacy" onClick={() => setTimeout(() => location.reload(), 0)}>
                <span />
                <span><b>Старый интерфейс</b><small>Для сравнения</small></span>
              </a>
              <div className="m-sep" />
              <ThemeRow />
              <div className="m-sep" />
              <button type="button" className="m-item" role="menuitem" onClick={() => { flushSending(); onLogout() }}>
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

function Menu({ anchor, onClose, children, wide = false }: { anchor: DOMRect; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  const el = useRef<HTMLDivElement>(null)
  // the app re-renders on every camera frame and passes a fresh onClose each time; the menu must
  // open once per anchor, not replay its entrance (and grab focus) on every frame
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useLayoutEffect(() => {
    const close = () => closeRef.current()
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
    m.querySelector<HTMLElement>('.m-item[aria-checked="true"], .m-item')?.focus()
    const down = (e: PointerEvent) => !m.contains(e.target as Node) && close()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
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
  }, [anchor])
  return (
    <div className={`menu${wide ? ' wide' : ''}`} ref={el} role="menu" style={{ opacity: 0 }}>
      {children}
    </div>
  )
}

const THEMES: { v: ThemePref; label: string }[] = [
  { v: 'auto', label: 'Авто' },
  { v: 'light', label: 'Светлая' },
  { v: 'dark', label: 'Тёмная' },
]

/** Light or dark, or as the system says; the new colours spread from the button that was pressed. */
function ThemeRow() {
  const pref = useThemePref()
  return (
    <div className="m-theme">
      <span>Тема</span>
      <Seg
        label="Тема"
        value={pref}
        options={THEMES}
        onChange={(v, el) => {
          const r = el.getBoundingClientRect()
          setThemePref(v, { x: r.left + r.width / 2, y: r.top + r.height / 2 })
        }}
      />
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
