/*
 * The act of construction control for a period, as a printable A4 document.
 * Everything in it is computed from the journal: no names, numbers or seals are invented.
 * Fields only a person can fill (act number, signatures) stay blank lines.
 */
import type { ProjectItem } from './api'
import type { Settings, Stage, UiEvent } from './model'
import { awaitsDecision, parseDescription, statusWord } from './model'
import { MACH } from './lib/machinery'
import { clock, durShort, fmtDate, hhmm, hhmmss, plural } from './lib/format'

export interface ActOptions {
  summary: boolean
  photos: boolean
  method: boolean
  signatures: boolean
}
export const ACT_DEFAULTS: ActOptions = { summary: true, photos: true, method: true, signatures: true }

export interface ActInput {
  project: ProjectItem
  user: string
  from: number
  to: number
  items: UiEvent[]
  stages: Stage[]
  settings: Settings
  opts: ActOptions
  formedAt: number
}

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const abs = (u: string) => {
  try {
    return new URL(u, location.href).href
  } catch {
    return u
  }
}

/** A short stable id of the selection, so a printed act can be matched to the journal. */
export function selectionId(items: UiEvent[]) {
  let h = 2166136261
  for (const e of [...items].sort((a, b) => a.id.localeCompare(b.id)))
    for (let i = 0; i < e.id.length; i++) h = Math.imul(h ^ e.id.charCodeAt(i), 16777619)
  return (h >>> 0).toString(16).toUpperCase().padStart(8, '0').slice(0, 6)
}

export function periodText(from: number, to: number) {
  const a = fmtDate(from)
  const b = fmtDate(to)
  return a === b ? `${a}, ${hhmm(from)}–${hhmm(to)}` : `${a} ${hhmm(from)} – ${b} ${hhmm(to)}`
}

const KIND_WORD = { missing: 'Нет обязательной техники', oop: 'Техника не по этапу', stream: 'Событие видеопотока', view: 'Ракурс камеры', loop: 'Камера повторяет запись', other: 'Событие' }
const kindWord = (e: UiEvent) => (e.type === 'MISSING_RECOMMENDED' ? 'Нет рекомендуемой техники' : KIND_WORD[e.kind])

