import type { ObservationCode } from '../domain/constructionObservations'
import type { ApiIncident, ApiProfile, StageItem, UserProfile } from './api'
import type { PprCitation } from './pprApi'
import { CODES, MACH, toCode, type Code } from './lib/machinery'
import { atTime, dayStart, durShort, durWords, fmtDay, hhmm, planDay, plural, DAY_MS } from './lib/format'
import { PROBLEM_WORD, turnWords as turnWordsOf, viewBlocked, type ViewProblem } from './lib/view'

/* ── Requirement levels ─────────────────────────────────── */
export type Level = 'req' | 'rec' | 'ok' | 'no' | 'skip'
export const LV: Record<Level, { label: string; group: string; explain: string }> = {
  req: { label: 'Обязательна', group: 'Обязательная', explain: 'Отсутствие создаёт предупреждение, затем отклонение.' },
  rec: { label: 'Рекомендуется', group: 'Рекомендуемая', explain: 'Отмечается в сверке, событий не создаёт.' },
  ok: { label: 'Допустима', group: 'Допустимая', explain: 'Может быть на площадке, в сверке не участвует.' },
  no: { label: 'Не характерна', group: 'Не характерная', explain: 'Появление на площадке создаёт отклонение.' },
  skip: { label: 'Не учитывается', group: 'Не учитывается', explain: 'Снимает требование на сервере и не участвует в сверке. Пометка видна в этом браузере.' },
}
export const LV_ORDER: Level[] = ['req', 'rec', 'ok', 'no', 'skip']
const CLS_TO_LV: Record<string, Level> = { MANDATORY: 'req', RECOMMENDED: 'rec', NEUTRAL: 'ok', UNCHARACTERISTIC: 'no' }
/** The server has four levels; "не учитывается" stores a neutral rule there. */
export const LV_TO_CLS: Record<Exclude<Level, 'skip'>, string> = { req: 'MANDATORY', rec: 'RECOMMENDED', ok: 'NEUTRAL', no: 'UNCHARACTERISTIC' }
/** Server thresholds (backend/app/api/v1/schedule.py): >80 / 60–80 / 15–60 / <15 %. */
export const THRESHOLDS = [
  { v: '> 80%', l: 'обязательна' },
  { v: '60–80%', l: 'рекомендуется' },
  { v: '15–60%', l: 'допустима' },
  { v: '< 15%', l: 'не характерна' },
]

/* ── Object-wide settings ───────────────────────────────── */
export interface Settings {
  window: number // s, observation window
  conf: number // %, minimum detection confidence
  warnAfter: number // s
  errAfter: number // s
  oopAfter: number // s
  shiftFrom: number // s since midnight
  shiftTo: number
  startGrace: number // s after shift start before absence counts
}
export const DEFAULTS: Settings = { window: 30, conf: 60, warnAfter: 300, errAfter: 1800, oopAfter: 60, shiftFrom: 7 * 3600, shiftTo: 19 * 3600, startGrace: 1800 }
export const DEMO_DEFAULTS: Settings = { ...DEFAULTS, warnAfter: 30, errAfter: 60, oopAfter: 30, startGrace: 0 }
export type NumKey = keyof Settings
export const STEPS: Record<NumKey, number[]> = {
  window: [10, 15, 30, 60, 120],
  conf: [40, 50, 60, 70, 80, 90],
  warnAfter: [30, 60, 120, 180, 300, 600, 900, 1200, 1800],
  errAfter: [60, 120, 300, 600, 900, 1200, 1800, 2700, 3600, 5400],
  oopAfter: [30, 60, 120, 300, 600],
  shiftFrom: [5, 6, 7, 8, 9].map((h) => h * 3600),
  shiftTo: [17, 18, 19, 20, 21, 22, 24].map((h) => h * 3600),
  startGrace: [0, 900, 1800, 2700, 3600],
}
export function loadSettings(projectId: string, sharedDemo = false): Settings {
  const defaults = sharedDemo ? DEMO_DEFAULTS : DEFAULTS
  try {
    const raw = localStorage.getItem(`sverka:settings:${sharedDemo ? 'demo-v1:' : ''}${projectId}`)
    if (raw) return { ...defaults, ...JSON.parse(raw) }
  } catch {
    // storage unavailable
  }
  return { ...defaults }
}
export function saveSettings(projectId: string, s: Settings, sharedDemo = false) {
  try {
    localStorage.setItem(`sverka:settings:${sharedDemo ? 'demo-v1:' : ''}${projectId}`, JSON.stringify(s))
  } catch {
    // storage unavailable
  }
}

/** Object types as the reference catalogue names them. */
export const KINDS = ['Жильё', 'Административные здания', 'Офисно-деловой центр', 'Образование', 'ДОУ', 'Здравоохранение', 'Спорт', 'Культура', 'Дороги']

