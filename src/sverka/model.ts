import type { ApiIncident, ApiProfile, StageItem } from './api'
import { CODES, MACH, toCode, type Code } from './lib/machinery'
import { dayStart, durShort, durWords, fmtDay, hhmm, planDay, plural, DAY_MS } from './lib/format'

/* ── Requirement levels ─────────────────────────────────── */
export type Level = 'req' | 'rec' | 'ok' | 'no' | 'skip'
export const LV: Record<Level, { label: string; group: string; explain: string }> = {
  req: { label: 'Обязательна', group: 'Обязательная', explain: 'Отсутствие создаёт предупреждение, затем отклонение.' },
  rec: { label: 'Рекомендуется', group: 'Рекомендуемая', explain: 'Отмечается в сверке, событий не создаёт.' },
  ok: { label: 'Допустима', group: 'Допустимая', explain: 'Может быть на площадке, в сверке не участвует.' },
  no: { label: 'Не характерна', group: 'Не характерная', explain: 'Появление на площадке создаёт отклонение.' },
  skip: { label: 'Не учитывается', group: 'Не учитывается', explain: 'Не участвует в сверке. Подходит для стационарной техники: башенного крана, бытовок.' },
}
export const LV_ORDER: Level[] = ['req', 'rec', 'ok', 'no', 'skip']
const CLS_TO_LV: Record<string, Level> = { MANDATORY: 'req', RECOMMENDED: 'rec', NEUTRAL: 'ok', UNCHARACTERISTIC: 'no' }
/** The server knows four levels; "не учитывается" exists only in this browser for now. */
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
  demo: boolean // substitute demo recognition when the model is unavailable
}
export const DEFAULTS: Settings = { window: 30, conf: 60, warnAfter: 300, errAfter: 1800, oopAfter: 60, shiftFrom: 7 * 3600, shiftTo: 19 * 3600, startGrace: 1800, demo: true }
export type NumKey = Exclude<keyof Settings, 'demo'>
export const STEPS: Record<NumKey, number[]> = {
  window: [10, 15, 30, 60, 120],
  conf: [40, 50, 60, 70, 80, 90],
  warnAfter: [60, 120, 180, 300, 600, 900, 1200, 1800],
  errAfter: [600, 900, 1200, 1800, 2700, 3600, 5400],
  oopAfter: [30, 60, 120, 300, 600],
  shiftFrom: [5, 6, 7, 8, 9].map((h) => h * 3600),
  shiftTo: [17, 18, 19, 20, 21, 22, 24].map((h) => h * 3600),
  startGrace: [0, 900, 1800, 2700, 3600],
}
export function loadSettings(projectId: string): Settings {
  try {
    const raw = localStorage.getItem(`sverka:settings:${projectId}`)
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    // storage unavailable
  }
  return { ...DEFAULTS }
}
export function saveSettings(projectId: string, s: Settings) {
  try {
    localStorage.setItem(`sverka:settings:${projectId}`, JSON.stringify(s))
  } catch {
    // storage unavailable
  }
}

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
}
export interface Profile {
  stageId: string
  catalog: string | null
  similarity: number
  rules: Record<Code, Rule>
  edited: boolean
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
    const l = local[code]
    rules[code] = {
      code,
      p: item?.probability ?? 0,
      baseP: item?.probability ?? 0,
      base: l?.base ?? server,
      lvl: l?.skip ? 'skip' : server,
      edited: !!l,
      warnAfter: l?.warnAfter ?? s.warnAfter,
      errAfter: l?.errAfter ?? s.errAfter,
      ownTiming: l?.warnAfter != null || l?.errAfter != null,
    }
  }
  return { stageId: api.stage_id, catalog: api.matched_catalog_stage ?? null, similarity: api.similarity_confidence, rules, edited: Object.keys(local).length > 0 }
}

/* ── Observation (provided by the engine) ───────────────── */
export interface Det { code: Code; c: number; x: number; y: number; w: number; h: number; demo?: boolean }
export type SourceStatus = 'connecting' | 'live' | 'stale' | 'offline' | 'unsupported' | 'idle'
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
}
export interface Observation {
  mode: 'live' | 'recording'
  t: number
  sources: SourceView[]
  model: 'unknown' | 'ready' | 'down' | 'demo'
  modelMessage?: string
  modelSince?: number
  frames: number
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
  const live = obs.sources.filter((x) => x.status === 'live')
  const analyzable = obs.sources.filter((x) => x.status !== 'unsupported' && x.status !== 'idle')
  const covStart = obs.coverageStart(t)
  const covered = (obs.model === 'ready' || obs.model === 'demo') && covStart != null && live.length > 0
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
    } else if (r.lvl === 'no' && cams.length) {
      const since = obs.episodeStart(code, t, win * 2) ?? t
      out.oop.push({ ...r, cams, since, dur: t - since })
    } else if (r.lvl === 'skip') out.stationary.push(r)
    else if (r.lvl === 'ok') out.allowed.push(r)
  }
  out.slots.sort((a, b) => LV_ORDER.indexOf(a.lvl) - LV_ORDER.indexOf(b.lvl) || b.p - a.p)
  return out
}

