import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Level, Observation, Profile, Settings, Stage } from '../model'
import { LV, LV_ORDER, STEPS } from '../model'
import { MACH, Sil, type Code } from '../lib/machinery'
import { durShort, hhmm, plural } from '../lib/format'
import { Spring, clamp, lerp } from '../lib/spring'

/** How many events this rule would have produced during the watched part of this session. */
function impact(obs: Observation, code: Code, d: { lvl: Level; warnAfter: number }, s: Settings) {
  const cov = obs.coverage()
  if (!cov.length) return null
  const pres = obs.presence(code)
  if (d.lvl === 'req') {
    let n = 0
    for (const [a, b] of cov) {
      let cursor = a
      for (const [pa, pb] of pres) {
        if (pb < a || pa > b) continue
        if (pa - cursor >= d.warnAfter * 1000) n++
        cursor = Math.max(cursor, pb)
      }
      if (b - cursor >= d.warnAfter * 1000) n++
    }
    return n
  }
  if (d.lvl === 'no') return pres.filter(([a, b]) => b - a >= s.oopAfter * 1000).length
  return 0
}

export function RuleEditor({
  code,
  stage,
  prof,
  obs,
  settings,
  anchor,
  onApply,
  onReset,
  onClose,
}: {
  code: Code
  stage: Stage
  prof: Profile
  obs: Observation
  settings: Settings
  anchor: DOMRect
  onApply: (d: { lvl: Level; warnAfter: number | null; errAfter: number | null }) => Promise<void>
  onReset: () => Promise<void>
  onClose: () => void
}) {
  const r = prof.rules[code]
  const [draft, setDraft] = useState({ lvl: r.lvl, warnAfter: r.warnAfter, errAfter: r.errAfter })
  const [busy, setBusy] = useState<null | 'apply' | 'reset'>(null)
  const [err, setErr] = useState<string | null>(null)
  const el = useRef<HTMLElement>(null)
  const seg = useRef<HTMLDivElement>(null)
  const pill = useRef<HTMLElement>(null)
  const closing = useRef(false)
  const pos = useRef({ dx: 0, dy: 0 })
  const open = useRef<Spring | null>(null)
  // X and Y are separate springs: a diagonal move between rows stays in sync
  const px = useRef(new Spring(0, { response: 0.36, damping: 0.8, rest: 0.2, onUpdate: () => paintPill() }))
  const py = useRef(new Spring(0, { response: 0.36, damping: 0.9, rest: 0.2, onUpdate: () => paintPill() }))
  const pw = useRef(new Spring(0, { response: 0.36, damping: 0.9, rest: 0.2, onUpdate: () => paintPill() }))
  const paintPill = () => {
    if (!pill.current) return
    pill.current.style.transform = `translate(${px.current.x}px, ${py.current.x}px)`
    pill.current.style.width = pw.current.x + 'px'
  }
  const placed = useRef(false)

  useLayoutEffect(() => {
    const b = seg.current?.querySelector<HTMLElement>('button[aria-checked="true"]')
    if (!b || !pill.current) return
    pill.current.style.height = b.offsetHeight + 'px'
    const go = (s: Spring, v: number) => (placed.current ? s.to(v) : s.set(v))
    go(px.current, b.offsetLeft)
    go(py.current, b.offsetTop)
    go(pw.current, b.offsetWidth)
    placed.current = true
    paintPill()
  }, [draft.lvl])

  // materialise from the slot: scale, blur and opacity together
  useLayoutEffect(() => {
    const p = el.current!
    const w = Math.min(380, innerWidth - 32)
    const mob = matchMedia('(max-width: 860px)').matches
    let left: number
    let top: number
    if (mob) {
      left = 16
      top = Math.max(16, innerHeight - p.offsetHeight - 16)
      pos.current = { dx: 0, dy: 30 }
      p.style.transformOrigin = '50% 100%'
    } else {
      left = anchor.left - w - 14
      if (left < 16) left = Math.min(innerWidth - w - 16, anchor.right + 14)
      top = clamp(anchor.top + anchor.height / 2 - p.offsetHeight / 2, 64, innerHeight - p.offsetHeight - 16)
      p.style.transformOrigin = `${left < anchor.left ? '100%' : '0%'} ${clamp(anchor.top + anchor.height / 2 - top, 0, p.offsetHeight)}px`
      pos.current = { dx: left < anchor.left ? 14 : -14, dy: 0 }
    }
    Object.assign(p.style, { left: left + 'px', top: top + 'px', width: w + 'px' })
    open.current = new Spring(0, {
      response: 0.4,
      damping: 0.92,
      rest: 0.002,
      onUpdate: (v) => {
        const q = clamp(v, 0, 1.03)
        p.style.opacity = String(clamp(v * 1.4, 0, 1))
        p.style.transform = `translateX(${(1 - q) * pos.current.dx}px) translateY(${(1 - q) * pos.current.dy}px) scale(${lerp(0.9, 1, q)})`
        p.style.filter = v < 0.99 ? `blur(${(1 - clamp(v, 0, 1)) * 8}px)` : ''
      },
    })
    open.current.set(0)
    open.current.to(1)
    window.setTimeout(() => seg.current?.querySelector<HTMLElement>('button[aria-checked="true"]')?.focus({ preventScroll: true }), 40)
  }, [])
  const close = () => {
    if (closing.current) return
    closing.current = true
    open.current?.to(0, { damping: 1, onRest: onClose })
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close()
    const onDown = (e: PointerEvent) => !el.current?.contains(e.target as Node) && close()
    addEventListener('keydown', onKey)
    addEventListener('pointerdown', onDown, true)
    return () => {
      removeEventListener('keydown', onKey)
      removeEventListener('pointerdown', onDown, true)
    }
  })

  const now = impact(obs, code, { lvl: r.lvl, warnAfter: r.warnAfter }, settings)
  const next = impact(obs, code, draft, settings)
  const bump = (k: 'warnAfter' | 'errAfter', d: number) => {
    const steps = STEPS[k]
    let i = steps.findIndex((s) => s >= draft[k])
    if (i < 0) i = steps.length - 1
    const v = steps[clamp(i + d, 0, steps.length - 1)]
    const n = { ...draft, [k]: v }
    if (n.errAfter <= n.warnAfter) n.errAfter = STEPS.errAfter.find((s) => s > n.warnAfter) ?? STEPS.errAfter[STEPS.errAfter.length - 1]
    setDraft(n)
  }
  const apply = async () => {
    setBusy('apply')
    setErr(null)
    try {
      const timingChanged = draft.warnAfter !== settings.warnAfter || draft.errAfter !== settings.errAfter
      await onApply({ lvl: draft.lvl, warnAfter: draft.lvl === 'req' && timingChanged ? draft.warnAfter : null, errAfter: draft.lvl === 'req' && timingChanged ? draft.errAfter : null })
      close()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось сохранить правило')
      setBusy(null)
    }
  }
  const reset = async () => {
    setBusy('reset')
    setErr(null)
    try {
      await onReset()
      close()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Не удалось сбросить правило')
      setBusy(null)
    }
  }
  return (
    <section className="pop" ref={el} role="dialog" aria-modal="false" aria-labelledby="popTitle" style={{ opacity: 0 }}>
      <h3 id="popTitle">
        <Sil code={code} ink="ghost" />
        {MACH[code].name}
      </h3>
      <div className="meta">
        Этап {stage.n} · {stage.name}
      </div>
      <div className="meta">Источник требования: {r.source === 'document' ? 'ПОС/ППР · цитата во вкладке «Документы»' : r.source === 'manual' ? 'ручная правка' : 'справочник этапов'}</div>
      <div className="field">
        <span className="lbl" id="segLbl">
          Требование на этом этапе
        </span>
        <div
          className="seg"
          role="radiogroup"
          aria-labelledby="segLbl"
          ref={seg}
          onKeyDown={(e) => {
            if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return
            e.preventDefault()
            const i = LV_ORDER.indexOf(draft.lvl)
            const n = LV_ORDER[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : LV_ORDER.length - 1)) % LV_ORDER.length]
            setDraft({ ...draft, lvl: n })
            window.setTimeout(() => seg.current?.querySelector<HTMLElement>(`[data-lvl="${n}"]`)?.focus(), 0)
          }}
        >
          <i className="pill" ref={pill} />
          {LV_ORDER.map((l) => (
            <button key={l} type="button" role="radio" aria-checked={draft.lvl === l} data-lvl={l} tabIndex={draft.lvl === l ? 0 : -1} onClick={() => setDraft({ ...draft, lvl: l })}>
              {l === 'skip' ? 'Не учитывать' : LV[l].label}
            </button>
          ))}
        </div>
        <div className="src-line">{LV[draft.lvl].explain}</div>
      </div>
      {draft.lvl === 'req' && (
        <div className="field two">
          {(['warnAfter', 'errAfter'] as const).map((k) => (
            <div key={k}>
              <span className="lbl">{k === 'warnAfter' ? 'Предупредить через' : 'Отклонение через'}</span>
              <div className="stepper">
                <button type="button" aria-label="Меньше" onClick={() => bump(k, -1)}>
                  −
                </button>
                <output>{durShort(draft[k] * 1000)}</output>
                <button type="button" aria-label="Больше" onClick={() => bump(k, 1)}>
                  +
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="impact">
        {now == null ? (
          <>Влияние появится, когда система понаблюдает за площадкой в этом сеансе.</>
        ) : (
          <>
            За время наблюдения по этому правилу было бы: <b>{now} {plural(now, 'событие', 'события', 'событий')}</b>. С новыми настройками: <span className="roll">{next}</span>.
          </>
        )}
        <small>Уже созданные события не изменятся. Новое правило действует с {hhmm(Date.now())}.</small>
      </div>
      <div className="src-line">
        {r.edited ? `До изменения: ${LV[r.base].label.toLowerCase()}` : `Профиль этапа: ${LV[r.lvl].label.toLowerCase()}, ${Math.round(r.p * 100)}%`}
        {stage.catalog ? ` · ${stage.catalog}` : ''}
        {(draft.lvl === 'skip' || r.ownTiming || draft.warnAfter !== settings.warnAfter || draft.errAfter !== settings.errAfter) && (
          <>
            <br />
            «Не учитывать» снимает требование на сервере. Пометка и свои пороги времени хранятся в этом браузере; агент может восстановить требование по документу.
          </>
        )}
      </div>
      {err && <div className="err-line">{err}</div>}
      <div className="pop-actions">
        {r.edited && (
          <button type="button" className="btn ghost small" onClick={reset} disabled={!!busy}>
            {busy === 'reset' ? 'Сбрасываем…' : 'Вернуть как было'}
          </button>
        )}
        <button type="button" className="btn small" onClick={close}>
          Отмена
        </button>
        <button type="button" className="btn primary small" onClick={apply} disabled={!!busy}>
          {busy === 'apply' ? 'Сохраняем…' : 'Применить'}
        </button>
      </div>
    </section>
  )
}