/* ── Plan ───────────────────────────────────────────────── */
export interface Stage {
  id: string
  n: number
  name: string
  start: number // local midnight of the first day
  end: number // local midnight of the last day
  days: number
  catalog: string | null
  similarity: number | null
}
export function toStages(items: StageItem[]): Stage[] {
  return [...items]
    .sort((a, b) => a.order_index - b.order_index)
    .map((s, i) => {
      const start = planDay(s.planned_start)
      const end = planDay(s.planned_end)
      return { id: s.id, n: i + 1, name: s.name, start, end, days: Math.round((end - start) / DAY_MS) + 1, catalog: s.matched_catalog_name ?? null, similarity: s.catalog_similarity ?? null }
    })
}
/** The stage whose planned days contain the observation day; outside the plan there is none. */
export function stageAt(stages: Stage[], t: number) {
  const d = dayStart(t)
  return stages.find((s) => d >= s.start && d <= s.end) ?? null
}
export const stageDay = (s: Stage, t: number) => Math.round((dayStart(t) - s.start) / DAY_MS) + 1

/* ── Rules ──────────────────────────────────────────────── */
export interface Rule {
  code: Code
  p: number
  baseP: number
  base: Level
  lvl: Level
  edited: boolean
  warnAfter: number // s
  errAfter: number // s
  ownTiming: boolean
  source?: 'catalog' | 'document' | 'manual'
  basis?: 'ppr' | 'ppr_conflict' | null
  pprRequirements?: PprCitation[]
}
export interface Profile {
  stageId: string
  catalog: string | null
  similarity: number
  rules: Record<Code, Rule>
  edited: boolean
  pprRevision?: string | null
}
/** What this browser changed on top of the server profile. */
export interface LocalRule {
  base: Level // the level before the first change, to return to it
  skip?: boolean
  warnAfter?: number
  errAfter?: number
  at: number
}
export type LocalRules = Partial<Record<Code, LocalRule>>
export function loadLocalRules(stageId: string): LocalRules {
  try {
    return JSON.parse(localStorage.getItem(`sverka:rules:${stageId}`) || '{}')
  } catch {
    return {}
  }
}
export function saveLocalRules(stageId: string, r: LocalRules) {
  try {
    localStorage.setItem(`sverka:rules:${stageId}`, JSON.stringify(r))
  } catch {
    // storage unavailable
  }
}

export function toProfile(api: ApiProfile, s: Settings, local: LocalRules = {}): Profile {
  const rules = {} as Record<Code, Rule>
  for (const code of CODES) {
    const item = api.probabilities.find((m) => toCode(m.machinery_code) === code)
    const server: Level = item ? CLS_TO_LV[item.classification] ?? 'ok' : 'no'
    // Browser overrides cannot weaken an active, source-backed PPR requirement.
    const l = item?.basis ? undefined : local[code]
    rules[code] = {
      code,
      p: item?.probability ?? 0,
      baseP: item?.probability ?? 0,
      base: l?.base ?? server,
      lvl: l?.skip && item?.source !== 'document' ? 'skip' : server,
      edited: !!l,
      warnAfter: l?.warnAfter ?? s.warnAfter,
      errAfter: l?.errAfter ?? s.errAfter,
      ownTiming: l?.warnAfter != null || l?.errAfter != null,
      source: item?.source,
      basis: item?.basis,
      pprRequirements: item?.ppr_requirements ?? [],
    }
  }
  return { stageId: api.stage_id, catalog: api.matched_catalog_stage ?? null, similarity: api.similarity_confidence, rules, edited: Object.values(rules).some(row => row.edited), pprRevision: api.ppr_revision }
}

