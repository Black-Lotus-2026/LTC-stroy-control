import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Engine } from '../engine'
import type { Evaluation, Observation, Profile, SourceView, ViewCheck } from '../model'
import { mediaUrl } from '../api'
import { MACH } from '../lib/machinery'
import { PROBLEM_WORD, turnWords } from '../lib/view'
import { atTime, conf2, durShort, hhmm, hhmmss, plural } from '../lib/format'
import { Spring, clamp, lerp, reducedMotion } from '../lib/spring'

const STATUS_WORD: Record<SourceView['status'], string> = {
  connecting: 'Подключение',
  live: 'Прямой эфир',
  stale: 'Кадр не меняется',
  offline: 'Нет сигнала',
  unsupported: 'Поток не поддерживается',
  idle: 'Пауза',
}

export function Stage({
  engine,
  obs,
  ev,
  prof,
  selected,
  onSelect,
  focus,
  boxes,
  setBoxes,
  onAction,
  settings,
}: {
  engine: Engine
  obs: Observation
  ev: Evaluation
  prof: Profile | null
  selected: string | null
  onSelect: (id: string) => void
  focus: string | null
  boxes: boolean
  setBoxes: (b: boolean) => void
  onAction: (act: string) => void
  settings: { window: number; conf: number }
}) {
  const src = obs.sources.find((s) => s.id === selected) || obs.sources.find((s) => s.status === 'live') || obs.sources[0]
  const host = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [aspect, setAspect] = useState(16 / 9)
  // the approved view laid over the live frame: what moved is seen at once
  const [ghost, setGhost] = useState(false)

  // adopt the source's live media element into the visible frame; it keeps streaming either way
  useLayoutEffect(() => {
    if (!src || !host.current) return
    const el = engine.element(src.id)
    if (!el) return
    host.current.prepend(el)
    const measure = () => {
      const w = el instanceof HTMLVideoElement ? el.videoWidth : (el as HTMLImageElement).naturalWidth
      const h = el instanceof HTMLVideoElement ? el.videoHeight : (el as HTMLImageElement).naturalHeight
      if (w && h) setAspect(w / h)
    }
    measure()
    el.addEventListener('load', measure)
    el.addEventListener('loadedmetadata', measure)
    return () => {
      el.removeEventListener('load', measure)
      el.removeEventListener('loadedmetadata', measure)
      engine.release(el)
    }
  }, [engine, src?.id, src?.status === 'unsupported'])

  // a frame that stopped updating loses its colour, gradually, as it ages
  useEffect(() => {
    const el = src ? engine.element(src.id) : null
    if (!el || !(el instanceof HTMLElement)) return
    const bad = src.status === 'offline' || src.status === 'stale'
    const age = bad && src.since ? Date.now() - src.since : 0
    const k = bad ? clamp(age / 600_000, 0.3, 0.92) : 0
    el.style.filter = k ? `saturate(${1 - k}) brightness(${1 - k * 0.35})` : ''
  })

  if (!src)
    return (
      <section className="stage" aria-label="Камеры">
        <div className="frame-wrap">
          <div className="frame empty">
            <div className="frame-empty">
              <strong>Нет источников кадров</strong>
              <p>Подключите камеру по адресу потока или загрузите запись с датой и временем начала съёмки.</p>
              <button type="button" className="btn primary" onClick={() => onAction('setup')}>
                Добавить источник
              </button>
            </div>
          </div>
        </div>
      </section>
    )

  const rec = obs.recording
  const dets = src.status === 'live' || src.status === 'stale' ? src.dets : []
  const overlay =
    src.status === 'unsupported'
      ? { t: 'Поток не воспроизводится', p: src.message || '' }
      : src.status === 'offline'
        ? { t: 'Нет сигнала', p: `${src.message || ''} Для зоны этого источника вывод об отсутствии техники не делается.` }
        : src.status === 'connecting'
          ? { t: 'Подключаемся', p: 'Ждём первый кадр от источника.' }
          : src.status === 'stale'
            ? { t: 'Кадр не меняется', p: 'Поток застыл. Пока изображение не обновится, оно не считается свежим наблюдением.' }
            : null

  return (
    <section className="stage" aria-label="Камеры">
      <div className="frame-wrap">
        <div className="frame" ref={frame} data-boxes={boxes ? 'on' : 'off'} data-focus={focus || undefined} style={{ aspectRatio: String(aspect) }}>
          <div ref={host} className="f-host" style={{ position: 'absolute', inset: 0 }} />
          <div className="f-shade" />
          {ghost && src.view?.refUrl && <img className="f-ref" src={mediaUrl(src.view.refUrl)} alt="" aria-hidden="true" />}
          <Boxes dets={dets} prof={prof} focus={focus} sourceId={src.id} />
          <div className="ticks" />
          <div className="f-top">
            <span className={`chip-mat${src.status === 'live' ? (obs.mode === 'recording' ? ' rec' : '') : ' off'}`}>
              <i className="dot" />
              <span>{obs.mode === 'recording' && src.status === 'live' ? 'Запись' : STATUS_WORD[src.status]}</span>
            </span>
            {src.status === 'live' && src.loop?.looped && <span className="chip-mat loop-chip">Повтор записи</span>}
            {src.status === 'live' && src.view && src.view.state !== 'none' && (
              <span className="chip-mat view-chip" data-state={src.view.state}>
                {viewChip(src.view)}
              </span>
            )}
            <span className="chip-mat f-count">
              {obs.model === 'down'
                ? 'Распознавание недоступно'
                : obs.model === 'demo' && src.status === 'live'
                  ? `Демо: ${dets.length} ${plural(dets.length, 'объект', 'объекта', 'объектов')}`
                : src.status !== 'live'
                  ? 'Анализ по источнику невозможен'
                  : `${dets.length} ${plural(dets.length, 'объект', 'объекта', 'объектов')} на кадре`}
            </span>
          </div>
          {src.status === 'live' && (src.view?.state === 'changed' || src.view?.state === 'move') && (
            <div className="f-view" data-state={src.view.state}>
              <strong>{src.view.state === 'move' ? `Перенос камеры согласован до ${atTime(src.view.moveUntil ?? Date.now())}` : `Ракурс изменён: ${PROBLEM_WORD[src.view.problem ?? 'different']}${src.view.problem === 'turned' && turnWords(src.view) ? ` ${turnWords(src.view)}` : ''}`}</strong>
              <span>{src.view.state === 'move' ? 'Пока новый ракурс не утверждён, кадры камеры не сверяются.' : `С ${hhmmss(src.view.since ?? obs.t)} кадры этой камеры не учитываются в сверке техники.`}</span>
            </div>
          )}
          <div className="f-meta">
            <div>
              <div className="cam-name">{src.name}</div>
              <div className="cam-sub">{src.kind === 'video' ? 'Запись' : `Камера ${src.n}`}{src.lastFrame ? ` · кадр ${hhmmss(src.lastFrame)}` : ''}</div>
            </div>
            <span className="mono">{hhmmss(obs.t)}</span>
          </div>
          {src.status === 'live' && src.loop?.looped && (
            <div className="f-loop">
              <strong>Камера повторяет запись{src.loop.period ? `: период около ${durShort(src.loop.period)}` : ''}</strong>
              <span>{src.loop.since ? `С ${hhmm(src.loop.since)} ` : ''}кадры возвращаются кадр в кадр. Пока повтор идёт, они не учитываются в сверке техники.</span>
            </div>
          )}
          <div className="f-state" data-on={String(!!overlay)}>
            <div className="hatch" />
            {overlay && (
              <div className="msg">
                <strong>{overlay.t}</strong>
                <p>{overlay.p}</p>
              </div>
            )}
          </div>
          {rec && (
            <div className="rec-ctl">
              <button type="button" aria-label={rec.paused ? 'Воспроизвести' : 'Пауза'} onClick={() => engine.togglePlay()}>
                {rec.paused ? '▶' : '❚❚'}
              </button>
              {[1, 4, 8].map((r) => (
                <button key={r} type="button" aria-pressed={engine.rate === r} onClick={() => engine.setRate(r)}>
                  ×{r}
                </button>
              ))}
              <span className="mono">
                {hhmmss(obs.t)}
                {rec.duration ? ` / ${hhmmss(rec.start + rec.duration)}` : ''}
              </span>
            </div>
          )}
        </div>
      </div>
      <Strip obs={obs} selected={src.id} onSelect={onSelect} frame={frame} settings={settings} boxes={boxes} setBoxes={setBoxes} covered={ev.covered} ghost={src.view?.refUrl ? ghost : null} setGhost={setGhost} />
    </section>
  )
}

