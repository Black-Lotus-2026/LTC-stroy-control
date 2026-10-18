import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import * as api from '../api'
import type { AdminRecipient, ApiIncidentEvent, InactionCurve, UserProfile } from '../api'
import type { Episode, EventStatus, Observation, Profile, Rights, Stage, UiEvent } from '../model'
import { LV, STATUS_WORD, consequence, isOpen, liveTitle, loopDecision, parseDescription, sevNow, stageDay, toneOf } from '../model'
import { MACH, type Code } from '../lib/machinery'
import { atTime, durShort, fmtDay, hhmm, hhmmss } from '../lib/format'
import { Spring, clamp, lerp, reducedMotion } from '../lib/spring'
import { CloseIcon, SevIcon } from './common'
import { Lightbox } from './Lightbox'
import { CostMissing, CostOfInaction } from './Cost'

const SEV_WORD = { warn: 'Предупреждение', err: 'Отклонение', info: 'Сведения' }

export function CaseFile({
  ev,
  ep,
  stage,
  prof,
  obs,
  origin,
  rights,
  user,
  admins,
  onClose,
  onDecide,
  onRule,
  onPlan,
}: {
  ev: UiEvent
  ep?: Episode
  stage: Stage | null
  prof: Profile | null
  obs: Observation
  origin: DOMRect | null
  rights: Rights
  user: UserProfile
  admins: AdminRecipient[]
  onClose: () => void
  onDecide: (status: EventStatus) => Promise<void>
  onRule: (code: Code) => void
  onPlan: () => void
}) {
  const el = useRef<HTMLElement>(null)
  const scrim = useRef<HTMLDivElement | null>(null)
  const closing = useRef(false)
  const [shot, setShot] = useState(() => Math.max(0, ev.album.findIndex((a) => a.primary)))
  const [broken, setBroken] = useState<Set<string>>(new Set())
  const [save, setSave] = useState<{ s: 'idle' | 'saving' | 'saved' | 'error'; msg?: string }>({ s: 'idle' })
  const [lb, setLb] = useState(false)
  // a decision can be changed later: the operator opens the choice again
  const [redo, setRedo] = useState(false)
  const rect = useRef<{ left: number; top: number; width: number; height: number } | null>(null)
  const springRef = useRef<Spring | null>(null)
  // what happened to the event on the server: decisions, the task, rechecks, escalation
  const [hist, setHist] = useState<ApiIncidentEvent[] | string | null>(null)
  const [histOpen, setHistOpen] = useState(false)
  useEffect(() => {
    if (ev.sample) return
    let alive = true
    api.incidentEvents(ev.id).then(
      (h) => alive && setHist(h),
      (e: Error) => alive && setHist(e.message),
    )
    return () => {
      alive = false
    }
  }, [ev.id, ev.sample, ev.status, ev.check, ev.escalatedAt])
  // the scenario estimate of inaction exists only for events about machinery
  const [cost, setCost] = useState<InactionCurve | string | null>(null)
  useEffect(() => {
    if (ev.sample || (ev.kind !== 'missing' && ev.kind !== 'oop')) return
    const ctl = new AbortController()
    api.inactionCost(ev.id, ctl.signal).then(setCost, (e: Error) => !ctl.signal.aborted && setCost(e.message))
    return () => ctl.abort()
  }, [ev.id, ev.sample, ev.kind])

  const computeRect = () => {
    if (matchMedia('(max-width: 860px)').matches) return { left: 0, top: 0, width: innerWidth, height: innerHeight }
    const dockMin = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dock-min')) || 104
    // over the journal the case takes the journal's height, so its rows do not show below
    const below = document.querySelector('.journal') ? 12 : dockMin + 10
    return { left: 20, top: 64, width: innerWidth - 40, height: innerHeight - 64 - below }
  }
  const paint = (p: number) => {
    const c = el.current
    const R = rect.current
    if (!c || !R) return
    const o = origin || new DOMRect(R.left + R.width - 60, R.top + 40, 40, 40)
    const q = clamp(p, 0, 1.04)
    const top = lerp(o.top - R.top, 0, q)
    const left = lerp(o.left - R.left, 0, q)
    const right = lerp(R.left + R.width - (o.left + o.width), 0, q)
    const bottom = lerp(R.top + R.height - (o.top + o.height), 0, q)
    const rad = lerp(7, matchMedia('(max-width: 860px)').matches ? 0 : 12, clamp(q, 0, 1))
    // the panel grows out of the card that opened it, and returns there on close
    c.style.clipPath = `inset(${top}px ${right}px ${bottom}px ${left}px round ${rad}px)`
    if (scrim.current) scrim.current.style.opacity = String(clamp(p, 0, 1))
    const inner = String(clamp((p - 0.35) / 0.5, 0, 1))
    c.querySelectorAll<HTMLElement>('.case-body, .case-ev').forEach((n) => (n.style.opacity = inner))
  }
  useLayoutEffect(() => {
    rect.current = computeRect()
    const c = el.current!
    Object.assign(c.style, { left: rect.current.left + 'px', top: rect.current.top + 'px', width: rect.current.width + 'px', height: rect.current.height + 'px' })
    springRef.current = new Spring(0, { response: 0.5, damping: 0.9, rest: 0.002, onUpdate: paint })
    paint(0)
    springRef.current.to(1)
    if (!reducedMotion())
      c.querySelectorAll('.step').forEach((s, i) => s.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 420, delay: 260 + i * 80, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' }))
    const back = document.activeElement as HTMLElement | null
    window.setTimeout(() => c.querySelector<HTMLElement>('#caseTitle')?.focus({ preventScroll: true }), 60)
    return () => {
      back?.focus?.({ preventScroll: true })
    }
    // opening runs once per mounted case
  }, [])
  const close = () => {
    if (closing.current) return
    closing.current = true
    springRef.current!.to(0, { damping: 1, onRest: onClose })
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (lb) return
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
      if ((ev.status !== 'pending' && !redo) || ev.sample || ev.kind === 'stream' || !rights.act || !isOpen(ev)) return
      const m: Record<string, EventStatus> = { '1': 'confirmed', '3': 'in_progress', ...(rights.dismiss ? { '2': 'false_positive' as const } : {}) }
      if (m[e.key] && m[e.key] !== ev.status) decide(m[e.key])
      if (e.key === 'Tab') {
        const f = Array.from(el.current!.querySelectorAll<HTMLElement>('button:not([disabled]), textarea, a[href], [tabindex="0"]'))
        const i = f.indexOf(document.activeElement as HTMLElement)
        if (e.shiftKey && i <= 0) {
          e.preventDefault()
          f[f.length - 1]?.focus()
        } else if (!e.shiftKey && i === f.length - 1) {
          e.preventDefault()
          f[0]?.focus()
        }
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  const decide = async (status: EventStatus) => {
    if (save.s === 'saving') return
    setSave({ s: 'saving' })
    try {
      await onDecide(status)
      setSave({ s: 'saved' })
      window.setTimeout(close, 480)
    } catch (e) {
      setSave({ s: 'error', msg: e instanceof Error ? e.message : 'Не удалось сохранить решение' })
    }
  }

  const sev = sevNow(ev, ep, obs.t, prof)
  const tone = toneOf(ev) === 'info' ? 'info' : sev
  const rec = ev.type === 'MISSING_RECOMMENDED'
  const r = ev.mach && prof ? prof.rules[ev.mach] : null
  const desc = parseDescription(ev.description)
  const day = stage ? stageDay(stage, ev.at) : 0
  const live = obs.sources.filter((s) => s.status === 'live').length
  const steps: { tone: string; h: string; p: React.ReactNode; src?: React.ReactNode; extra?: React.ReactNode }[] = []
  steps.push({
    tone: 'plan',
    h: 'План',
    p: stage ? (
      <>
        {fmtDay(ev.at)} идёт этап {stage.n} «{stage.name}» <span className="dim">({fmtDay(stage.start)} – {fmtDay(stage.end)}, день {day} из {stage.days})</span>.
      </>
    ) : (
      <>Этап: {ev.stageName || 'не указан'}.</>
    ),
    src: (
      <button type="button" className="link" onClick={onPlan}>
        Открыть план
      </button>
    ),
  })
  if (ev.mach)
    steps.push({
      tone: 'plan',
      h: 'Правило',
      p: r ? (
        <>
          {MACH[ev.mach].name}: {LV[r.lvl].group.toLowerCase()} техника на этом этапе{r.edited ? <span className="dim"> (изменено, до изменения: {LV[r.base].label.toLowerCase()})</span> : ''}.
          {ev.kind === 'missing' && (rec ? ` Предупреждение через ${durShort(r.warnAfter * 1000)} без наблюдения; отсутствие рекомендуемой техники отклонением не становится.` : ` Предупреждение через ${durShort(r.warnAfter * 1000)} без наблюдения, отклонение через ${durShort(r.errAfter * 1000)}.`)}
        </>
      ) : (
        desc['Правило'] || 'Профиль этапа не загружен.'
      ),
      src: (
        <>
          {stage?.catalog && <span>Справочник: {stage.catalog}{r ? ` · ${Math.round(r.p * 100)}%` : ''}</span>}
          <button type="button" className="link" onClick={() => onRule(ev.mach!)}>
            Настроить
          </button>
        </>
      ),
    })
  steps.push({
    tone,
    h: 'Наблюдение',
    p: (
      <>
        {desc['Наблюдение'] || 'Подробности наблюдения не сохранены.'}
        {ep && <span className="dim"> {ep.to ? `Техника вернулась в ${hhmmss(ep.to)}.` : `Продолжается ${durShort(obs.t - ep.from)}.`}</span>}
      </>
    ),
  })
  steps.push({
    tone: desc['Качество данных']?.includes('ограничен') ? 'warn' : 'ok',
    h: 'Качество данных',
    p: desc['Качество данных'] || (ep ? `Сейчас кадры дают ${live} из ${obs.sources.length} источников, распознавание ${obs.model === 'ready' ? 'работает' : 'недоступно'}.` : 'Сведения о качестве данных для этого события не сохранены.'),
  })
  steps.push({
    tone,
    h: 'Вывод',
    p:
      ev.kind === 'stream'
        ? 'Событие видеопотока. Это сведения о камере, а не вывод о площадке, решение по нему не требуется.'
        : ev.kind === 'loop'
          ? `Отклонение: вместо камеры похоже идёт запись.${!isOpen(ev) ? ` Решение: ${(loopDecision(ev) ?? STATUS_WORD[ev.status]).toLowerCase()}.` : ' За минуту повтор не исключить, поэтому сервер сам событие не закрывает: это делает администратор, убедившись, что камера показывает площадку вживую.'}`
        : ev.kind === 'missing' && !rec && r && ep && !ep.to && sev !== 'err'
        ? `${SEV_WORD[sev]}. Станет отклонением через ${durShort(Math.max(0, r.errAfter * 1000 - (obs.t - ep.from)))}, если ${MACH[ev.mach!].lower} не появится.`
        : `${SEV_WORD[sev]}.${ev.status !== 'pending' ? ` Решение: ${STATUS_WORD[ev.status].toLowerCase()}.` : ''}`,
    extra: cost == null ? undefined : typeof cost === 'string' ? <p className="cost-none">Цена бездействия недоступна: {cost}.</p> : cost.status === 'unavailable' ? <CostMissing curve={cost} /> : <CostOfInaction curve={cost} />,
  })

  const photo = ev.album[shot]
  const decidedAt = ev.decidedAt ?? lastDecision(hist)
  return (
    <>
      <div className="scrim" data-on="true" ref={scrim} onClick={close} style={{ opacity: 0 }} />
      <section className="case" ref={el} role="dialog" aria-modal="true" aria-labelledby="caseTitle">
        <div className="case-ev">
          <div className="ev-main">
            {photo && !broken.has(photo.url) ? (
              <>
                <button type="button" className="ev-zoom" onClick={() => setLb(true)} aria-label="Открыть кадр на весь экран">
                  <img src={photo.url} alt={`Кадр: ${photo.camera}`} onError={() => setBroken((b) => new Set(b).add(photo.url))} style={lb ? { visibility: 'hidden' } : undefined} />
                </button>
                <div className="ticks" />
                <div className="ev-cap">
                  <span className="chip-mat">
                    {photo.camera} · {hhmmss(ev.at)}
                  </span>
                  {ev.demo && <span className="chip-mat off">Демо-распознавание</span>}
                  {photo.primary && (
                    <span className="chip-mat rec">
                      <i className="dot" />В отчёт идёт этот кадр
                    </span>
                  )}
                </div>
              </>
            ) : (
              <div className="ev-none">
                <div>
                  <strong>{photo ? 'Снимок недоступен' : 'Снимков нет'}</strong>
                  {photo ? 'Файл снимка не загрузился с сервера.' : 'Кадры для этого события не сохранены.'} Доказательство нельзя подменить общим фото площадки.
                </div>
              </div>
            )}
          </div>
          {ev.album.length > 1 && (
            <div className="ev-strip">
              {ev.album.map((a, i) => (
                <button key={a.url} type="button" aria-pressed={i === shot} onClick={() => setShot(i)}>
                  <img src={a.url} alt="" />
                  <span>{a.camera}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="case-body">
          <div className="case-top">
            <span className="sev-tag" data-sev={tone}>
              <SevIcon sev={tone} />
              {ev.kind === 'stream' ? 'Видеопоток' : ev.kind === 'loop' ? 'Повтор записи' : SEV_WORD[sev]} · {ev.code} · {ev.zone ? `${ev.zone} · ` : ''}
              {hhmm(ev.at)}
            </span>
            <button type="button" className="close-x" onClick={close} aria-label="Закрыть">
              <CloseIcon />
            </button>
          </div>
          <div>
            <h2 id="caseTitle" tabIndex={-1}>
              {liveTitle(ev, ep, obs.t, true)}
            </h2>
            <p className="lead">
              {ev.kind === 'missing'
                ? consequence(ev.mach)
                : ev.kind === 'oop'
                  ? 'Техника на площадке не соответствует текущему этапу плана.'
                  : ev.kind === 'loop'
                    ? 'Кадры камеры повторяются через одинаковое время, как запись по кругу. Пока повтор идёт, по ним нельзя сказать, что происходит на площадке.'
                  : ev.kind === 'stream'
                    ? ev.type === 'STREAM_ONLINE'
                      ? 'Камера снова присылает кадры, наблюдение по её зоне возобновилось.'
                      : 'Пока кадров нет, по зоне этой камеры вывод об отсутствии техники не делается.'
                    : ev.description}
            </p>
            <TaskLine ev={ev} />
          </div>
          <div>
            <span className="kicker">Как система пришла к выводу</span>
            <div className="chain">
              {steps.map((s, i) => (
                <div className="step" data-tone={s.tone} key={s.h}>
                  <span className="n">{i + 1}</span>
                  <div>
                    <h4>{s.h}</h4>
                    <p>{s.p}</p>
                    {s.extra}
                    {s.src && <div className="src">{s.src}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <History hist={hist} open={histOpen} onToggle={() => setHistOpen(!histOpen)} ev={ev} user={user} admins={admins} />
          <div className="decide">
            {ev.sample ? (
              <div className="decided">
                <span>
                  <b>Пример с сервера.</b> Сервер показывает его, пока журнал объекта пуст. Записи в базе нет, поэтому решение по нему не сохраняется.
                </span>
              </div>
            ) : ev.kind === 'stream' ? (
              <div className="decided">
                <span>
                  <b>Видеопоток.</b> Запись о сигнале камеры попадает в журнал и акт, решение по ней не принимается.
                  {ev.check === 'passed' ? ' Проверка камер подтвердила, что кадры снова приходят.' : ''}
                </span>
              </div>
            ) : !isOpen(ev) ? (
              <div className="decided">
                <span>
                  Решение: <b>{loopDecision(ev) ?? (ev.status === 'resolved' && ev.check === 'passed' ? 'Устранено, подтвердили камеры' : STATUS_WORD[ev.status])}</b>
                  {loopDecision(ev) && ev.checkDetails.resolvedBy ? ` · ${ev.checkDetails.resolvedBy}` : ''}
                  {decidedAt ? ` · ${atTime(decidedAt)}` : ''}
                </span>
                <span className="hint">Событие закрыто. Если нарушение повторится, система создаст новое.</span>
              </div>
            ) : ev.kind === 'loop' && rights.act ? (
              <LoopDecide ev={ev} live={obs.sources.find((s) => s.id === ev.cameraId)} admin={user.role === 'admin'} saving={save.s === 'saving'} decide={decide} />
            ) : !rights.act ? (
              <div className="decided">
                <span>{ev.status === 'pending' ? <b>Ждёт решения</b> : <>Решение: <b>{STATUS_WORD[ev.status]}</b></>}</span>
                <CheckState ev={ev} />
                <span className="hint">{rights.reason}</span>
              </div>
            ) : ev.status !== 'pending' && !redo ? (
              <div className="decided">
                <span>
                  Решение: <b>{STATUS_WORD[ev.status]}</b>
                  {decidedAt ? ` · ${atTime(decidedAt)}` : ''}
                </span>
                <CheckState ev={ev} />
                <div className="decide-row">
                  <button type="button" className="btn primary" onClick={() => decide('resolved')} disabled={save.s === 'saving' || ev.check === 'requested'}>
                    {ev.check === 'requested' ? 'Проверка запрошена' : ev.check === 'failed' || ev.check === 'unavailable' ? 'Проверить ещё раз' : 'Исправлено — проверить камерами'}
                  </button>
                  <button type="button" className="btn ghost" onClick={() => setRedo(true)} disabled={save.s === 'saving'}>
                    Изменить решение
                  </button>
                </div>
                {save.s !== 'idle' && (
                  <div className="save-state" data-s={save.s}>
                    {save.s === 'saving' ? 'Сохраняем…' : save.s === 'saved' ? 'Сохранено в журнале' : save.msg}
                  </div>
                )}
              </div>
            ) : redo ? (
              <>
                <div className="redo-head">
                  <span>
                    Сейчас: <b>{STATUS_WORD[ev.status]}</b>. Новое решение:
                  </span>
                  <button type="button" className="link-plain" onClick={() => setRedo(false)}>
                    Отмена
                  </button>
                </div>
                <div className="decide-row">
                  {(
                    [
                      ['confirmed', 'Подтвердить', '1'],
                      ['false_positive', 'Ложное', '2'],
                      ['in_progress', 'В работу', '3'],
                    ] as const
                  )
                    .filter(([v]) => v !== ev.status && (v !== 'false_positive' || rights.dismiss))
                    .map(([v, l, k]) => (
                      <button key={v} type="button" className="btn" onClick={() => decide(v)} disabled={save.s === 'saving'}>
                        {l}
                        <kbd>{k}</kbd>
                      </button>
                    ))}
                </div>
                <div className="save-state" data-s={save.s === 'idle' ? undefined : save.s}>
                  {save.s === 'saving' ? 'Сохраняем…' : save.s === 'saved' ? 'Сохранено в журнале' : save.s === 'error' ? `${save.msg}. Попробуйте ещё раз.` : `Смена решения запишется в историю события.${rights.dismiss ? '' : ' Ложное срабатывание отмечает администратор.'}`}
                </div>
              </>
            ) : (
              <>
                <div className="decide-row">
                  <button type="button" className="btn primary" onClick={() => decide('confirmed')} disabled={save.s === 'saving'}>
                    Подтвердить <kbd>1</kbd>
                  </button>
                  {rights.dismiss && (
                    <button type="button" className="btn" onClick={() => decide('false_positive')} disabled={save.s === 'saving'}>
                      Ложное <kbd>2</kbd>
                    </button>
                  )}
                  <button type="button" className="btn ghost" onClick={() => decide('in_progress')} disabled={save.s === 'saving'}>
                    В работу <kbd>3</kbd>
                  </button>
                </div>
                <div className="save-state" data-s={save.s === 'idle' ? undefined : save.s}>
                  {save.s === 'saving' ? 'Сохраняем…' : save.s === 'saved' ? 'Сохранено в журнале' : save.s === 'error' ? `${save.msg}. Попробуйте ещё раз.` : `Решение сохранится в журнале события.${rights.dismiss ? '' : ' Ложное срабатывание отмечает администратор.'}`}
                </div>
              </>
            )}
          </div>
        </div>
      </section>
      {lb && photo && (
        <Lightbox
          photos={ev.album.filter((a) => !broken.has(a.url))}
          index={Math.max(0, ev.album.filter((a) => !broken.has(a.url)).indexOf(photo))}
          caption={`${fmtDay(ev.at)}, ${hhmmss(ev.at)} · ${ev.code}${ev.demo ? ' · демо-распознавание' : ''}`}
          source={() => el.current?.querySelector('.ev-main img')?.getBoundingClientRect() ?? null}
          onIndex={(i) => setShot(ev.album.indexOf(ev.album.filter((a) => !broken.has(a.url))[i]))}
          onClose={() => setLb(false)}
        />
      )}
    </>
  )
}

/** Who answers for the event and by when; after the deadline, who it went to. */
function TaskLine({ ev }: { ev: UiEvent }) {
  if (!ev.assignee && ev.deadline == null) return null
  const now = Date.now()
  const open = isOpen(ev)
  const late = open && ev.deadline != null && ev.deadline <= now
  return (
    <p className="task-line" data-late={late || undefined}>
      {ev.assignee && (
        <span>
          Ответственный: <b>{ev.assignee}</b>
        </span>
      )}
      {open && ev.deadline != null && <span className="when">{late ? `срок истёк ${durShort(now - ev.deadline)} назад` : `исправить до ${atTime(ev.deadline, now)} · осталось ${durShort(ev.deadline - now)}`}</span>}
      {ev.escalatedAt && <span>у руководителя с {atTime(ev.escalatedAt, now)}</span>}
    </p>
  )
}

const REASON: Record<string, string> = {
  loop_needs_admin: 'повтор записи за минуту не исключить, событие закрывает администратор',
  detector_not_ready: 'распознавание на сервере недоступно, исправление по камерам не подтвердить',
  no_live_cameras: 'у объекта нет камер с адресом потока',
  verification_error: 'проверка завершилась ошибкой на сервере',
}
/** The server's recheck of a reported fix, as it stands. */
function CheckState({ ev }: { ev: UiEvent }) {
  const d = ev.checkDetails
  const when = ev.checkedAt ? ` в ${atTime(ev.checkedAt)}` : ''
  const cams = d.configured ? `кадры дали ${d.working ?? 0} из ${d.configured} камер` : null
  if (ev.check === 'requested')
    return (
      <p className="check" data-s="requested">
        Проверка исправления запрошена. Сервер сверит кадры камер и закроет событие, если нарушение не подтвердится.
      </p>
    )
  if (ev.check === 'failed')
    return (
      <p className="check" data-s="failed">
        Проверка{when}: нарушение сохраняется{cams ? `, ${cams}` : ''}
        {d.seen?.length ? `; замечены: ${d.seen.join(', ').toLowerCase()}` : ''}.
      </p>
    )
  if (ev.check === 'unavailable')
    return (
      <p className="check" data-s="unavailable">
        Проверка{when} не дала ответа: {(d.reason && REASON[d.reason]) || (cams ? `${cams}, этого недостаточно` : 'данных с камер недостаточно')}.
      </p>
    )
  return null
}

const EV_WORD: Record<string, string> = {
  detected: 'Событие зафиксировано',
  updated: 'Новое наблюдение',
  assigned: 'Назначен ответственный',
  status_changed: 'Решение изменено',
  rejected: 'Отклонено',
  auto_resolved: 'Камеры подтвердили исправление, событие закрыто',
  verification_failed: 'Повторная проверка: нарушение сохраняется',
  verification_unavailable: 'Повторная проверка: данных с камер недостаточно',
  escalated: 'Срок истёк, событие передано руководителю',
}
const WORD = STATUS_WORD as Record<string, string>
function historyLine(h: ApiIncidentEvent) {
  const c = h.comment || ''
  if (h.event_type === 'status_changed') {
    const m = c.match(/([a-z_]+)\s*->\s*([a-z_]+)/)
    if (m) return `${WORD[m[1]] ?? m[1]} → ${WORD[m[2]] ?? m[2]}`
  }
  if (h.event_type === 'assigned') {
    const m = c.match(/Ответственный:\s*([^;]+);\s*срок:\s*(\S+)/)
    if (m) return `Ответственный: ${m[1].trim()} · исправить до ${atTime(new Date(m[2]).getTime())}`
  }
  if (h.event_type === 'commented') return c || 'Комментарий'
  return EV_WORD[h.event_type] ?? (c || h.event_type)
}
/** The last time someone decided: the newest status change in the history. */
function lastDecision(hist: ApiIncidentEvent[] | string | null) {
  if (!Array.isArray(hist)) return null
  const t = hist.filter((h) => h.event_type === 'status_changed').map((h) => new Date(h.created_at).getTime())
  return t.length ? Math.max(...t) : null
}

function History({ hist, open, onToggle, ev, user, admins }: { hist: ApiIncidentEvent[] | string | null; open: boolean; onToggle: () => void; ev: UiEvent; user: UserProfile; admins: AdminRecipient[] }) {
  if (ev.sample) return null
  if (typeof hist === 'string') return <p className="hint">История события не загрузилась: {hist}</p>
  const list = (hist || []).slice().sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
  const who = (id: string | null) => (!id ? null : id === user.id ? 'вы' : id === ev.assigneeId ? ev.assignee : admins.find((a) => a.id === id)?.name ?? null)
  return (
    <div className="hist">
      <button type="button" className="hist-toggle" aria-expanded={open} onClick={onToggle} disabled={!list.length}>
        <span className="kicker">История события{list.length ? ` · ${list.length}` : ''}</span>
        {list.length > 0 && <span>{open ? 'Скрыть' : 'Показать'}</span>}
      </button>
      {open && (
        <ol>
          {list.map((h) => {
            // an assignment names its person in the line itself
            const by = h.event_type === 'assigned' ? null : who(h.user_id)
            return (
              <li key={h.id}>
                <time className="mono">{atTime(new Date(h.created_at).getTime())}</time>
                <span>
                  {historyLine(h)}
                  {by && <span className="by"> · {by}</span>}
                </span>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}

/** Decisions on a looped camera: only an administrator who saw the live picture closes it. */
function LoopDecide({ ev, live, admin, saving, decide }: { ev: UiEvent; live?: Observation['sources'][number]; admin: boolean; saving: boolean; decide: (s: EventStatus) => Promise<void> }) {
  const still = live?.loop?.looped
  return (
    <div className="decided">
      <span>
        {still ? (
          <>
            Повтор <b>продолжается</b>
            {live?.loop?.period ? `: период около ${durShort(live.loop.period)}` : ''}.
          </>
        ) : live?.status === 'live' ? (
          <>Сейчас кадры камеры не повторяются.</>
        ) : (
          <>Камера сейчас не даёт кадров, повтор не проверить.</>
        )}
      </span>
      <div className="decide-row">
        {admin && (
          <button type="button" className="btn primary" onClick={() => decide('resolved')} disabled={saving}>
            Видео живое — закрыть
          </button>
        )}
        {ev.status === 'pending' && (
          <button type="button" className={admin ? 'btn' : 'btn primary'} onClick={() => decide('confirmed')} disabled={saving}>
            Подтвердить нарушение
          </button>
        )}
        {admin && (
          <button type="button" className="btn ghost" onClick={() => decide('false_positive')} disabled={saving}>
            Ложное
          </button>
        )}
      </div>
      <span className="hint">
        {admin
          ? still
            ? 'Повтор ещё идёт. Закрывайте, только если сами видите площадку вживую: например, попросите прораба пройти перед камерой.'
            : 'Закрывая, вы подтверждаете, что камера показывает площадку вживую.'
          : 'Снять событие может администратор, убедившись, что камера показывает площадку вживую. Подключите камеру напрямую и сообщите ему.'}
      </span>
    </div>
  )
}