/* ── Events (incidents from the server) ─────────────────── */
export type EventStatus = 'pending' | 'confirmed' | 'false_positive' | 'in_progress' | 'resolved'
export interface UiEvent {
  id: string
  code: string
  kind: 'missing' | 'oop' | 'other'
  mach: Code | null
  sev: 'warn' | 'err'
  status: EventStatus
  title: string
  description: string
  stageId: string | null
  stageName: string | null
  zone: string | null
  createdAt: number
  /** when it was observed; for a recording this is the filmed time */
  at: number
  album: { url: string; camera: string; primary: boolean; at?: string }[]
  decidedAt: number | null
  /** created while recognition ran in demo mode */
  demo: boolean
  /** an example the server returns for an empty journal; it is not stored, so it cannot be decided */
  sample: boolean
}
/* Lines our events carry in their description, read back to restore context after a reload. */
export const OBSERVED_LINE = 'Время наблюдения: '
export const DEMO_LINE = 'Распознавание: демо-режим, модель недоступна.'
const SAMPLE_IDS = new Set(['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'])
export const STATUS_WORD: Record<EventStatus, string> = {
  pending: 'Ждёт решения',
  confirmed: 'Подтверждено',
  false_positive: 'Ложное срабатывание',
  in_progress: 'В работе',
  resolved: 'Устранено',
}
export function toEvent(a: ApiIncident, media: (u?: string | null) => string | undefined): UiEvent {
  const kind = a.discrepancy_type === 'UNCHARACTERISTIC_PRESENT' ? 'oop' : a.discrepancy_type?.startsWith('MISSING') ? 'missing' : 'other'
  const raw = (a.status || 'pending').toLowerCase()
  const status = (['pending', 'confirmed', 'false_positive', 'in_progress', 'resolved'].includes(raw) ? raw : 'pending') as EventStatus
  const description = a.description || ''
  const observed = description.split('\n').find((l) => l.startsWith(OBSERVED_LINE))?.slice(OBSERVED_LINE.length)
  const observedAt = observed ? new Date(observed).getTime() : NaN
  return {
    id: a.id,
    code: a.code,
    kind,
    mach: toCode(a.machinery_type),
    sev: a.severity === 'ERROR' ? 'err' : 'warn',
    status,
    title: a.title || a.code,
    description,
    stageId: a.stage_id ?? null,
    stageName: a.stage_name ?? null,
    zone: a.zone_name ?? null,
    createdAt: new Date(a.created_at).getTime(),
    at: Number.isFinite(observedAt) ? observedAt : new Date(a.created_at).getTime(),
    album: (a.album_photos || []).map((p, i) => ({ url: media(p.url) || p.url, camera: p.camera_name || `Камера ${i + 1}`, primary: !!p.is_primary, at: p.captured_at })),
    decidedAt: null,
    demo: description.includes(DEMO_LINE),
    sample: SAMPLE_IDS.has(a.id),
  }
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
  if (e.kind !== 'missing' || !ep || !e.mach || !prof) return e.sev
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
  if (!hasPlan) return { tone: 'none', title: 'План работ не загружен', sub: 'Без плана система не знает, какая техника должна быть на площадке.', actions: [{ label: 'Загрузить план', act: 'setup', primary: true }] }
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
  if (!prof) return { tone: 'none', title: 'Загружаем профиль техники этапа', sub: `Этап ${ev.stage.n} «${ev.stage.name}»: какая техника для него нужна, придёт с сервера через секунду.` }
  if (!ev.covered) return { tone: 'none', title: 'Анализируем первые кадры', sub: 'Сверка начнётся после первого распознанного кадра.' }

  const pending = events
    .filter((e) => e.status === 'pending' && !e.sample)
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
      sub = (seen.length ? `**${cap(seen.join(', '))}** на месте, ${MACH[e.mach].lower} не виден с ${hhmm(ep.from)}. ` : '') + consequence(e.mach)
    } else sub = e.description.split('\n')[0].replace(/^Правило:\s*/, '')
    if (off.length) sub += ` ${off.length} из ${obs.sources.length} источников без сигнала, вывод ограничен.`
    if (others > 0) sub += ` Ещё ${others} ${plural(others, 'событие ждёт', 'события ждут', 'событий ждут')} решения.`
    return { tone: sevNow(e, ep, t, prof), title: liveTitle(e, ep, t, true), sub, actions: [{ label: 'Разобрать', act: 'case', id: e.id, primary: true }] }
  }
  // a confirmed deviation is still a deviation until the machine is back
  const held = events.find((e) => !e.sample && (e.status === 'confirmed' || e.status === 'in_progress') && episodes.get(e.id) && episodes.get(e.id)!.to == null)
  if (held)
    return {
      tone: sevNow(held, episodes.get(held.id), t, prof),
      title: liveTitle(held, episodes.get(held.id), t, true),
      sub: `${held.status === 'confirmed' ? 'Отклонение подтверждено' : 'Передано в работу'}${held.decidedAt ? ` в ${hhmm(held.decidedAt)}` : ''}. Ситуация продолжается, событие закроется, когда ${held.mach ? `${MACH[held.mach].lower} появится на камерах` : 'ситуация изменится'}.`,
      actions: [{ label: 'Открыть', act: 'case', id: held.id }],
    }
  if (off.length) {
    const c = off[0]
    return { tone: 'warn', title: `Источник «${c.name}» ${c.status === 'stale' ? 'присылает застывший кадр' : 'без сигнала'}`, sub: `Работают ${live.length} из ${obs.sources.length}. Для зоны этого источника вывод об отсутствии техники не делается.`, actions: [{ label: 'Проверить', act: 'settings:sources', primary: true }] }
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
  const req = ev.slots.filter((x) => x.lvl === 'req')
  return {
    tone: 'ok',
    title: 'Работы идут по плану',
    sub: req.length ? `Обязательная техника этапа замечена за последние ${s.window} секунд: ${seenReq.join(', ')}.` : 'Для этапа нет обязательной техники.',
  }
}
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1)