/* ── Observation (provided by the engine) ───────────────── */
export interface Det { code: ObservationCode; c: number; x: number; y: number; w: number; h: number }
export type SourceStatus = 'connecting' | 'live' | 'stale' | 'offline' | 'unsupported' | 'idle'
/** The camera's frames repeat a recording: what period, since when, and which earlier frame. */
export interface LoopCheck {
  looped: true
  period?: number
  since?: number
  thenAt?: number
  thenSnap?: string
  /** how close the repeats are, relative to the motion: 0 is an exact copy */
  closeness?: number
}
/** A camera that replays a recording says nothing about the site: its frames are not used. */
export const loopBlocked = (s: { loop?: LoopCheck }) => !!s.loop?.looped
/** Is the camera looking where it was approved to look. none: no approved view yet; move: an agreed move is on. */
export interface ViewCheck {
  state: 'none' | 'pending' | 'ok' | 'changed' | 'move'
  refUrl?: string
  refAt?: number
  refBy?: string | null
  problem?: ViewProblem
  match?: number
  dx?: number
  dy?: number
  /** observation time the current state began */
  since?: number
  /** the last frame that matched, and when */
  before?: string
  beforeAt?: number
  moveUntil?: number
  moveBy?: string | null
}
export { viewBlocked }
export interface SourceView {
  id: string
  n: number
  name: string
  kind: 'camera' | 'video'
  url?: string | null
  protocol: 'http' | 'rtsp' | 'file' | 'other'
  status: SourceStatus
  message?: string
  since?: number // wall time the status started
  lastFrame?: number // observation time of the last analyzed frame
  snapshot?: string
  dets: Det[]
  loop?: LoopCheck
  view?: ViewCheck
}
export interface Observation {
  mode: 'live' | 'recording'
  t: number
  sources: SourceView[]
  model: 'unknown' | 'ready' | 'down'
  complianceEnabled: boolean
  evaluableClasses: Code[]
  modelMessage?: string
  modelSince?: number
  frames: number
  evaluationRevision?: number
  recording?: { name: string; start: number; duration: number; paused: boolean; ended: boolean }
  // queries over everything analyzed in this session
  seenWithin(code: Code, t: number, windowMs: number): { src: string; c: number }[]
  lastSeen(code: Code, t: number): number | null
  episodeStart(code: Code, t: number, gapMs: number): number | null
  coverageStart(t: number): number | null
  presence(code: Code): [number, number][]
  coverage(): [number, number][]
}

/* ── Evaluation ─────────────────────────────────────────── */
export type SlotState = 'seen' | 'missing' | 'waiting' | 'unknown' | 'offshift' | 'gathering'
export interface Slot extends Rule {
  state: SlotState
  cams: { src: string; c: number }[]
  since?: number
  missFor?: number
  sev?: 'warn' | 'err' | 'info'
  neverSeen?: boolean
  limited?: boolean
}
export interface OopItem extends Rule { cams: { src: string; c: number }[]; since: number; dur: number }
export interface Evaluation {
  t: number
  stage: Stage | null
  slots: Slot[]
  oop: OopItem[]
  stationary: Rule[]
  allowed: Rule[]
  inShift: boolean
  shiftStart: number
  graceEnd: number
  covered: boolean
  liveSources: number
  totalSources: number
}

export function evaluate(obs: Observation, stage: Stage | null, prof: Profile | null, s: Settings): Evaluation {
  const t = obs.t
  const d0 = dayStart(t)
  const shiftStart = d0 + s.shiftFrom * 1000
  const shiftEnd = d0 + s.shiftTo * 1000
  const graceEnd = shiftStart + s.startGrace * 1000
  const inShift = t >= shiftStart && t <= shiftEnd
  const live = obs.sources.filter((x) => x.status === 'live' && !loopBlocked(x) && !viewBlocked(x))
  const analyzable = obs.sources.filter((x) => x.status !== 'unsupported' && x.status !== 'idle')
  const covStart = obs.coverageStart(t)
  const covered = obs.model === 'ready' && covStart != null && live.length > 0
  // Saved recordings are checked together by the server; this player's one view
  // can show sightings but cannot establish site-wide absence or a stage mismatch.
  const enforcement = obs.mode !== 'recording' && obs.complianceEnabled
  const win = s.window * 1000
  const out: Evaluation = { t, stage, slots: [], oop: [], stationary: [], allowed: [], inShift, shiftStart, graceEnd, covered, liveSources: live.length, totalSources: obs.sources.length }
  if (!stage || !prof) return out
  for (const code of CODES) {
    const r = prof.rules[code]
    const cams = covered ? obs.seenWithin(code, t, win) : []
    if (r.lvl === 'req' || r.lvl === 'rec') {
      const slot: Slot = { ...r, state: 'unknown', cams }
      if (!covered) slot.state = 'unknown'
      else if (cams.length) slot.state = 'seen'
      else if (!enforcement || !obs.evaluableClasses.includes(code)) slot.state = 'unknown'
      else if (!inShift) slot.state = 'offshift'
      else {
        const ls = obs.lastSeen(code, t)
        slot.neverSeen = ls == null
        if (ls == null && t < graceEnd) slot.state = 'gathering'
        else {
          // absence is only counted for time we actually watched
          slot.since = Math.max(ls ?? -Infinity, covStart ?? t, ls == null ? graceEnd : -Infinity)
          slot.missFor = Math.max(0, t - slot.since)
          slot.limited = live.length < analyzable.length
          if (r.lvl === 'req') {
            slot.sev = slot.missFor >= r.errAfter * 1000 ? 'err' : slot.missFor >= r.warnAfter * 1000 ? 'warn' : undefined
            slot.state = slot.sev ? 'missing' : 'waiting'
          } else {
            slot.state = 'missing'
            slot.sev = 'info'
          }
        }
      }
      out.slots.push(slot)
    } else if (r.lvl === 'no' && cams.length && enforcement && obs.evaluableClasses.includes(code)) {
      const since = obs.episodeStart(code, t, win * 2) ?? t
      out.oop.push({ ...r, cams, since, dur: t - since })
    } else if (r.lvl === 'skip') out.stationary.push(r)
    else if (r.lvl === 'ok') out.allowed.push(r)
  }
  out.slots.sort((a, b) => LV_ORDER.indexOf(a.lvl) - LV_ORDER.indexOf(b.lvl) || b.p - a.p)
  return out
}