export function buildAct(x: ActInput) {
  const { project, items, opts, settings: s } = x
  // camera events are listed in the act but are neither deviations nor warnings about the site
  const site = items.filter((e) => e.kind !== 'stream')
  const stream = items.length - site.length
  const err = site.filter((e) => e.sev === 'err').length
  const warn = site.length - err
  const by = (st: string) => items.filter((e) => e.status === st && e.kind !== 'stream').length
  const demo = items.filter((e) => e.demo).length
  const pending = items.filter(awaitsDecision).length
  const stagesIn = x.stages.filter((st) => st.start <= x.to && st.end + 864e5 > x.from)
  const sources = [...new Set(items.flatMap((e) => e.album.map((a) => a.camera)))]
  const sel = selectionId(items)

  const notes: string[] = []
  if (demo)
    notes.push(
      `${demo} ${plural(demo, 'запись создана', 'записи созданы', 'записей создано')} в режиме демо-распознавания: модель была недоступна, детекции подставлены по демо-сцене. Такие записи показывают работу системы и не являются результатом распознавания.`,
    )
  if (pending) notes.push(`${pending} ${plural(pending, 'запись ещё не рассмотрена', 'записи ещё не рассмотрены', 'записей ещё не рассмотрено')} оператором: решение по ним не принято.`)
  if (stream) notes.push(`${stream} ${plural(stream, 'запись', 'записи', 'записей')} о видеопотоке: когда камера теряла сигнал и когда он возвращался. В эти интервалы наблюдение по камере не велось; решения по таким записям не требуются.`)
  if (!items.length) notes.push('За период в журнале нет событий, отобранных для акта.')

  const row = (e: UiEvent, i: number) => {
    const d = parseDescription(e.description)
    const photo = e.album.find((a) => a.primary) || e.album[0]
    const stage = x.stages.find((st) => st.id === e.stageId)
    return `<tr>
  <td class="c-n">${i + 1}</td>
  ${opts.photos ? `<td class="c-ph">${photo ? `<img src="${esc(abs(photo.url))}" alt="">` : '<span class="noph">кадр не сохранён</span>'}</td>` : ''}
  <td class="c-t"><b>${esc(fmtDate(e.at))}</b><br>${esc(hhmmss(e.at))}${photo || e.camera ? `<br><span class="mut">${esc(photo?.camera ?? e.camera ?? '')}</span>` : ''}${e.zone ? `<br><span class="mut">${esc(e.zone)}</span>` : ''}</td>
  <td class="c-e">${e.kind === 'stream' ? '<span class="sev src">Видеопоток</span>' : `<span class="sev ${e.sev}">${e.sev === 'err' ? 'Отклонение' : 'Предупреждение'}</span>`}${e.demo ? ' <span class="tag">демо</span>' : ''}<br><b>${esc(e.title)}</b><br><span class="mut">${esc(kindWord(e))}${e.mach ? `: ${esc(MACH[e.mach].lower)}` : ''}.</span>${d['Наблюдение'] ? `<p>${esc(d['Наблюдение'])}</p>` : ''}</td>
  <td class="c-s">${stage ? `${stage.n}. ` : ''}${esc(stage?.name || e.stageName || '—')}</td>
  <td class="c-d ${e.kind === 'stream' ? 'stream' : e.status}">${esc(statusWord(e))}</td>
</tr>`
  }

  const tile = (v: number, l: string, c = '') => `<div class="tile"><b class="${c}">${v}</b><span>${l}</span></div>`

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>Акт строительного контроля · ${esc(project.name)} · ${esc(fmtDate(x.from))}</title>
<style>
@page { size: A4 portrait; margin: 14mm 14mm 16mm; }
* { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
html { background: #fff; }
body { margin: 0; padding: 0; color: #15171a; font: 9.5pt/1.42 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
.sheet { width: 182mm; margin: 0 auto; }
@media screen { body { padding: 14mm 0 18mm; } }
.lh { display: flex; justify-content: space-between; align-items: flex-end; padding-bottom: 8px; border-bottom: 1.6px solid #15171a; }
.brand { display: flex; gap: 9px; align-items: center; }
.mark { width: 30px; height: 30px; border-radius: 6px; background: #15171a; color: #cf9d3d; display: grid; place-items: center; font: 700 11pt/1 Arial, sans-serif; }
.brand b { display: block; font-size: 9.5pt; letter-spacing: .12em; }
.brand span { display: block; font-size: 7.5pt; color: #6b6e74; }
.lh .ref { text-align: right; font-size: 7.5pt; color: #6b6e74; }
h1 { margin: 18px 0 2px; font-size: 14pt; font-weight: 700; letter-spacing: -.01em; }
.no { font-size: 10pt; color: #33363b; }
.no i { display: inline-block; width: 34mm; border-bottom: 1px solid #15171a; margin: 0 4px; }
table.meta { width: 100%; border-collapse: collapse; margin: 14px 0 0; }
table.meta td { padding: 4px 0; vertical-align: top; border-bottom: 1px solid #e6e3dc; }
table.meta td:first-child { width: 46mm; color: #6b6e74; }
.notes { margin: 12px 0 0; padding: 8px 10px; border-left: 3px solid #c46a1c; background: #fbf3ea; }
.notes p { margin: 0; }
.notes p + p { margin-top: 4px; }
.tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin: 14px 0 0; }
.tile { border: 1px solid #e6e3dc; border-radius: 4px; padding: 6px 8px; }
.tile b { display: block; font-size: 14pt; line-height: 1.1; }
.tile span { font-size: 7.5pt; color: #6b6e74; }
.tile .err { color: #b3261e; } .tile .warn { color: #b25a10; } .tile .ok { color: #1d7a4a; }
h2 { font-size: 10pt; margin: 18px 0 6px; letter-spacing: .02em; }
table.ev { width: 100%; border-collapse: collapse; }
table.ev th { text-align: left; font-size: 7.5pt; font-weight: 600; color: #6b6e74; padding: 4px 5px; border-bottom: 1.2px solid #15171a; }
table.ev td { padding: 6px 5px; vertical-align: top; border-bottom: 1px solid #e6e3dc; font-size: 8.5pt; }
table.ev tr { break-inside: avoid; page-break-inside: avoid; }
thead { display: table-header-group; }
.c-n { width: 7mm; color: #6b6e74; }
.c-ph { width: 34mm; }
.c-ph img { width: 34mm; aspect-ratio: 16/9; object-fit: cover; display: block; border-radius: 2px; }
.noph { display: grid; place-items: center; width: 34mm; aspect-ratio: 16/9; background: #f2f0eb; color: #8d9096; font-size: 7pt; border-radius: 2px; }
.c-t { width: 25mm; }
.c-s { width: 32mm; }
.c-d { width: 22mm; font-weight: 600; }
.c-d.confirmed, .c-d.in_progress { color: #b3261e; }
.c-d.false_positive { color: #6b6e74; }
.c-d.resolved { color: #1d7a4a; }
.c-d.pending { color: #b25a10; }
.c-d.stream { color: #6b6e74; font-weight: 500; }
.c-e p { margin: 3px 0 0; color: #33363b; }
.mut { color: #6b6e74; }
.sev { font-size: 7pt; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
.sev.err { color: #b3261e; } .sev.warn { color: #b25a10; } .sev.src { color: #6b6e74; }
.tag { font-size: 7pt; padding: 0 4px; border: 1px solid #b25a10; color: #b25a10; border-radius: 2px; }
.method { color: #33363b; }
.method p { margin: 0 0 4px; }
.sign { margin-top: 22px; break-inside: avoid; page-break-inside: avoid; }
.sign .row { display: grid; grid-template-columns: 62mm 1fr 1fr 26mm; gap: 8mm; align-items: end; margin-top: 16px; }
.sign .row span { display: block; border-bottom: 1px solid #15171a; height: 16px; }
.sign .row small { display: block; font-size: 7pt; color: #8d9096; margin-top: 2px; }
.foot { margin-top: 22px; padding-top: 6px; border-top: 1px solid #e6e3dc; font-size: 7.5pt; color: #8d9096; }
</style>
</head>
<body>
<div class="sheet">
<div class="lh">
  <div class="brand"><div class="mark">СК</div><div><b>СТРОЙ-КОНТРОЛЬ</b><span>Видеоконтроль спецтехники на строительной площадке</span></div></div>
  <div class="ref">Выборка ${esc(sel)} · ${items.length} ${plural(items.length, 'запись', 'записи', 'записей')}<br>Сформирован ${esc(fmtDate(x.formedAt))} в ${esc(hhmm(x.formedAt))}</div>
</div>
<h1>Акт строительного контроля присутствия спецтехники</h1>
<div class="no">№<i></i>от ${esc(fmtDate(x.formedAt))}</div>
<table class="meta">
  <tr><td>Объект</td><td><b>${esc(project.name)}</b>${project.code ? ` <span class="mut">· ${esc(project.code)}</span>` : ''}</td></tr>
  <tr><td>Адрес</td><td>${esc(project.address || 'не указан')}</td></tr>
  <tr><td>Тип объекта</td><td>${esc(project.object_kind || 'не указан')}</td></tr>
  <tr><td>Период наблюдения</td><td><b>${esc(periodText(x.from, x.to))}</b></td></tr>
  <tr><td>Этапы плана в периоде</td><td>${stagesIn.length ? stagesIn.map((st) => `${st.n}. ${esc(st.name)} <span class="mut">(${esc(fmtDate(st.start))} – ${esc(fmtDate(st.end))})</span>`).join('<br>') : 'нет этапов плана'}</td></tr>
  <tr><td>Источники кадров</td><td>${sources.length ? esc(sources.join(', ')) : 'кадры не сохранены'}</td></tr>
  <tr><td>Сформировал</td><td>${esc(x.user)}</td></tr>
</table>
${notes.length ? `<div class="notes">${notes.map((n) => `<p>${esc(n)}</p>`).join('')}</div>` : ''}
${
  opts.summary
    ? `<div class="tiles">
  ${tile(items.length, 'всего событий')}${tile(err, 'отклонений', 'err')}${tile(warn, 'предупреждений', 'warn')}${tile(pending, 'ждут решения', 'warn')}
  ${tile(by('confirmed') + by('in_progress'), 'подтверждено', 'err')}${tile(by('resolved'), 'устранено', 'ok')}${tile(by('false_positive'), 'ложных срабатываний')}${tile(demo, 'в демо-режиме')}
</div>`
    : ''
}
<h2>Журнал событий за период</h2>
<table class="ev">
  <thead><tr><th>№</th>${opts.photos ? '<th>Кадр</th>' : ''}<th>Время наблюдения</th><th>Событие</th><th>Этап плана</th><th>Решение</th></tr></thead>
  <tbody>${items.map(row).join('') || `<tr><td colspan="${opts.photos ? 6 : 5}" class="mut">Событий нет.</td></tr>`}</tbody>
</table>
${
  opts.method
    ? `<h2>Как система делает выводы</h2>
<div class="method">
  <p>Требования к технике на этапе берутся из справочника видов работ и ручных правок правил на объекте. Техника считается замеченной, если найдена хотя бы на одном кадре любого источника за окно сверки.</p>
  <p>Отсутствие учитывается только за время, когда анализ кадров действительно шёл: перерывы в поступлении кадров и время вне смены отсутствием не считаются.</p>
  <p>Параметры контроля на момент формирования акта: окно сверки ${s.window} с; порог уверенности распознавания ${s.conf}%; предупреждение, если обязательной техники нет ${esc(durShort(s.warnAfter * 1000))}; отклонение — через ${esc(durShort(s.errAfter * 1000))}; нехарактерная техника — отклонение через ${esc(durShort(s.oopAfter * 1000))}; смена ${esc(clock(s.shiftFrom))}–${esc(clock(s.shiftTo))}, сбор техники после начала смены ${esc(durShort(s.startGrace * 1000))}. Для отдельных машин на этапе могут действовать свои пороги.</p>
</div>`
    : ''
}
${
  opts.signatures
    ? `<div class="sign">
  <h2>Подписи</h2>
  ${['Инженер строительного контроля', 'Представитель генерального подрядчика', 'Ответственный за механизацию']
    .map((r) => `<div class="row"><div>${r}</div><div><span></span><small>подпись</small></div><div><span></span><small>фамилия, инициалы</small></div><div><span></span><small>дата</small></div></div>`)
    .join('')}
</div>`
    : ''
}
<div class="foot">Сформировано в системе «Строй-контроль» по данным журнала событий объекта. Выборка ${esc(sel)}: ${items.length} ${plural(items.length, 'запись', 'записи', 'записей')} за ${esc(periodText(x.from, x.to))}. Акт на сервере не хранится; сохраните его в PDF.</div>
</div>
</body>
</html>`
}
