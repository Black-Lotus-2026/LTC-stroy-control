import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Episode, EventStatus, Observation, Profile, Stage, UiEvent } from '../model'
import { LV, STATUS_WORD, consequence, liveTitle, parseDescription, sevNow, stageDay } from '../model'
import { MACH, type Code } from '../lib/machinery'
import { durShort, fmtDay, hhmm, hhmmss } from '../lib/format'
import { Spring, clamp, lerp, reducedMotion } from '../lib/spring'
import { CloseIcon, SevIcon } from './common'
import { Lightbox } from './Lightbox'

const SEV_WORD = { warn: 'Предупреждение', err: 'Отклонение', info: 'Сведения' }

export function CaseFile({
  ev,
  ep,
  stage,
  prof,
  obs,
  origin,
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
      if ((ev.status !== 'pending' && !redo) || ev.sample) return
      const m: Record<string, EventStatus> = { '1': 'confirmed', '2': 'false_positive', '3': 'in_progress' }
      if (m[e.key]) decide(m[e.key])
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
  const r = ev.mach && prof ? prof.rules[ev.mach] : null
  const desc = parseDescription(ev.description)
  const day = stage ? stageDay(stage, ev.at) : 0
  const live = obs.sources.filter((s) => s.status === 'live').length
  const steps: { tone: string; h: string; p: React.ReactNode; src?: React.ReactNode }[] = []
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
          {ev.kind === 'missing' && ` Предупреждение через ${durShort(r.warnAfter * 1000)} без наблюдения, отклонение через ${durShort(r.errAfter * 1000)}.`}
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
    tone: sev,
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
    tone: sev,
    h: 'Вывод',
    p:
      ev.kind === 'missing' && r && ep && !ep.to && sev !== 'err'
        ? `${SEV_WORD[sev]}. Станет отклонением через ${durShort(Math.max(0, r.errAfter * 1000 - (obs.t - ep.from)))}, если ${MACH[ev.mach!].lower} не появится.`
        : `${SEV_WORD[sev]}.${ev.status !== 'pending' ? ` Решение: ${STATUS_WORD[ev.status].toLowerCase()}.` : ''}`,
  })

  const photo = ev.album[shot]
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
            <span className="sev-tag" data-sev={sev}>
              <SevIcon sev={sev} />
              {SEV_WORD[sev]} · {ev.code} · {ev.zone ? `${ev.zone} · ` : ''}
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
            <p className="lead">{ev.kind === 'missing' ? consequence(ev.mach) : ev.kind === 'oop' ? 'Техника на площадке не соответствует текущему этапу плана.' : ev.description}</p>
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
                    {s.src && <div className="src">{s.src}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="decide">
            {ev.sample ? (
              <div className="decided">
                <span>
                  <b>Пример с сервера.</b> Сервер показывает его, пока журнал объекта пуст. Записи в базе нет, поэтому решение по нему не сохраняется.
                </span>
              </div>
            ) : ev.status !== 'pending' && !redo ? (
              <div className="decided">
                <span>
                  Решение: <b>{STATUS_WORD[ev.status]}</b>
                  {ev.decidedAt ? ` · ${hhmm(ev.decidedAt)}` : ''}
                </span>
                <div className="decide-row">
                  {(ev.status === 'confirmed' || ev.status === 'in_progress') && (
                    <button type="button" className="btn" onClick={() => decide('resolved')} disabled={save.s === 'saving'}>
                      Отметить устранённым
                    </button>
                  )}
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
                      ['resolved', 'Устранено', ''],
                      ['pending', 'Вернуть в ожидание', ''],
                    ] as const
                  )
                    .filter(([v]) => v !== ev.status)
                    .map(([v, l, k]) => (
                      <button key={v} type="button" className={`btn${v === 'pending' ? ' ghost' : ''}`} onClick={() => decide(v)} disabled={save.s === 'saving'}>
                        {l}
                        {k && <kbd>{k}</kbd>}
                      </button>
                    ))}
                </div>
                <div className="save-state" data-s={save.s === 'idle' ? undefined : save.s}>
                  {save.s === 'saving' ? 'Сохраняем…' : save.s === 'saved' ? 'Сохранено в журнале' : save.s === 'error' ? `${save.msg}. Попробуйте ещё раз.` : 'Смена решения запишется в историю события на сервере.'}
                </div>
              </>
            ) : (
              <>
                <div className="decide-row">
                  <button type="button" className="btn primary" onClick={() => decide('confirmed')} disabled={save.s === 'saving'}>
                    Подтвердить <kbd>1</kbd>
                  </button>
                  <button type="button" className="btn" onClick={() => decide('false_positive')} disabled={save.s === 'saving'}>
                    Ложное <kbd>2</kbd>
                  </button>
                  <button type="button" className="btn ghost" onClick={() => decide('in_progress')} disabled={save.s === 'saving'}>
                    В работу <kbd>3</kbd>
                  </button>
                </div>
                <div className="save-state" data-s={save.s === 'idle' ? undefined : save.s}>
                  {save.s === 'saving' ? 'Сохраняем…' : save.s === 'saved' ? 'Сохранено в журнале' : save.s === 'error' ? `${save.msg}. Попробуйте ещё раз.` : 'Решение сохранится в журнале события.'}
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