/* ── Events (incidents from the server) ─────────────────── */
export type EventStatus = 'pending' | 'confirmed' | 'false_positive' | 'in_progress' | 'remediation_submitted' | 'resolved'
export interface UiEvent {
  id: string
  projectId?: string
  pprRequirements?: PprCitation[]
  code: string
  kind: 'missing' | 'oop' | 'stream' | 'loop' | 'view' | 'other'
  /** discrepancy type as the server stores it, e.g. MISSING_RECOMMENDED or STREAM_LOST */
  type: string
  mach: Code | null
  sev: 'warn' | 'err'
  status: EventStatus
  title: string
  description: string
  stageId: string | null
  stageName: string | null
  zone: string | null
  camera: string | null
  cameraId: string | null
  createdAt: number
  /** when it was observed; for a recording this is the filmed time */
  at: number
  album: { url: string; camera: string; primary: boolean; at?: string }[]
  decidedAt: number | null
  /** created while recognition ran in demo mode */
  demo: boolean
  /** an example the server returns for an empty journal; it is not stored, so it cannot be decided */
  sample: boolean
  /** the task the server opens with the event: who answers for it, by when, and the recheck of the fix */
  assigneeId: string | null
  assignee: string | null
  deadline: number | null
  check: Check
  checkedAt: number | null
  checkDetails: { working?: number; configured?: number; seen?: string[]; reason?: string; match?: number[]; resolution?: string; resolvedBy?: string }
  escalatedAt: number | null
}
/** The server's recheck of a fix: asked for, then passed (the event closes), failed or impossible. */
export type Check = 'none' | 'requested' | 'passed' | 'failed' | 'unavailable'
/* Lines our events carry in their description, read back to restore context after a reload. */
export const OBSERVED_LINE = 'Время наблюдения: '
export const DEMO_LINE = 'Распознавание: демо-режим, модель недоступна.'
const SAMPLE_IDS = new Set(['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'])
export const STATUS_WORD: Record<EventStatus, string> = {
  pending: 'Ждёт решения',
  confirmed: 'Подтверждено',
  false_positive: 'Ложное срабатывание',
  in_progress: 'В работе',
  remediation_submitted: 'Ожидает приёмки',
  resolved: 'Закрыто',
}
/** Signal lost or back is a fact about a camera, not a hypothesis about the site: nobody confirms it. */
export const awaitsDecision = (e: UiEvent) => e.status === 'pending' && !e.sample && e.kind !== 'stream'
/** Closed events stay closed: the server does not reopen them. */
export const isOpen = (e: UiEvent) => e.status === 'pending' || e.status === 'confirmed' || e.status === 'in_progress' || e.status === 'remediation_submitted'
/** Confirmed or taken into work, not fixed yet. */
export const inWork = (e: UiEvent) => !e.sample && e.kind !== 'stream' && (e.status === 'confirmed' || e.status === 'in_progress')
export const overdue = (e: UiEvent, now: number) => isOpen(e) && e.deadline != null && e.deadline <= now

/** What the user may do with an event. The server checks the same and refuses otherwise. */
export interface Rights {
  /** confirm, take into work, report a fix */
  act: boolean
  /** mark as false: only an administrator */
  dismiss: boolean
  /** why acting is not possible, said instead of the buttons */
  reason?: string
}
export function rightsFor(e: UiEvent, user: UserProfile, owner?: string | null, sharedDemo = false): Rights {
  if (user.role === 'viewer') return { act: false, dismiss: false, reason: 'Роль наблюдателя: решения принимают ответственный и администратор.' }
  const admin = user.role === 'admin'
  if (admin || sharedDemo || e.assigneeId === user.id || (!e.assigneeId && owner === user.username)) return { act: true, dismiss: admin }
  return { act: false, dismiss: false, reason: `Событие назначено${e.assignee ? `: ${e.assignee}` : ' другому пользователю'}. Решение принимает ответственный или администратор.` }
}
export const statusWord = (e: UiEvent) => (e.kind === 'stream' ? 'Видеопоток' : loopDecision(e) ?? viewDecision(e) ?? STATUS_WORD[e.status])
/** A loop closes only when an administrator has seen the live picture. */
export const loopDecision = (e: UiEvent) => (e.kind === 'loop' && e.status === 'resolved' && e.checkDetails.resolution === 'admin_confirmed_live' ? 'Видео живое' : null)
/** How a closed camera-view event ended: the new view was approved, or the camera was put back. */
export const viewDecision = (e: UiEvent) =>
  e.kind !== 'view' || e.status !== 'resolved' ? null : e.checkDetails.resolution === 'accepted' ? 'Смещение согласовано' : e.check === 'passed' ? 'Камера возвращена' : null
