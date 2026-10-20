import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as api from './api'
import type { AdminRecipient, ApiProfile, CameraItem, ProjectItem, UserProfile, ZoneItem } from './api'
import { Engine } from './engine'
import { isSharedDemoProject, recordingAnalysisLabel, sourceCamera, visibleProjects } from './projectScope'
import type { Episode, EventStatus, Level, LocalRules, Observation, Settings, SourceView, Stage, UiEvent, VerdictAction } from './model'
import { DEFAULTS, LV_TO_CLS, STATUS_WORD, evaluate, isOpen, loopBlocked, viewBlocked, loadLocalRules, loadSettings, saveLocalRules, saveSettings, stageAt, toEvent, toProfile, toStages, verdictOf } from './model'
import { PROBLEM_WORD, turnWords } from './lib/view'
import { CODES, MACH, toCode, type Code } from './lib/machinery'
import { DAY_MS, durShort, fmtDay, hhmm, hhmmss, isoDay, plural } from './lib/format'
import { Spring, clamp, lerp } from './lib/spring'
import { Seg, ToastProvider, useToast } from './parts/common'
import { setThemePref, useThemePref, type ThemePref } from './lib/theme'
import { Verdict } from './parts/Verdict'
import { Stage as StageView } from './parts/Stage'
import { MyVmsDemo } from './parts/MyVmsDemo'
import { Recon } from './parts/Recon'
import { Dock } from './parts/Dock'
import { CaseFile } from './parts/CaseFile'
import { RuleEditor } from './parts/RuleEditor'
import { SettingsSheet, type SheetTab, type ViewActions } from './parts/Settings'
import { Setup } from './parts/Setup'
import { Auth } from './parts/Auth'
import { Journal } from './parts/Journal'
import { Intro, Showcase } from './parts/Intro'
import { PprDocuments } from './parts/PprDocuments'
import { pprCitationFingerprint } from './pprApi'
import { CustomerWorkspace, roleName, contextKey, can, canReadFullPlan, type WorkspaceAccess } from './parts/CustomerWorkspace'
import { CustomerPanel, type CustomerSection } from './parts/CustomerPanel'
import { CustomerCases } from './parts/CustomerCases'
import { participants, savedVideoPlayback, type ParticipantOptionsDTO } from './customerApi'

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
  const onAuth = useCallback((u: UserProfile) => {
    setOffline(null)
    setUser(u)
  }, [])
  useEffect(() => {
    let alive = true
    api.me().then((u) => { if (alive) setUser(u) }, (e: Error) => {
      if (!alive) return
      setOffline(e.message)
      setUser(null)
    })
    return () => { alive = false }
  }, [])
  // sign-in and the intro share one backdrop, so the drawing carries over from one to the other
  const showcase = user === null || (!!user && intro !== 'off')
  return (
    <ToastProvider>
      {user === undefined ? (
        <div className="auth" aria-busy="true" />
      ) : (
        <CustomerWorkspace
          user={user}
          onLogout={() => { api.logout(); setUser(null); setIntro('on'); setEntered(false) }}
          renderWorkspace={(access) => user && <Workspace user={user} onUser={setUser} covered={intro === 'on'} onIntro={showIntro} onLogout={() => { api.logout(); setUser(null); setIntro('on'); setEntered(false) }} {...access} />}
          render={(access, workspace) => <>
            {user && entered && <div className="ws-host" inert={intro === 'on'}>{workspace}</div>}
            {showcase && <Showcase mode={user ? 'intro' : 'auth'} leaving={!!user && intro === 'leaving'} onGone={dropIntro}>
              {user ? <Intro user={user} access={access} leaving={intro === 'leaving'} onContinue={leaveIntro} /> : <Auth onAuth={onAuth} offline={offline} />}
            </Showcase>}
          </>}
        />
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
      engine.dispose()
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

function Workspace({ user, onUser, covered, onIntro, onLogout, context, contexts, onContextChange, onRefreshAccess, accessLoading, accessError }: { user: UserProfile; onUser: (u: UserProfile) => void; covered: boolean; onIntro: () => void; onLogout: () => void } & WorkspaceAccess) {
  const toast = useToast()
  const canManageControl = !context.is_demo && context.lifecycle === 'active' && context.effective_permissions.includes('camera.configure')
  const canReadSources = can(context, 'camera.read') || can(context, 'video.read')
  const canUploadVideo = !context.is_demo && context.lifecycle === 'active' && context.effective_permissions.includes('video.upload')
  const [uploadAreaId, setUploadAreaId] = useState(context.scope.kind === 'areas' && context.scope.area_ids.length === 1 ? context.scope.area_ids[0] : '')
  const [assignmentOptions, setAssignmentOptions] = useState<ParticipantOptionsDTO | null>(null)
  const [liveDemoProject, setLiveDemoProject] = useState<string | null>(null)
  const showLiveDemo = context.is_demo && liveDemoProject === context.project_id
  const [engine] = useState(() => new Engine())
  engine.inferenceEnabled = !context.is_demo && context.lifecycle === 'active' && can(context, 'video.analyze')
  const obs = useObservation(engine)

  const [projects, setProjects] = useState<ProjectItem[] | null>(null)
  const [projectId, setProjectId] = useState<string | null>(context.project_id)
  const [zones, setZones] = useState<ZoneItem[]>([])
  const [cameras, setCameras] = useState<CameraItem[]>([])
  const [views, setViews] = useState<api.CameraViewState[]>([])
  const [savedVideos, setSavedVideos] = useState<api.SavedVideo[]>([])
  const [savedVideoId, setSavedVideoId] = useState('')
  const [videosError, setVideosError] = useState<string | null>(null)
  const [recordingUploadError, setRecordingUploadError] = useState<string | null>(null)
  const [stages, setStages] = useState<Stage[]>([])
  const [loadedProject, setLoadedProject] = useState<{ id: string; token: number } | null>(null)
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
  const [safetyRecordingCameraId, setSafetyRecordingCameraId] = useState('')
  const [sheet, setSheet] = useState<SheetTab | null>(null)
  const [pprOpen, setPprOpen] = useState(false)
  const [customerSection, setCustomerSection] = useState<CustomerSection | null>(context.role === 'pto_engineer' ? 'documents' : null)
  const canReadPlan = canReadFullPlan(context)
  const [journal, setJournal] = useState<{ origin: DOMRect | null } | null>(null)
  const [setupOpen, setSetupOpen] = useState(false)
  const [menu, setMenu] = useState<null | { kind: 'project' | 'user'; anchor: DOMRect }>(null)
  // the forecast for the object's address; null where the server has none
  const [weather, setWeather] = useState<api.Weather | null>(null)
  const [admins, setAdmins] = useState<AdminRecipient[]>([])
  // an event to open once its object has loaded (a task of another object)
  const wantCase = useRef<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [projectsError, setProjectsError] = useState<string | null>(null)
  const [projectsRetry, setProjectsRetry] = useState(0)
  const [projectRetry, setProjectRetry] = useState(0)
  const [creating, setCreating] = useState(false)
  const loadToken = useRef(0)
  const renderScopeToken = loadToken.current
  const meta = useRef(new Map<string, { kind: 'missing' | 'oop'; code: Code; stageId: string; pprSignature: string }>())
  // per camera: was it live in this session, and the loss we are writing (resolves true once it is in the journal)
  const signal = useRef(new Map<string, { live: boolean; lost?: { at: number; written: Promise<boolean> } }>())
  const created = useRef(new Map<string, string | number>())
  // camera id → the open loop event, "pending" while it is being written, or when to try again
  const loopSent = useRef(new Map<string, string | number>())
  // camera id → the open view event, "pending" while it is being written, or when to try again
  const viewSent = useRef(new Map<string, string | number>())
  const lastSaveError = useRef(0)
  const videoSessionTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const videoRequest = useRef<AbortController | null>(null)
  const playSavedVideo = async (video: api.SavedVideo) => {
    videoRequest.current?.abort()
    if (videoSessionTimer.current) clearTimeout(videoSessionTimer.current)
    const controller = new AbortController(); videoRequest.current = controller
    const scopeToken = loadToken.current
    let recovering = false
    let recoveryAttempts = 0
    const valid = () => !controller.signal.aborted && scopeToken === loadToken.current
    const renew = async (restore = false) => {
      if (recovering || !valid()) return
      recovering = true
      try {
        const session = await savedVideoPlayback(video.video_id, controller.signal)
        if (!valid()) return
        if (restore) engine.refreshRecordingSession()
        videoSessionTimer.current = setTimeout(() => void renew(), Math.max(10_000, Date.parse(session.expires_at) - Date.now() - 60_000))
      } catch (error) { if (valid()) { engine.stopRecording(); setVideosError(error instanceof Error ? error.message : 'Сессия воспроизведения недоступна.') } }
      finally { recovering = false }
    }
    try {
      const session = await savedVideoPlayback(video.video_id, controller.signal)
      if (!valid()) return
      engine.startRecordingUrl(session.media_url, video.filename, Date.parse(video.start_timestamp), { credentials: true, onPlaybackError: () => { if (recoveryAttempts++ < 1) void renew(true) }, onPlaybackReady: () => { recoveryAttempts = 0 } })
      videoSessionTimer.current = setTimeout(() => void renew(), Math.max(10_000, Date.parse(session.expires_at) - Date.now() - 60_000))
      engine.setSafetyRecordingCamera(video.camera_id || undefined)
      setSafetyRecordingCameraId(video.camera_id || ''); setSavedVideoId(video.video_id); setSelected('recording'); setSetupOpen(false)
    } catch (error) { if (valid()) setVideosError(error instanceof Error ? error.message : 'Не удалось открыть запись.') }
  }
  useEffect(() => {
    const controller = new AbortController()
    if (canUploadVideo) participants(context.project_id, controller.signal).then(setAssignmentOptions, () => undefined)
    return () => { controller.abort(); videoRequest.current?.abort(); if (videoSessionTimer.current) clearTimeout(videoSessionTimer.current) }
  }, [context.project_id, canUploadVideo])
  useEffect(() => {
    // A gap or integrity change ends qualified timing, without closing historical server cases.
    setEpisodes(new Map())
    meta.current.clear()
    created.current.clear()
  }, [obs.evaluationRevision])

  const visible = useMemo(() => (projects || []).filter(item => item.id === context.project_id), [projects, context.project_id])
  const project = creating ? null : visible.find((p) => p.id === projectId) ?? visible[0] ?? null
  const isLoaded = () => !!project && loadedProject?.id === project.id && loadedProject.token === loadToken.current
  const loaded = isLoaded()
  const currentScope = () => {
    const token = loadToken.current
    return () => token === loadToken.current
  }

  /* projects */
  useEffect(() => {
    let alive = true
    setProjectsError(null)
    api.projects().then(
      (p) => { if (alive) setProjects(p) },
      (e: Error) => { if (alive) setProjectsError(e.message) },
    )
    return () => { alive = false }
  }, [projectsRetry])
  useEffect(() => {
    if (can(context, 'assignment.manage')) api.admins().then(setAdmins, () => undefined)
  }, [])

  /* everything below belongs to one object; a late answer for a previous object is dropped */
  useEffect(() => {
    const token = ++loadToken.current
    videoRequest.current?.abort()
    if (videoSessionTimer.current) { clearTimeout(videoSessionTimer.current); videoSessionTimer.current = null }
    engine.reset()
    engine.safetyProjectId = project?.id
    setSafetyRecordingCameraId('')
    setZones([])
    setCameras([])
    setViews([])
    viewSent.current.clear()
    setSavedVideos([])
    setSavedVideoId('')
    setVideosError(null)
    setRecordingUploadError(null)
    setStages([])
    setApiProfiles(new Map())
    setEvents([])
    setEpisodes(new Map())
    meta.current.clear()
    created.current.clear()
    signal.current.clear()
    loopSent.current.clear()
    setLoadedProject(null)
    setLoadError(null)
    setSelected(null)
    setCaseOpen(null)
    setRule(null)
    setJournal(null)
    setSheet(null)
    setDockOpen(false)
    setSetupOpen(false)
    setWeather(null)
    const invalidate = () => { ++loadToken.current }
    if (!project) {
      if (projects) setSetupOpen(true)
      return invalidate
    }
    store.set('sverka:project', project.id)
    const local = loadSettings(project.id, isSharedDemoProject(project))
    setSettingsState(local)
    Promise.all([api.zones(project.id), can(context, 'camera.read') ? api.cameras(project.id) : Promise.resolve([]), canReadPlan ? api.stages(project.id) : Promise.resolve([]), can(context, 'incident.read') ? api.incidents(project.id) : Promise.resolve([]), canReadPlan ? api.incidentConfig().catch(() => null) : Promise.resolve(null), can(context, 'video.read') ? api.savedVideos(project.id).catch((e: Error) => {
      if (token === loadToken.current) setVideosError(e.message)
      return [] as api.SavedVideo[]
    }) : Promise.resolve([] as api.SavedVideo[])])
      .then(([z, c, s, inc, cfg, videos]) => {
        if (token !== loadToken.current) return
        setZones(z)
        setCameras(c)
        engine.setCameras(c)
        if (can(context, 'camera.read')) loadViews(project.id, token)
        setSavedVideos(videos)
        if (videos.length) {
          const first = videos[0]
          void playSavedVideo(first)
        }
        setStages(toStages(s))
        setEvents((old) => inc.map((i) => keepUnsent(toEvent(i, api.mediaUrl), old)))
        if (cfg) setSettingsState((x) => ({ ...x, window: cfg.violation_evaluation_window_seconds }))
        setLoadedProject({ id: project.id, token })
        setLoadError(null)
        const want = wantCase.current
        wantCase.current = null
        if (want && inc.some((i) => i.id === want)) setCaseOpen({ id: want, origin: null })
        else if (canManageControl && (!s.length || (!c.length && !videos.length))) setSetupOpen(false)
      })
      .catch((e: Error) => {
        if (token !== loadToken.current) return
        setLoadError(e.message)
      })
    if (canReadPlan) loadWeather(project.id, token)
    return invalidate
  }, [project?.id, projects == null, projectRetry])

  /* camera views: a server without them answers 404 and the comparison simply does not run */
  const loadViews = (id: string, token: number) =>
    api.cameraViews(id).then(
      (v) => {
        if (token !== loadToken.current) return
        setViews(v)
      },
      () => undefined,
    )

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
        if (!fresh && canManageControl && w.location_configured && (w.days.length < 7 || !w.resolved_address)) loadWeather(id, token, true)
      })
      .catch((e) => {
        // the server has no forecast at all: do not ask again in this session
        if (!fresh && e instanceof api.ApiError && e.status === 404) noWeather.current = true
      })
  }

  /* refresh the journal now and then: decisions of others, deadlines, the server's rechecks */
  useEffect(() => {
    if (!project || !loaded || !can(context, 'incident.read')) return
    const id = project.id
    const isCurrent = currentScope()
    const timer = window.setInterval(() => {
      api.incidents(id).then((inc) => {
        if (!isCurrent()) return

        setEvents((old) => inc.map((i) => keepUnsent(toEvent(i, api.mediaUrl), old)))
      }, () => undefined)
      // approvals made by the administrator elsewhere
      loadViews(id, loadToken.current)
    }, 15_000)
    return () => clearInterval(timer)
  }, [project, loaded])


  useEffect(() => {
    if (!project || !can(context, 'video.read')) return
    const id = project.id
    const token = loadToken.current
    let active = true
    const timer = window.setInterval(() => {
      api.savedVideos(id).then((videos) => {
        if (!active || token !== loadToken.current) return
        setSavedVideos(videos)
        setVideosError(null)
      }, (error: Error) => {
        if (active && token === loadToken.current) setVideosError(error.message)
      })
    }, 30_000)
    return () => { active = false; clearInterval(timer) }
  }, [project?.id])

  const setSettings = (s: Settings) => {
    const prev = settings
    setSettingsState(s)
    if (project) saveSettings(project.id, s, isSharedDemoProject(project))
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
  engine.windowMs = settings.window * 1000
  engine.stageName = stage?.name

  // the server computes a profile per request (seconds each): never ask twice for the same stage
  const inflight = useRef(new Map<string, number>())
  const profileGeneration = useRef(0)
  const profileCache = useRef(apiProfiles)
  profileCache.current = apiProfiles
  const pprRefreshInFlight = useRef(false)
  const pprControlRevision = useRef<{ projectId: string; revision: string | null }>({ projectId: '', revision: null })

  const loadProfile = useCallback(
    (stageId: string) => {
      const token = loadToken.current
      if (apiProfiles.has(stageId) || inflight.current.get(stageId) === token) return Promise.resolve()
      inflight.current.set(stageId, token)
      const generation = profileGeneration.current

      return api
        .profile(stageId)
        .then(
          (p) => {
            if (token !== loadToken.current || generation !== profileGeneration.current) return
            setApiProfiles((m) => new Map(m).set(stageId, p))
          },
          (e: Error) => { if (token === loadToken.current) toast(`Профиль этапа не загрузился: ${e.message}`, { error: true }) },
        )
        .finally(() => { if (inflight.current.get(stageId) === token) inflight.current.delete(stageId) })
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

  const refreshPprProfiles = useCallback(async () => {
    if (pprRefreshInFlight.current || !project) return
    const ids = [...new Set([...profileCache.current.keys(), ...inflight.current.keys(), ...(stage ? [stage.id] : [])])]
    if (!ids.length) return
    pprRefreshInFlight.current = true
    const token = loadToken.current
    const generation = ++profileGeneration.current
    try {
      const [refreshed, controlRevision] = await Promise.all([Promise.all(ids.map(async id => [id, await api.profile(id)] as const)), api.pprControlRevision(project.id)])
      if (token !== loadToken.current || generation !== profileGeneration.current) return
      pprControlRevision.current = { projectId: project.id, revision: controlRevision.revision }
      const changed = refreshed.some(([id, value]) => (profileCache.current.get(id)?.ppr_revision || '') !== (value.ppr_revision || ''))
      if (changed) {
        engine.resetEvaluationWindow()
        setEpisodes(new Map())
        meta.current.clear()
        created.current.clear()
      }
      setApiProfiles(previous => {
        const next = new Map(previous)
        for (const [id, value] of refreshed) next.set(id, value)
        return next
      })
    } catch (error) {
      if (token === loadToken.current) toast(`Не удалось обновить требования ППР: ${(error as Error).message}`, { error: true })
    } finally { pprRefreshInFlight.current = false }
  }, [engine, project?.id, stage?.id, toast])
  useEffect(() => {
    if (!project || !stage) return
    const controller = new AbortController()
    const projectId = project.id
    if (pprControlRevision.current.projectId !== projectId) pprControlRevision.current = { projectId, revision: null }
    let inFlight = false
    const check = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const result = await api.pprControlRevision(projectId, controller.signal)
        if (controller.signal.aborted) return
        const previous = pprControlRevision.current
        if (previous.projectId === projectId && previous.revision !== null && previous.revision !== result.revision) await refreshPprProfiles()
        else pprControlRevision.current = { projectId, revision: result.revision }
      } catch { /* A transient background poll must not replace visible rules or emit repeated notices. */ }
      finally { inFlight = false }
    }
    void check()
    const timer = window.setInterval(() => void check(), 15_000)
    return () => { controller.abort(); clearInterval(timer) }
  }, [refreshPprProfiles, project?.id, stage?.id])

  const ev = evaluate(obs, stage, prof, settings)
  const activeSavedVideo = savedVideos.find(video => video.video_id === savedVideoId)
  const verdict = loaded ? obs.mode === 'recording'
    ? { tone: 'none' as const, title: 'Серверная проверка записи', sub: recordingUploadError ? `Запись не сохранена: ${recordingUploadError}. Серверная проверка недоступна; плеер показывает распознавание текущего кадра.` : `${activeSavedVideo ? recordingAnalysisLabel(activeSavedVideo.analysis_status) + '. ' : 'Запись сохраняется для серверной проверки. '}Сервер сопоставляет записи камер вместе. Результаты проверки появляются в журнале; плеер показывает распознавание текущего кадра.` }
    : !canReadPlan ? { tone: 'none' as const, title: context.is_demo ? 'Демонстрация · только просмотр' : context.role === 'pto_engineer' ? 'Документы и требования' : 'Контроль в пределах назначения', sub: context.is_demo ? 'Доступны опубликованные источники и исторические дела. Изменения в общей демонстрации отключены.' : context.role === 'pto_engineer' ? 'Проверяйте цитаты и область применения. Требования включает в контроль управляющий заказчика.' : 'Очередь показывает доступные вам дела. Полный план объекта не входит в текущую область доступа.', actions: [{ label: context.role === 'pto_engineer' ? 'Открыть документы' : context.role === 'contractor_foreman' ? 'Мои задачи' : 'Доступные дела', act: context.role === 'pto_engineer' ? 'customer-documents' : 'customer-cases', primary: true }] }
    : verdictOf({ ev, obs, events, episodes, prof, hasPlan: stages.length > 0, s: settings }) : { tone: 'none' as const, title: 'Загружаем объект', sub: loadError || 'Получаем доступные материалы объекта.' }

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
    if (!canManageControl || obs.mode === 'recording' || !project || !isLoaded() || !stage || !prof || !ev.covered || !ev.inShift || !obs.complianceEnabled || obs.model !== 'ready') return
    const isCurrent = currentScope()
    const live = obs.sources.filter((s) => s.status === 'live' && !loopBlocked(s) && !viewBlocked(s))

    const names = live.map((s) => s.name).join(', ')
    const quality = `Качество данных: кадры дают ${live.length} из ${obs.sources.length} источников${live.length < obs.sources.length ? ', вывод ограничен' : ''}; распознавание работает, порог уверенности ${settings.conf}%, окно сверки ${settings.window} с.`
    const tail: string[] = []
    // the event belongs to the source it is shown on, and to that camera's zone
    const src = live.find((x) => x.id === selected) ?? live[0]
    const camera = sourceCamera(cameras, src?.id, safetyRecordingCameraId)
    const where = { zone_id: zoneIdOf(src?.id), zone_name: zoneOf(src?.id), camera_id: camera?.id ?? null, camera_name: camera?.name ?? src?.name ?? null }
    const signature = (code: Code) => pprCitationFingerprint(prof?.rules[code].pprRequirements)
    const open = (code: Code, kind: 'missing' | 'oop') => [...meta.current].some(([id, m]) => m.code === code && m.kind === kind && m.stageId === stage.id && m.pprSignature === signature(code) && !episodes.get(id)?.to)
    const make = (observationKey: string, kind: 'missing' | 'oop', code: Code, since: number, payload: Omit<api.IncidentCreate, 'project_id' | keyof typeof where>) => {
      if (renderScopeToken !== loadToken.current || !obs.evaluableClasses.includes(code)) return
      const pprSignature = signature(code)
      const key = pprSignature ? `${observationKey}|ppr:${prof?.pprRevision || 'active'}` : observationKey
      const c = created.current.get(key)
      if ((typeof c === 'string') || (typeof c === 'number' && Date.now() < c) || open(code, kind)) return
      // one open event per machine and stage: after a reload, adopt the pending one from the journal
      const known = events.find((e) => e.status === 'pending' && !e.sample && e.kind === kind && e.mach === code && e.stageId === stage.id && pprCitationFingerprint(e.pprRequirements) === pprSignature)
      if (known) {
        created.current.set(key, known.id)
        meta.current.set(known.id, { kind, code, stageId: stage.id, pprSignature })
        setEpisodes((m) => (m.has(known.id) ? m : new Map(m).set(known.id, { from: Math.max(known.at, since) })))
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
          model_status: 'valid' as const,
          ppr_revision: prof?.pprRevision,
          album_snapshots: shots.map((x, i) => ({ camera_name: x.name, snapshot_base64: x.snapshot, is_primary: selected ? x.id === selected : i === 0 })),
        })
        .then((res) => {
          if (!isCurrent()) return

          created.current.set(key, res.id)
          meta.current.set(res.id, { kind, code, stageId: stage.id, pprSignature })
          setEpisodes((m) => new Map(m).set(res.id, { from: since }))
          setEvents((list) => [toEvent(res, api.mediaUrl), ...list.filter((e) => e.id !== res.id)])
        })
        .catch((e: Error) => {
          if (!isCurrent()) return

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
          `Правило: ${MACH[s.code].name} — обязательная техника этапа «${stage.name}» (${s.basis === 'ppr' ? 'по ППР объекта' : `${Math.round(s.p * 100)}% по справочнику${s.edited ? ', изменено вручную' : ''}`}); предупреждение через ${durShort(s.warnAfter * 1000)}.`,
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
          `Правило: ${MACH[s.code].name} — рекомендуемая техника этапа «${stage.name}» (${s.basis === 'ppr' ? 'по ППР объекта' : `${Math.round(s.p * 100)}% по справочнику${s.edited ? ', изменено вручную' : ''}`}); предупреждение через ${durShort(s.warnAfter * 1000)}, отклонением не становится.`,
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
          `Правило: ${MACH[o.code].name} — нехарактерная техника для этапа «${stage.name}» (${o.basis === 'ppr' ? 'запрещено ППР объекта' : `${Math.round(o.p * 100)}% по справочнику`}).`,
          `Наблюдение: с ${hhmmss(o.since)} замечен на источниках: ${o.cams.map((c) => obs.sources.find((x) => x.id === c.src)?.name || c.src).join(', ')}.`,
          quality,
          ...tail,
        ].join('\n'),
      })
    }
  })
  /* camera signal goes to the journal as in the legacy UI: one record when it is lost, one when it is back */
  useEffect(() => {
    if (!canManageControl || !project || !isLoaded()) return
    const isCurrent = currentScope()

    const now = Date.now()
    const total = obs.sources.length
    const liveN = obs.sources.filter((x) => x.status === 'live').length
    const write = (src: SourceView, type: 'STREAM_LOST' | 'STREAM_OFFLINE' | 'STREAM_ONLINE', at: number, title: string, observation: string, quality: string) =>
      renderScopeToken !== loadToken.current ? Promise.resolve(false) : api
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
          if (!isCurrent()) return false

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
          void lost.written.then((ok) => ok && isCurrent() && write(src, 'STREAM_ONLINE', now, `Видеопоток восстановлен: ${src.name}`, `камера «${src.name}» снова присылает кадры с ${hhmmss(now)}; перерыв длился ${durShort(now - lost.at)}.`, `кадры дают ${liveN} из ${total} источников.`)).catch(() => undefined)
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

  /* a camera that looks away from its approved view: one event per turn, with the frame before and after */
  useEffect(() => {
    if (!canManageControl || !project || !isLoaded() || !ev.inShift) return
    const isCurrent = currentScope()

    for (const src of obs.sources) {
      const v = src.view
      if (src.kind !== 'camera' || !v) continue
      if (v.state !== 'changed') {
        // back in place: a later turn is a new event (the server joins it to one still open)
        if (v.state === 'ok' && typeof viewSent.current.get(src.id) !== 'number') viewSent.current.delete(src.id)
        continue
      }
      const sent = viewSent.current.get(src.id)
      if (typeof sent === 'string' || (typeof sent === 'number' && Date.now() < sent) || !src.snapshot) continue
      const open = events.find((e) => e.type === 'VIEW_CHANGED' && e.cameraId === src.id && isOpen(e))
      if (open) {
        viewSent.current.set(src.id, open.id)
        continue
      }
      const at = v.since ?? obs.t
      const problem = v.problem ?? 'different'
      const turn = problem === 'turned' ? turnWords(v) : ''
      const what = problem === 'covered' ? `Камера закрыта: ${src.name}` : problem === 'blurred' ? `Изображение размыто: ${src.name}` : `Ракурс камеры изменён: ${src.name}`
      const ref = v.refAt ? `утверждён ${fmtDay(v.refAt)} в ${hhmm(v.refAt)}${v.refBy ? `, ${v.refBy}` : ''}` : 'утверждён администратором'
      viewSent.current.set(src.id, 'pending')
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
          observation_key: `${src.id}|VIEW|${Math.round(at / 1000)}`,
          severity: 'ERROR',
          discrepancy_type: 'VIEW_CHANGED',
          title: what,
          description: [
            `Правило: камера «${src.name}» сверяется с утверждённым ракурсом (${ref}). Смещение согласует администратор.`,
            `Наблюдение: с ${hhmmss(at)} ${PROBLEM_WORD[problem]}${turn ? ` ${turn}` : ''}; совпадение с утверждённым ракурсом ${Math.round((v.match ?? 0) * 100)} %.`,
            'Качество данных: пока камера смотрит не туда, её кадры не учитываются в сверке техники.',
          ].join('\n'),
          album_snapshots: [
            { camera_name: `${src.name} · сейчас`, snapshot_base64: src.snapshot, is_primary: true },
            ...(v.before ? [{ camera_name: `${src.name} · до смещения${v.beforeAt ? `, ${hhmmss(v.beforeAt)}` : ''}`, snapshot_base64: v.before }] : []),
          ],
        })
        .then((res) => {
          if (!isCurrent()) return

          viewSent.current.set(src.id, res.id)
          setEvents((list) => [toEvent(res, api.mediaUrl), ...list.filter((e) => e.id !== res.id)])
          toast(`${what} · ${res.code}`, { error: true })
        })
        .catch((e: Error) => {
          if (!isCurrent()) return

          viewSent.current.set(src.id, Date.now() + 30_000)
          if (Date.now() - lastSaveError.current > 60_000) {
            lastSaveError.current = Date.now()
            toast(`Событие о ракурсе не сохранено: ${e.message}. Повторим через 30 с.`, { error: true })
          }
        })
    }
  })

  /* a camera that replays a recording: one event per camera, with the frame now and the same frame a period ago */
  useEffect(() => {
    if (!canManageControl || !project || !isLoaded()) return
    const isCurrent = currentScope()

    for (const src of obs.sources) {
      const l = src.loop
      if (src.kind !== 'camera') continue
      if (!l?.looped) {
        if (typeof loopSent.current.get(src.id) === 'string' && loopSent.current.get(src.id) !== 'pending') loopSent.current.delete(src.id)
        continue
      }
      const sent = loopSent.current.get(src.id)
      if (typeof sent === 'string' || (typeof sent === 'number' && Date.now() < sent) || !src.snapshot) continue
      const open = events.find((e) => e.kind === 'loop' && e.cameraId === src.id && isOpen(e))
      if (open) {
        loopSent.current.set(src.id, open.id)
        continue
      }
      const at = l.since ?? obs.t
      const period = l.period ? durShort(l.period) : 'несколько минут'
      loopSent.current.set(src.id, 'pending')
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
          observation_key: `${src.id}|LOOP|${Math.round(at / 1000)}`,
          severity: 'ERROR',
          discrepancy_type: 'STREAM_LOOP',
          title: `Камера повторяет запись: ${src.name}`,
          description: [
            'Правило: живая площадка не повторяется кадр в кадр; если весь кадр возвращается через одинаковое время, камера показывает запись по кругу. Снимает событие администратор, убедившись, что видео живое.',
            `Наблюдение: с ${hhmmss(at)} кадры камеры «${src.name}» повторяются с периодом около ${period}${l.thenAt ? `; кадр ${hhmmss(obs.t)} совпадает с кадром ${hhmmss(l.thenAt)}` : ''}, отличие на уровне шума сжатия (${Math.round((l.closeness ?? 0) * 100)} % от движения в кадре).`,
            'Качество данных: пока повтор идёт, кадры этой камеры не учитываются в сверке техники.',
          ].join('\n'),
          album_snapshots: [
            { camera_name: `${src.name} · сейчас, ${hhmmss(obs.t)}`, snapshot_base64: src.snapshot, is_primary: true },
            ...(l.thenSnap ? [{ camera_name: `${src.name} · тот же кадр${l.thenAt ? `, ${hhmmss(l.thenAt)}` : ''}`, snapshot_base64: l.thenSnap }] : []),
          ],
        })
        .then((res) => {
          if (!isCurrent()) return

          loopSent.current.set(src.id, res.id)
          setEvents((list) => [toEvent(res, api.mediaUrl), ...list.filter((e) => e.id !== res.id)])
          toast(`Камера «${src.name}» повторяет запись · ${res.code}`, { error: true })
        })
        .catch((e: Error) => {
          if (!isCurrent()) return

          loopSent.current.set(src.id, Date.now() + 30_000)
          if (Date.now() - lastSaveError.current > 60_000) {
            lastSaveError.current = Date.now()
            toast(`Событие о повторе видео не сохранено: ${e.message}. Повторим через 30 с.`, { error: true })
          }
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
  const rightsOf = (_e: UiEvent) => ({ act: false, dismiss: false, reason: 'Решения, подача устранения и приёмка доступны в рабочем кабинете.' })
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
    return res
  }
  /** The case file waits for the server, so "Сохраняем…" and a refusal stay visible there. */
  const decideNow = async (id: string, status: EventStatus) => {
    const before = events.find((e) => e.id === id)
    if (!before || before.sample) return
    const res = await sendDecision(id, status)
    // a camera view is rechecked by the server at once
    if (before.kind === 'loop' && status === 'resolved') toast(`Видео живое: событие закрыто · ${before.code}`)
    else if (before.kind === 'view' && status === 'resolved')
      toast(res.status === 'resolved' ? `Камера на месте: сервер сверил кадры с утверждённым ракурсом · ${before.code}` : `Камера всё ещё смотрит не туда · ${before.code}`, { error: res.status !== 'resolved' })
    else toast(status === 'resolved' ? `Проверка исправления запрошена · ${before.code}` : `${STATUS_WORD[status]} · ${before.code}`)
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

  /* rules */
  /* Rule levels are shared; the browser only keeps timing and the skip label. */
  const writeLocal = (stageId: string, next: LocalRules) => {
    saveLocalRules(stageId, next)
    setLocalRules((m) => new Map(m).set(stageId, next))
  }
  const syncLocalSkippedRules = async () => {
    for (const item of stages) {
      const local = localRules.get(item.id) ?? loadLocalRules(item.id)
      const skipped = CODES.filter(code => local[code]?.skip)
      if (!skipped.length) continue
      const profile = await api.profile(item.id)
      const overrides: Record<string, string> = {}
      for (const code of skipped) {
        const rule = profile.probabilities.find(probability => toCode(probability.machinery_code) === code)
        if (rule && rule.source !== 'document') overrides[MACH[code].api] = 'NEUTRAL'
      }
      if (!Object.keys(overrides).length) continue
      const saved = await api.putOverrides(item.id, overrides)
      setApiProfiles(current => new Map(current).set(item.id, saved))
    }
  }
  const applyRule = async (stageId: string, code: Code, d: { lvl: Level; warnAfter: number | null; errAfter: number | null }) => {
    const r = profiles.get(stageId)!.rules[code]
    if (r.basis) throw new Error('Требование ППР изменяется в документах объекта.')
    const local = { ...(localRules.get(stageId) ?? loadLocalRules(stageId)) }
    const serverLvl = r.lvl === 'skip' ? (apiLevel(stageId, code) ?? r.base) : r.lvl
    const rec = { ...(local[code] ?? { base: serverLvl, at: Date.now() }) }
    rec.skip = d.lvl === 'skip' || undefined
    rec.warnAfter = d.warnAfter ?? undefined
    rec.errAfter = d.errAfter ?? undefined
    const target = d.lvl === 'skip' ? 'ok' : d.lvl
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
    if (profiles.get(stageId)?.rules[code].basis) throw new Error('Требование ППР изменяется в документах объекта.')
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
      if (profiles.get(stageId)?.rules[code].basis) continue
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

  /* camera views: proposals and moves go to the administrator; an administrator decides at once */
  const changeView = async (save: () => Promise<api.CameraViewState>) => {
    const isCurrent = currentScope()
    const st = await save()
    if (!isCurrent()) return null
    setViews((old) => old.some((x) => x.camera_id === st.camera_id) ? old.map((x) => x.camera_id === st.camera_id ? st : x) : [...old, st])
    return st

  }
  useEffect(() => { engine.setViews(views) }, [engine, views])
  const reloadEvents = () => {
    if (!project) return
    const id = project.id
    const isCurrent = currentScope()
    api.incidents(id).then((inc) => isCurrent() && setEvents((old) => inc.map((i) => keepUnsent(toEvent(i, api.mediaUrl), old))), () => undefined)

  }
  const viewActions: ViewActions | null = project
    ? {
        states: views,
        user,
        canApprove: canManageControl && context.effective_permissions.includes('camera.reference.approve'),
        canPropose: !context.is_demo && context.lifecycle === 'active' && context.effective_permissions.includes('camera.reference.propose'),
        canRequestMove: false,
        submit: async (cameraId, note) => {
          const snap = obs.sources.find((s) => s.id === cameraId)?.snapshot
          if (!snap) throw new Error('Нет текущего кадра с камеры: дождитесь, пока она пришлёт кадр')
          const st = await changeView(() => api.submitView(project.id, cameraId, snap, note))
          if (!st) return
          toast(`Ракурс «${st.camera_name}» предложен. Просмотрите его и утвердите отдельным решением заказчика.`)
        },
        approve: async (cameraId, sha256) => {
          const st = await changeView(() => api.approveView(project.id, cameraId, sha256))
          if (!st) return

          viewSent.current.delete(cameraId)
          reloadEvents()
          toast(`Новый ракурс «${st.camera_name}» утверждён`)
        },
        reject: async (cameraId, note) => { await changeView(() => api.rejectView(project.id, cameraId, note)) },
        requestMove: async (cameraId, until, reason) => {
          const st = await changeView(() => api.requestMove(project.id, cameraId, until, reason))
          if (!st) return
          toast(st.move?.status === 'approved' ? `Перенос «${st.camera_name}» согласован` : `Запрос на перенос «${st.camera_name}» отправлен администратору`)
        },
        approveMove: async (cameraId) => {
          const st = await changeView(() => api.approveMove(project.id, cameraId))
          if (!st) return
          toast(`Перенос «${st.camera_name}» согласован`)
        },
        rejectMove: async (cameraId, note) => { await changeView(() => api.rejectMove(project.id, cameraId, note)) },
        cancelMove: async (cameraId) => { await changeView(() => api.cancelMove(project.id, cameraId)) },

      }
    : null

  /* sources */
  const addCamera = async (name: string, url: string, zoneId?: string | null, code?: string) => {
    if (!project) return
    const isCurrent = currentScope()
    const cam = await api.createCamera(project.id, { name, code: code || undefined, stream_url: url, zone_id: zoneId === undefined ? zones[0]?.id ?? null : zoneId })
    if (!isCurrent()) return
    const next = [...cameras, cam]
    setCameras(next)
    engine.setCameras(next)
    toast(`Камера «${cam.name}» добавлена`)
  }
  const deleteCamera = async (id: string) => {
    if (!project) return
    const isCurrent = currentScope()
    try {
      await api.deleteCamera(project.id, id)
      if (!isCurrent()) return
      const next = cameras.filter((c) => c.id !== id)
      setCameras(next)
      engine.setCameras(next)
    } catch (e) {
      toast((e as Error).message, { error: true })
    }
  }
  const updateCamera = async (id: string, name: string, url: string, zoneId: string | null, code?: string) => {
    if (!project) return
    const isCurrent = currentScope()
    const cam = await api.updateCamera(project.id, id, { name, code: code || undefined, ...(url ? { stream_url: url } : {}), zone_id: zoneId })
    if (!isCurrent()) return

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
    const next = visibleProjects(rest, user)[0]
    setProjectId(next?.id ?? null)
    toast(`Объект «${gone.name}» удалён`)
  }
  const createZone = async (d: { name: string; code: string; description: string }) => {
    if (!project) return
    const isCurrent = currentScope()
    const z = await api.createZone(project.id, { name: d.name, code: d.code || undefined, description: d.description || undefined })
    if (!isCurrent()) return
    setZones((l) => [...l, z])
  }
  const updateZone = async (id: string, d: { name: string; code: string; description: string }) => {
    if (!project) return
    const isCurrent = currentScope()
    const z = await api.updateZone(project.id, id, d)
    if (!isCurrent()) return
    setZones((l) => l.map((x) => (x.id === id ? z : x)))
  }
  const deleteZone = async (id: string) => {
    if (!project) return
    const isCurrent = currentScope()
    try {
      await api.deleteZone(project.id, id)
      if (!isCurrent()) return
      setZones((l) => l.filter((x) => x.id !== id))
      // the server unlinks the cameras of the zone (ON DELETE SET NULL)
      setCameras((l) => l.map((c) => (c.zone_id === id ? { ...c, zone_id: null } : c)))
    } catch (e) {
      toast((e as Error).message, { error: true })
    }
  }
  /** The zone an event belongs to: the zone of the camera it was seen on. */
  const zoneOf = (sourceId?: string) => {
    const cam = sourceCamera(cameras, sourceId, safetyRecordingCameraId)
    const z = zones.find((x) => x.id === cam?.zone_id)
    return z?.name ?? (zones.length === 1 ? zones[0].name : null)
  }
  const zoneIdOf = (sourceId?: string) => {
    const cam = sourceCamera(cameras, sourceId, safetyRecordingCameraId)
    return zones.find((x) => x.id === cam?.zone_id)?.id ?? (zones.length === 1 ? zones[0].id : null)
  }

  const openRecording = (file: File, start: number) => {
    videoRequest.current?.abort(); if (videoSessionTimer.current) clearTimeout(videoSessionTimer.current)
    if (!canUploadVideo || (context.side === 'contractor' && !uploadAreaId)) { toast('Выберите разрешённую область для загрузки записи.', { error: true }); return }
    const token = loadToken.current
    setSavedVideoId('')
    setRecordingUploadError(null)
    engine.startRecording(file, start)
    const recordingUrl = engine.recording?.url
    engine.setSafetyRecordingCamera(undefined)
    setSafetyRecordingCameraId('')
    setSelected('recording')
    if (project)
      api.uploadVideo(project.id, file, new Date(start).toISOString(), uploadAreaId || undefined).then(
        (asset) => {
          if (token !== loadToken.current) return
          if (engine.recording?.url === recordingUrl) setSavedVideoId(asset.video_id)
          toast('Запись сохранена на сервере')
          api.savedVideos(project.id).then((videos) => {
            if (token === loadToken.current) setSavedVideos(videos)
          }, () => undefined)
        },
        (e: Error) => {
          if (token !== loadToken.current || engine.recording?.url !== recordingUrl) return
          setRecordingUploadError(e.message)
          toast(`Запись не сохранена на сервере: ${e.message}. Распознавание в плеере продолжается.`, { error: true })
        },
      )
  }
  const closeRecording = () => {
    videoRequest.current?.abort(); if (videoSessionTimer.current) clearTimeout(videoSessionTimer.current)
    setSavedVideoId('')
    setRecordingUploadError(null)
    engine.stopRecording()
    engine.setCameras(cameras)
    setSelected(null)
  }

  /* plan */
  const importPlan = async (fn: () => Promise<api.ImportResult>) => {
    const isCurrent = currentScope()
    const res = await fn()
    if (!isCurrent()) return res
    setStages(toStages(res.stages))
    setApiProfiles(new Map())
    return res
  }

  /* plan dates: one PUT per changed stage, then the plan is read back from the server */
  const writeDates = async (list: { id: string; start: number; end: number }[]) => {
    if (!project) return
    const id = project.id
    const isCurrent = currentScope()
    await Promise.all(list.map((c) => api.updateStage(c.id, { planned_start: isoDay(c.start), planned_end: isoDay(c.end), duration_days: Math.round((c.end - c.start) / DAY_MS) + 1 })))
    const fresh = await api.stages(id)
    if (isCurrent()) setStages(toStages(fresh))
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
    const isCurrent = currentScope()
    try {
      await api.clearPlan(project.id)
      if (!isCurrent()) return
      setStages([])
      setApiProfiles(new Map())
      setDockOpen(false)
      toast('План очищен. Загрузите новый план, чтобы продолжить сверку.')
    } catch (e) {
      toast((e as Error).message, { error: true })
    }
  }

  const onAction = (a: VerdictAction | { act: string; id?: string }, el?: HTMLElement) => {
    if (a.act === 'customer-cases') setCustomerSection('cases')
    else if (a.act === 'customer-documents') setCustomerSection('documents')
    else if (a.act === 'case' && a.id) setCaseOpen({ id: a.id, origin: document.querySelector(`.q-item[data-id="${a.id}"] .q-card`)?.getBoundingClientRect() ?? el?.getBoundingClientRect() ?? null })
    else if (a.act === 'plan') setDockOpen(true)
    else if (a.act === 'setup') { if (canManageControl) setSetupOpen(true); else setSheet('sources') }
    else if (a.act.startsWith('settings')) setSheet('sources')
  }
  const openRule = (_code: Code, _el: HTMLElement, _stageId?: string) => {
    if (context.effective_permissions.includes('document.read')) setPprOpen(true)
    else toast('Требования и их применение утверждает управляющий заказчика.')
  }

  /* keyboard */
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName
      if (covered || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || caseOpen || rule || sheet || journal || pprOpen || customerSection) return
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
  const setupVisible = setupOpen && !projectsError && !loadError
  const pending = events.filter((e) => e.status === 'pending' && e.kind !== 'stream')

  return (
    <div className="app" id="app">
      <header className="bar">
        <button type="button" className="brand brand-btn" onClick={onIntro} aria-label="Заставка" title="Заставка">
          СК
        </button>
        <button type="button" className="ctx" onClick={(e) => setMenu({ kind: 'project', anchor: e.currentTarget.getBoundingClientRect() })} aria-haspopup="menu">
          <small>{context.organization_name} · {roleName(context)}</small>
          <span>{context.project_name}</span>
        </button>
        {canReadSources && zones.length > 0 && (
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
        <TimePill obs={obs} onExit={closeRecording} />
        <button type="button" className="icon-btn tasks-btn" onClick={() => setCustomerSection('notifications')} aria-label="Уведомления" title="Уведомления">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6.5 16.5V11a5.5 5.5 0 0 1 11 0v5.5l1.5 1.5H5z" /><path d="M10 20.5a2.2 2.2 0 0 0 4 0" /></svg>
        </button>
        <button type="button" className="btn small ppr-entry" onClick={() => setCustomerSection('documents')} disabled={!can(context, 'document.read')} aria-label="Документы ППР текущего объекта">ППР</button>
        <button type="button" className="btn small safety-entry" disabled={!project} onClick={() => setSheet('documents')}>Документы</button>
        {canManageControl && <button type="button" className="btn small safety-entry" onClick={() => setSheet('safety')} aria-label="Безопасность" title="Безопасность"><svg className="safety-entry-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z"/><path d="m8 12 3 3 5-6"/></svg><span className="safety-entry-label">Безопасность</span></button>}
        {canReadSources && <button type="button" className="icon-btn" onClick={() => setSheet('sources')} aria-label="Доступные источники">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="10" cy="17" r="2" />
          </svg>
        </button>}
        <button type="button" className="avatar-btn" onClick={(e) => setMenu({ kind: 'user', anchor: e.currentTarget.getBoundingClientRect() })} aria-label={`Пользователь ${user.username}`} aria-haspopup="menu">
          <span className="avatar">{user.username.slice(0, 2).toUpperCase()}</span>
        </button>
      </header>

      <div className="observation-summary">
      {context.is_demo && <div className="myvms-entry" role="group" aria-label="Источники демонстрации"><button className="btn small" type="button" aria-pressed={!showLiveDemo} onClick={() => setLiveDemoProject(null)}>Исторические источники</button><button className="btn small" type="button" aria-pressed={showLiveDemo} onClick={() => setLiveDemoProject(context.project_id)}>Live-камеры MyVMS</button></div>}
      {(accessError || context.is_demo || context.lifecycle === 'archived') && <div className="workspace-access-line">{accessError ? <><span className="err-line">{accessError}</span><button className="link" type="button" disabled={accessLoading} onClick={onRefreshAccess}>Обновить доступы</button></> : <span>{context.is_demo ? 'Общая демонстрация · только просмотр' : 'Объект в архиве · только просмотр'}</span>}</div>}
{!showLiveDemo && (projectsError || loadError ? (
        <div className="panel" role="alert">
          <p className="err-line">{projectsError || loadError}</p>
          <button type="button" className="btn" onClick={() => projectsError ? setProjectsRetry((n) => n + 1) : setProjectRetry((n) => n + 1)}>Повторить загрузку</button>
        </div>
      ) : <Verdict v={verdict} onAction={onAction} at={obs.mode === 'recording' ? `запись ${fmtDay(t)}` : undefined} />)}
      {!showLiveDemo && project && isSharedDemoProject(project) && <p style={{ margin: 0, padding: '0 20px 6px' }}>Демонстрационные интервалы: предупреждение через {settings.warnAfter} с, отклонение через {settings.errAfter} с, техника не по этапу — через {settings.oopAfter} с.</p>}

      {!showLiveDemo && (savedVideos.length > 0 || videosError) && <div className="saved-recordings" style={{ padding: '8px 20px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        {savedVideos.length > 0 && <label style={{ minWidth: 0, maxWidth: '100%' }}>Сохранённые записи{' '}
          <select style={{ maxWidth: '100%' }} aria-label="Сохранённые записи" value={savedVideoId} onChange={(event) => {
            const video = savedVideos.find((item) => item.video_id === event.target.value)
            if (!video) { closeRecording(); return }
            setRecordingUploadError(null)
            void playSavedVideo(video)
          }}>
            <option value="">Выбрать запись</option>
            {savedVideos.map((video) => <option key={video.video_id} value={video.video_id}>{video.filename} · {new Date(video.start_timestamp).toLocaleString('ru-RU')} · {recordingAnalysisLabel(video.analysis_status)}</option>)}
          </select>
        </label>}
        {videosError && <span role="status">{videosError}</span>}
        {savedVideos.find(video => video.video_id === savedVideoId)?.analysis_status === 'FAILED' && <span role="status">Серверный анализ записи завершился ошибкой. Воспроизведение и распознавание в плеере доступны.</span>}
      </div>}
      {canUploadVideo && context.side === 'contractor' && <label className="customer-context" style={{ padding: '8px 20px' }}>Область для новой записи<select value={uploadAreaId} onChange={event => setUploadAreaId(event.target.value)}><option value="">Выберите назначенную область</option>{assignmentOptions?.areas.map(area => <option value={area.id} key={area.id}>{area.name}</option>)}</select></label>}
      </div>


      <main className="work" data-document-only={!canReadSources || undefined}>
        {showLiveDemo ? <MyVmsDemo key={context.project_id} projectId={context.project_id} /> : canReadSources ? <StageView engine={engine} obs={obs} ev={ev} prof={prof} selected={selected} onSelect={setSelected} focus={focus} boxes={boxes} setBoxes={setBoxes} onAction={(act) => onAction({ act })} settings={settings} /> : <section className="panel document-entry"><span className="kicker">{roleName(context)}</span><h2>Документы и требования</h2><p>Загружайте ППР, проверяйте исходные страницы и область применения. Передавайте проверенные редакции управляющему заказчика на утверждение.</p>{can(context, 'document.read') && <button className="btn primary" type="button" onClick={() => setCustomerSection('documents')}>Открыть документы</button>}</section>}
        {!showLiveDemo && (canReadPlan || can(context, 'incident.read')) && <aside className="side" id="side">
          {canReadPlan && <Recon ev={ev} stage={stage} prof={prof} obs={obs} loading={!!stage && !prof} infer={infer} onRule={(c, el) => openRule(c, el)} onFocus={setFocus} />}
          {can(context, 'incident.read') ? <CustomerCases context={context} onAccessChanged={onRefreshAccess} compact onAll={() => setCustomerSection('cases')} /> : <section className="panel queue"><div className="queue-head"><span className="kicker">Документы и требования</span></div><p className="q-empty">Проверяйте исходные страницы и отправляйте редакции заказчику на утверждение.</p><button type="button" className="btn small" onClick={() => setCustomerSection('documents')}>Открыть документы</button></section>}
        </aside>}
        <QueueJump count={pending.length} err={pending.some((e) => e.sev === 'err')} />
      </main>

      {setupVisible && canManageControl && (
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

      {!showLiveDemo && <Dock
        planRestricted={!canReadPlan}
        readOnly
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
      />}

      {customerSection && <CustomerPanel context={context} user={user} section={customerSection} onSection={setCustomerSection} onClose={() => setCustomerSection(null)} onAccessChanged={onRefreshAccess} />}

      {project && <PprDocuments key={project.id} open={pprOpen} project={project} user={user} requiresArea={context.side === 'contractor'} permissions={context.lifecycle === 'active' && !context.is_demo ? context.effective_permissions : []} stages={stages} onRulesChanged={refreshPprProfiles} onClose={() => { setPprOpen(false); void refreshPprProfiles() }} />}

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
          view={caseEvent.kind === 'view' && caseEvent.cameraId && viewActions ? { actions: viewActions, cameraId: caseEvent.cameraId } : undefined}
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
          projectId={project?.id || ''}
          onPpr={() => { setRule(null); setPprOpen(true) }}
        />
      )}
      {sheet && project && (
        <SettingsSheet
          allowedTabs={['sources', 'documents', ...(canManageControl ? ['safety'] as const : []), ...(engine.inferenceEnabled ? ['photo'] as const : [])]}
          canConfigure={canManageControl}
          canUpload={canUploadVideo}
          tab={sheet}
          recordingCameraId={safetyRecordingCameraId}
          onRecordingCamera={(id) => { setSafetyRecordingCameraId(id); engine.setSafetyRecordingCamera(id || undefined) }}
          onBeforeDocumentAnalysis={syncLocalSkippedRules}
          onDocumentRulesChanged={async (changes) => {
            const stageIds = [...new Set(changes.map(item => item.stage_id))]
            const refreshed = await Promise.all(stageIds.map(async id => [id, await api.profile(id)] as const))
            setApiProfiles(current => {
              const next = new Map(current)
              refreshed.forEach(([id, profile]) => next.set(id, profile))
              return next
            })
            for (const stageId of stageIds) {
              const local = { ...(localRules.get(stageId) ?? loadLocalRules(stageId)) }
              let changed = false
              for (const selection of changes.filter(item => item.stage_id === stageId)) {
                const code = toCode(selection.class_code)
                const profile = refreshed.find(([id]) => id === stageId)?.[1]
                const source = profile?.probabilities.find(item => toCode(item.machinery_code) === code)?.source
                if (!code || source !== 'document' || !local[code]?.skip) continue
                const rule = { ...local[code], skip: undefined }
                if (rule.warnAfter == null && rule.errAfter == null) delete local[code]
                else local[code] = rule
                changed = true
              }
              if (changed) writeLocal(stageId, local)
            }
          }}
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
          views={viewActions}
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
        <Menu anchor={menu.anchor} onClose={() => setMenu(null)} >
          {menu.kind === 'project' ? (
            <>
              <div className="m-k kicker">Организация / объект / назначение</div>
              {contexts.map(item => <button key={contextKey(item)} type="button" className="m-item" role="menuitemradio" aria-checked={contextKey(item) === contextKey(context)} onClick={() => { setMenu(null); onContextChange(contextKey(item)) }}><span className="chk">✓</span><span><b>{item.project_name}</b><small>{item.organization_name} · {roleName(item)}</small></span></button>)}
              <div className="m-sep" />
              <button type="button" className="m-item" role="menuitem" disabled={accessLoading} onClick={() => { setMenu(null); onRefreshAccess() }}><span /><span><b>Обновить доступы</b></span></button>
              <button type="button" className="m-item" role="menuitem" onClick={() => { setMenu(null); setCustomerSection('organizations') }}><span /><span><b>Организации и приглашения</b></span></button>
            </>
          ) : (
            <>
              <div className="m-k kicker">{user.username} · {roleName(context).toLowerCase()}</div>
              {([{ section: 'cases', title: context.role === 'contractor_foreman' ? 'Мои задачи' : 'Решения заказчика', available: can(context, 'incident.read') }, { section: 'documents', title: 'Документы и требования', available: can(context, 'document.read') }, { section: 'cameras', title: 'Камеры и переносы', available: can(context, 'camera.read') }, { section: 'participants', title: 'Участники и полномочия', available: can(context, 'assignment.manage') }, { section: 'reports', title: 'Отчёты', available: can(context, 'report.read') }] as const).filter(item => item.available).map(item => <button className="m-item" role="menuitem" type="button" key={item.section} onClick={() => { setMenu(null); setCustomerSection(item.section) }}><span /><span><b>{item.title}</b></span></button>)}
              <div className="m-sep" />
              {can(context, 'incident.read') && <button type="button" className="m-item" role="menuitem" onClick={() => { setMenu(null); setJournal({ origin: menu.anchor }) }}>
                <span />
                <span><b>Журнал и акт</b><small>События за период, выгрузка акта</small></span>
              </button>}
              {canManageControl && <button type="button" className="m-item" role="menuitem" onClick={() => { setMenu(null); setSetupOpen(true) }}>
                <span />
                <span><b>Первый запуск</b><small>План, источники, проверка</small></span>
              </button>}
              <button type="button" className="m-item" role="menuitem" onClick={() => { setMenu(null); onIntro() }}>
                <span />
                <span><b>Заставка</b><small>Стартовый экран с ролью</small></span>
              </button>
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