function Boxes({ dets, prof, focus, sourceId }: { dets: Observation['sources'][number]['dets']; prof: Profile | null; focus: string | null; sourceId: string }) {
  const seen = useRef(new Set<string>())
  const lastSrc = useRef(sourceId)
  const root = useRef<HTMLDivElement>(null)
  // brackets lock on: they settle from slightly larger when a machine first appears
  useLayoutEffect(() => {
    if (lastSrc.current !== sourceId) {
      seen.current.clear()
      lastSrc.current = sourceId
    }
    const now = new Set(dets.map((d) => d.code))
    if (root.current && !reducedMotion())
      for (const el of Array.from(root.current.children) as HTMLElement[]) {
        const code = el.dataset.box!
        if (seen.current.has(code)) continue
        const s = new Spring(0, { response: 0.38, damping: 0.9, rest: 0.002, onUpdate: (p) => { el.style.transform = `scale(${lerp(1.18, 1, p)})`; el.style.opacity = String(Math.min(1, p * 1.4)) } })
        s.to(1)
      }
    seen.current = now
  })
  return (
    <div className="boxes" ref={root}>
      {dets.map((d, i) => {
        const lvl = prof?.rules[d.code].lvl
        const cls = lvl === 'no' ? 'oop' : lvl === 'skip' ? 'stationary' : ''
        const tag = lvl === 'no' ? ' · не по этапу' : lvl === 'skip' ? ' · не учитывается' : ''
        return (
          <div
            key={d.code + i}
            className={`box ${cls}${d.demo ? ' demo' : ''}${d.y < 0.08 ? ' lbl-in' : ''}${focus === d.code ? ' focus' : ''}`}
            data-box={d.code}
            style={{ left: `${d.x * 100}%`, top: `${d.y * 100}%`, width: `${d.w * 100}%`, height: `${d.h * 100}%` }}
          >
            <b>
              {MACH[d.code].name}
              {tag}
              <i>{conf2(d.c)}</i>
            </b>
          </div>
        )
      })}
    </div>
  )
}