/** how an event looks: a camera that came back is news, not a warning */
export const toneOf = (e: UiEvent) => (e.type === 'STREAM_ONLINE' ? 'info' : e.sev)
export function toEvent(a: ApiIncident, media: (u?: string | null) => string | undefined): UiEvent {
  const type = a.discrepancy_type || ''
  const kind = type === 'UNCHARACTERISTIC_PRESENT' ? 'oop' : type.startsWith('MISSING') ? 'missing' : type === 'STREAM_LOOP' ? 'loop' : type.startsWith('STREAM_') ? 'stream' : type.startsWith('VIEW_') ? 'view' : 'other'
  const raw = (a.status || 'pending').toLowerCase()
  const status = (['pending', 'confirmed', 'false_positive', 'in_progress', 'remediation_submitted', 'resolved'].includes(raw) ? raw : 'pending') as EventStatus
  const description = a.description || ''
  // older events carry the observed time in the description; newer ones send it to the server
  const observed = description.split('\n').find((l) => l.startsWith(OBSERVED_LINE))?.slice(OBSERVED_LINE.length) ?? a.first_seen_at
  const observedAt = observed ? new Date(observed).getTime() : NaN
  const time = (v?: string | null) => (v ? new Date(v).getTime() : null)
  const v = (a.verification_status || 'pending').toLowerCase()
  const d = a.verification_details || {}
  return {
    id: a.id,
    projectId: a.project_id,
    pprRequirements: a.ppr_requirements ?? [],
    code: a.code,
    kind,
    type,
    // the server answers «Экскаватор» for an event without machinery; a camera event has none
    mach: kind === 'stream' || kind === 'loop' || kind === 'view' ? null : toCode(a.machinery_type),
    sev: a.severity === 'ERROR' ? 'err' : 'warn',
    status,
    title: a.title || a.code,
    description,
    stageId: a.stage_id ?? null,
    stageName: a.stage_name ?? null,
    zone: a.zone_name ?? null,
    camera: a.camera_name ?? null,
    cameraId: a.camera_id ?? null,
    createdAt: new Date(a.created_at).getTime(),
    at: Number.isFinite(observedAt) ? observedAt : new Date(a.created_at).getTime(),
    album: (a.album_photos || []).map((p, i) => ({ url: media(p.url) || p.url, camera: p.camera_name || `Камера ${i + 1}`, primary: !!p.is_primary, at: p.captured_at })),
    decidedAt: null,
    demo: description.includes(DEMO_LINE),
    sample: SAMPLE_IDS.has(a.id),
    assigneeId: a.assigned_user_id ?? null,
    assignee: a.assignee_name ?? null,
    deadline: time(a.sla_deadline),
    check: (['requested', 'passed', 'failed', 'unavailable'].includes(v) ? v : 'none') as Check,
    checkedAt: time(a.last_checked_at),
    checkDetails: { working: d.working_cameras, configured: d.configured_cameras, seen: d.observed_machinery, reason: d.reason, match: d.view_match, resolution: d.resolution, resolvedBy: d.resolved_by },
    escalatedAt: time(a.escalated_at),
  }
}
/** Descriptions we create carry labelled lines; older ones are shown as one block. */
export function parseDescription(text: string) {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = line.match(/^(Наблюдение|Качество данных|Правило):\s*(.+)$/)
    if (m) out[m[1]] = m[2]
  }
  if (!Object.keys(out).length && text.trim()) out['Наблюдение'] = text.trim()
  return out
}

/** Session knowledge about an episode: when the absence began and whether it ended. */
export interface Episode { from: number; to?: number }

export function liveTitle(e: UiEvent, ep: Episode | undefined, t: number, words = false) {
  if (!ep || !e.mach) return e.title
  const d = (ep.to ?? t) - ep.from
  const dd = words ? durWords(d) : durShort(d)
  if (e.kind === 'missing') return `${MACH[e.mach].name} не замечен ${dd}`
  if (e.kind === 'oop') return `${MACH[e.mach].name} не по этапу ${dd}`
  return e.title
}
export function sevNow(e: UiEvent, ep: Episode | undefined, t: number, prof: Profile | null) {
  if (e.kind !== 'missing' || e.type === 'MISSING_RECOMMENDED' || !ep || !e.mach || !prof) return e.sev
  const r = prof.rules[e.mach]
  return (ep.to ?? t) - ep.from >= r.errAfter * 1000 ? 'err' : e.sev
}