function Strip({
  obs,
  selected,
  onSelect,
  frame,
  settings,
  boxes,
  setBoxes,
  covered,
  ghost,
  setGhost,
}: {
  obs: Observation
  selected: string
  onSelect: (id: string) => void
  frame: React.RefObject<HTMLDivElement | null>
  settings: { window: number; conf: number }
  boxes: boolean
  setBoxes: (b: boolean) => void
  covered: boolean
  /** null: the selected camera has no approved view to lay over */
  ghost: boolean | null
  setGhost: (b: boolean) => void
}) {
  const live = obs.sources.filter((s) => s.status === 'live').length
  const pick = (s: SourceView, tile: HTMLElement) => {
    if (s.id === selected) return
    const f = frame.current
    const img = tile.querySelector('img')
    if (f && img && !reducedMotion()) {
      // shared element: the tile grows into the main frame
      const from = tile.getBoundingClientRect()
      const to = f.getBoundingClientRect()
      const g = document.createElement('img')
      g.src = img.src
      g.className = 'token'
      Object.assign(g.style, { width: `${to.width}px`, height: `${to.height}px`, objectFit: 'cover', borderRadius: '4px', zIndex: '50', transformOrigin: '0 0' })
      document.body.appendChild(g)
      const sx = from.width / to.width
      const sy = from.height / to.height
      const sp = new Spring(0, {
        response: 0.42,
        damping: 0.92,
        rest: 0.002,
        onUpdate: (p) => {
          g.style.transform = `translate(${lerp(from.left, to.left, p)}px,${lerp(from.top, to.top, p)}px) scale(${lerp(sx, 1, p)},${lerp(sy, 1, p)})`
        },
        onRest: () => {
          g.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200 }).onfinish = () => g.remove()
        },
      })
      sp.to(1)
    }
    onSelect(s.id)
  }
  return (
    <div className="strip" role="group" aria-label="Источники">
      {obs.sources.map((s) => {
        const age = s.lastFrame ? obs.t - s.lastFrame : Infinity
        const frac = s.status === 'live' ? clamp(age / (settings.window * 1000), 0, 1) : 1
        const col = s.status !== 'live' ? 'var(--fg-3)' : frac > 0.5 ? 'var(--warn)' : 'var(--ok)'
        const L = 2 * Math.PI * 7
        const flag = s.status === 'live' ? '' : s.status === 'offline' && s.since ? `Нет сигнала ${durShort(Date.now() - s.since)}` : STATUS_WORD[s.status]
        return (
          <button key={s.id} type="button" className="tile" aria-pressed={s.id === selected} data-off={String(s.status === 'offline')} data-status={s.status} onClick={(e) => pick(s, e.currentTarget)} aria-label={`${s.name}: ${STATUS_WORD[s.status].toLowerCase()}`}>
            {s.snapshot ? <img alt="" src={s.snapshot} draggable={false} style={s.status === 'offline' || s.status === 'stale' ? { filter: 'saturate(.2) brightness(.7)' } : undefined} /> : <span className="t-snap-none">{s.status === 'unsupported' ? 'RTSP' : 'нет кадра'}</span>}
            <span className="t-off" />
            <span className="t-flag">{flag}</span>
            <span className="t-name">
              {s.kind === 'video' ? 'Запись' : s.n} · {s.name}
            </span>
            <svg className="t-age" viewBox="0 0 18 18" aria-hidden="true">
              <circle cx="9" cy="9" r="7" stroke="rgba(255,255,255,.18)" />
              <circle cx="9" cy="9" r="7" stroke={col} strokeDasharray={L} strokeDashoffset={L * frac} transform="rotate(-90 9 9)" strokeLinecap="round" />
            </svg>
          </button>
        )
      })}
      <div className="strip-meta">
        <span>
          <b>
            {live} из {obs.sources.length}
          </b>{' '}
          {plural(obs.sources.length, 'источник даёт', 'источников дают', 'источников дают')} кадры
        </span>
        <span>
          Окно сверки {settings.window} с · порог {settings.conf}%
        </span>
        <span className="proto-line">{obs.model === 'demo' ? 'Демо-распознавание: модель недоступна' : covered ? 'Анализ идёт, пока открыта эта вкладка' : obs.model === 'down' ? 'Распознавание недоступно' : 'Анализ ещё не начался'}</span>
      </div>
      <div className="frame-tools">
        <button type="button" className="toggle" role="switch" aria-checked={boxes} onClick={() => setBoxes(!boxes)}>
          <span className="sw" />
          Рамки
        </button>
        {ghost != null && (
          <button type="button" className="toggle" role="switch" aria-checked={ghost} onClick={() => setGhost(!ghost)} aria-label="Эталон поверх кадра" title="Наложить утверждённый ракурс на живой кадр">
            <span className="sw" />
            Эталон
          </button>
        )}
      </div>
    </div>
  )
}

function viewChip(v: ViewCheck) {
  if (v.state === 'ok') return `Ракурс ${Math.round((v.match ?? 0) * 100)} %`
  if (v.state === 'changed') return 'Ракурс изменён'
  if (v.state === 'move') return `Перенос до ${hhmm(v.moveUntil ?? Date.now())}`
  return 'Сверка ракурса'
}