/* ── Verdict ────────────────────────────────────────────── */
export interface VerdictAction { label: string; act: string; id?: string; primary?: boolean }
export interface Verdict { tone: 'ok' | 'warn' | 'err' | 'nodata' | 'none'; title: string; sub: string; actions?: VerdictAction[] }

const CONSEQ: Partial<Record<Code, string>> = {
  dump_truck: 'Без самосвалов грунт не вывозится, темп этапа может снизиться.',
  excavator: 'Без экскаватора разработка грунта не ведётся.',
  concrete_pump: 'Без бетононасоса бетонирование не ведётся.',
  concrete_mixer: 'Без автобетоносмесителя бетон на площадку не поступает.',
  tower_crane: 'Без крана подача материалов на захватки невозможна.',
  bulldozer: 'Без бульдозера планировка и перемещение грунта не ведутся.',
}
export const consequence = (c: Code | null) => (c && CONSEQ[c]) || 'Техника обязательна для этапа по плану.'

export function eventConsequence(e: UiEvent) {
  if (e.pprRequirements?.length) {
    if (e.kind === 'missing') return 'Техника, обязательная по ППР, не распознана в доступных кадрах.'
    if (e.kind === 'oop') return 'В доступных кадрах распознана техника, присутствие которой запрещено требованиями ППР.'
  }
  return e.kind === 'missing' ? consequence(e.mach) : 'Техника на площадке не соответствует текущему этапу плана.'
}

export function verdictOf(ctx: {
  ev: Evaluation
  obs: Observation
  events: UiEvent[]
  episodes: Map<string, Episode>
  prof: Profile | null
  hasPlan: boolean
  s: Settings
}): Verdict {
  const { ev, obs, events, episodes, prof, hasPlan, s } = ctx
  const t = ev.t
  if (!hasPlan) return { tone: 'none', title: 'План работ не загружен', sub: 'Календарный план не загружен: поэтапная сверка техники недоступна. Активные требования ППР применяются при серверной проверке сохранённых записей.', actions: [{ label: 'Загрузить план', act: 'setup', primary: true }] }
  if (!obs.sources.length) return { tone: 'none', title: 'Нет источников кадров', sub: 'Подключите камеру или загрузите запись с датой и временем начала съёмки.', actions: [{ label: 'Добавить источник', act: 'setup', primary: true }] }
  if (!ev.stage) return { tone: 'none', title: `На ${fmtDay(t)} в плане нет работ`, sub: 'Сверка не выполняется: дата наблюдения вне сроков этапов.', actions: [{ label: 'Открыть план', act: 'plan' }] }
  const unsupported = obs.sources.filter((x) => x.status === 'unsupported')
  if (unsupported.length === obs.sources.length)
    return { tone: 'nodata', title: 'Камеры недоступны для анализа', sub: 'RTSP-поток не воспроизводится в браузере. Добавьте камеру с HTTP или MJPEG-потоком, загрузите запись или подключите серверный шлюз.', actions: [{ label: 'Источники', act: 'settings:sources', primary: true }] }
  if (obs.model === 'down') {
    const since = obs.modelSince ? ` с ${hhmm(obs.modelSince)}` : ''
    return { tone: 'nodata', title: 'Распознавание остановлено', sub: `Сервис распознавания не работает${since}: ${obs.modelMessage || 'причина не сообщена'}. Кадры приходят, но техника на них не определяется, поэтому отклонения не создаются.`, actions: [{ label: 'Состояние сервиса', act: 'settings:sources' }] }
  }
  const live = obs.sources.filter((x) => x.status === 'live')
  if (!live.length) {
    const connecting = obs.sources.some((x) => x.status === 'connecting')
    return connecting
      ? { tone: 'none', title: 'Подключаемся к источникам', sub: 'Первый анализ появится через несколько секунд после получения кадра.' }
      : { tone: 'nodata', title: 'Нет кадров ни с одного источника', sub: 'Выводов об отсутствии техники нет, пока кадры не приходят.', actions: [{ label: 'Проверить камеры', act: 'settings:sources', primary: true }] }
  }
  // every camera that gives frames replays a recording, looks away from its approved view, or is being moved
  if (!live.some((x) => !loopBlocked(x) && !viewBlocked(x))) return loopBlocked(live[0]) ? loopVerdict(live[0], events) : viewVerdict(live[0], events)
  if (!prof) return { tone: 'none', title: 'Загружаем профиль техники этапа', sub: `Этап ${ev.stage.n} «${ev.stage.name}»: какая техника для него нужна, придёт с сервера через секунду.` }
  if (!ev.covered) return { tone: 'none', title: 'Анализируем первые кадры', sub: 'Сверка начнётся после первого распознанного кадра.' }

  const pending = events
    .filter(awaitsDecision)
    .sort((a, b) => (sevNow(b, episodes.get(b.id), t, prof) === 'err' ? 1 : 0) - (sevNow(a, episodes.get(a.id), t, prof) === 'err' ? 1 : 0) || b.createdAt - a.createdAt)
  const seenReq = ev.slots.filter((x) => x.state === 'seen').map((x) => MACH[x.code].lower)
  const off = obs.sources.filter((x) => x.status === 'offline' || x.status === 'stale')

  if (!ev.inShift)
    return { tone: 'none', title: t < ev.shiftStart ? 'Смена ещё не началась' : 'Смена закончилась', sub: `Отсутствие техники вне смены не считается отклонением. Смена: ${hhmm(ev.shiftStart)}–${hhmm(ev.shiftStart + (s.shiftTo - s.shiftFrom) * 1000)}.` }

  if (pending.length) {
    const e = pending[0]
    const ep = episodes.get(e.id)
    const others = pending.length - 1
    let sub = ''
    const nowSeen = !!e.mach && ev.slots.some((x) => x.code === e.mach && x.state === 'seen')
    if (!ep) sub = `Событие от ${fmtDay(e.at)}, ${hhmm(e.at)} ждёт решения.${e.mach ? (nowSeen ? ` Сейчас ${MACH[e.mach].lower} на месте.` : '') : ''}`
    else if (e.kind === 'missing' && e.mach) {
      const seen = seenReq.filter((n) => n !== MACH[e.mach!].lower)
      sub = (seen.length ? `**${cap(seen.join(', '))}** на месте, ${MACH[e.mach].lower} не виден с ${hhmm(ep.from)}. ` : '') + eventConsequence(e)
    } else sub = e.description.split('\n')[0].replace(/^Правило:\s*/, '')
    if (off.length) sub += ` ${off.length} из ${obs.sources.length} источников без сигнала, вывод ограничен.`
    if (others > 0) sub += ` Ещё ${others} ${plural(others, 'событие ждёт', 'события ждут', 'событий ждут')} решения.`
    return { tone: sevNow(e, ep, t, prof), title: liveTitle(e, ep, t, true), sub, actions: [{ label: 'Разобрать', act: 'case', id: e.id, primary: true }] }
  }
  // deadlines are wall-clock time, also while a recording is replayed
  const now = Date.now()
  const late = events.filter((e) => inWork(e) && overdue(e, now)).sort((a, b) => a.deadline! - b.deadline!)[0]
  if (late)
    return {
      tone: 'err',
      title: `Срок исправления истёк ${durWords(now - late.deadline!)} назад`,
      sub: `«${late.title}»${late.assignee ? `, ответственный ${late.assignee}` : ''}, срок был до ${atTime(late.deadline!, now)}. ${late.escalatedAt ? `Передано руководителю в ${atTime(late.escalatedAt, now)}.` : 'Сервер проверит камеры и передаст событие руководителю, если нарушение останется.'}`,
      actions: [{ label: 'Открыть', act: 'case', id: late.id, primary: true }],
    }
  // a confirmed deviation is still a deviation until the machine is back
  const held = events.find((e) => inWork(e) && episodes.get(e.id) && episodes.get(e.id)!.to == null)
  if (held)
    return {
      tone: sevNow(held, episodes.get(held.id), t, prof),
      title: liveTitle(held, episodes.get(held.id), t, true),
      sub: `${held.status === 'confirmed' ? 'Отклонение подтверждено' : 'Передано в работу'}${held.decidedAt ? ` в ${hhmm(held.decidedAt)}` : ''}. ${held.check === 'requested' ? 'Проверка исправления запрошена: сервер сверит кадры камер.' : `Ситуация продолжается${held.deadline ? `, исправить до ${atTime(held.deadline, now)}` : ''}.`}`,
      actions: [{ label: 'Открыть', act: 'case', id: held.id }],
    }
  if (off.length) {
    const c = off[0]
    return { tone: 'warn', title: `Источник «${c.name}» ${c.status === 'stale' ? 'присылает застывший кадр' : 'без сигнала'}`, sub: `Работают ${live.length} из ${obs.sources.length}. Для зоны этого источника вывод об отсутствии техники не делается.`, actions: [{ label: 'Проверить', act: 'settings:sources', primary: true }] }
  }
  const looped = live.find(loopBlocked)
  if (looped) {
    const v = loopVerdict(looped, events)
    return { ...v, sub: `${v.sub} Сверка идёт по остальным ${live.length - 1} из ${obs.sources.length} источников.` }
  }
  const turned = live.find(viewBlocked)
  if (turned) {
    const v = viewVerdict(turned, events)
    return { ...v, tone: v.tone === 'err' ? 'warn' : v.tone, sub: `${v.sub} Сверка идёт по остальным ${live.length - 1} из ${obs.sources.length} источников.` }
  }
  const req = ev.slots.filter((x) => x.lvl === 'req')
  if (!obs.complianceEnabled || !obs.evaluableClasses.length || req.some((x) => x.state === 'unknown' || !obs.evaluableClasses.includes(x.code))) {
    const observed = seenReq.length ? `В кадрах замечены: ${seenReq.join(', ')}. ` : ''
    return { tone: 'none', title: 'Распознавание техники работает', sub: `${observed}Показываем результаты распознавания. Данных для полной сверки техники с планом недостаточно.` }
  }
  if (ev.oop.length) {
    const o = ev.oop[0]
    return { tone: 'warn', title: `${MACH[o.code].name} на этапе «${ev.stage.name}»`, sub: `Техника не характерна для этапа. Если останется ещё ${durShort(Math.max(0, s.oopAfter * 1000 - o.dur))}, будет создано отклонение.` }
  }
  const gathering = ev.slots.find((x) => x.state === 'gathering')
  if (gathering) return { tone: 'ok', title: 'Сбор техники после начала смены', sub: `До ${hhmm(ev.graceEnd)} отсутствие техники не считается отклонением.${seenReq.length ? ` Уже на месте: ${seenReq.join(', ')}.` : ''}` }
  const waiting = ev.slots.find((x) => x.state === 'waiting')
  if (waiting && waiting.missFor != null)
    return { tone: 'ok', title: 'Работы идут по плану', sub: `${MACH[waiting.code].name} не виден ${durShort(waiting.missFor)}. Если не появится ещё ${durShort(waiting.warnAfter * 1000 - waiting.missFor)}, система предупредит.` }
  if (req.some((x) => x.state !== 'seen'))
    return { tone: 'none', title: 'Сверка этапа продолжается', sub: seenReq.length ? `В кадрах замечены: ${seenReq.join(', ')}. Наличие всей обязательной техники пока не подтверждено.` : 'Наличие обязательной техники пока не подтверждено.' }
  return {
    tone: 'ok',
    title: 'Работы идут по плану',
    sub: req.length ? `Обязательная техника этапа замечена за последние ${s.window} секунд: ${req.map((x) => MACH[x.code].lower).join(', ')}.` : 'Для этапа нет обязательной техники.',
  }
}
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1)

function loopVerdict(c: SourceView, events: UiEvent[]): Verdict {
  const l = c.loop!
  const e = events.find((x) => x.kind === 'loop' && isOpen(x) && x.cameraId === c.id)
  return {
    tone: 'err',
    title: `Камера «${c.name}» повторяет запись`,
    sub: `Кадры повторяются${l.period ? ` с периодом около ${durShort(l.period)}` : ''}${l.since ? ` с ${hhmm(l.since)}` : ''}: живая площадка так не повторяется. Пока повтор идёт, вывод о технике по этой камере не делается.`,
    actions: e ? [{ label: 'Разобрать', act: 'case', id: e.id, primary: true }] : [{ label: 'Источники', act: 'settings:sources', primary: true }],
  }
}

function viewVerdict(c: SourceView, events: UiEvent[]): Verdict {
  const v = c.view!
  if (v.state === 'move')
    return {
      tone: 'none',
      title: `Камера «${c.name}» переносится`,
      sub: `Перенос согласован${v.moveUntil ? ` до ${atTime(v.moveUntil)}` : ''}${v.moveBy ? ` · ${v.moveBy}` : ''}. Пока новый ракурс не утверждён, кадры этой камеры не сверяются с планом.`,
      actions: [{ label: 'Ракурс камеры', act: 'settings:sources', primary: true }],
    }
  const e = events.find((x) => x.kind === 'view' && x.type === 'VIEW_CHANGED' && isOpen(x) && x.cameraId === c.id)
  const turn = v.problem === 'turned' ? turnText(v) : ''
  return {
    tone: 'err',
    title: `Ракурс камеры «${c.name}» изменён`,
    sub: `${cap(v.problem ? PROBLEM_WORD[v.problem] : 'кадр не совпадает с утверждённым')}${turn}${v.since ? ` с ${hhmm(v.since)}` : ''}. Пока камера смотрит не туда, вывод о технике по ней не делается.`,
    actions: e ? [{ label: 'Разобрать', act: 'case', id: e.id, primary: true }] : [{ label: 'Ракурс камеры', act: 'settings:sources', primary: true }],
  }
}
const turnText = (v: ViewCheck) => {
  const w = turnWordsOf(v)
  return w ? ` ${w}` : ''
}
