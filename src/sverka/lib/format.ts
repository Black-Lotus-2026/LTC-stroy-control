export function plural(n: number, one: string, few: string, many: string) {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return many
  if (b > 1 && b < 5) return few
  if (b === 1) return one
  return many
}

const pad = (n: number) => String(n).padStart(2, '0')

/** Short duration for chips and lists: "40 с", "6 мин", "2 ч 47 мин". */
export function durShort(ms: number) {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec} с`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m} мин`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h} ч ${r} мин` : `${h} ч`
}

/** Duration in words for sentences: "6 минут", "2 часа 47 минут". */
export function durWords(ms: number) {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 60) return `${sec} ${plural(sec, 'секунду', 'секунды', 'секунд')}`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m} ${plural(m, 'минуту', 'минуты', 'минут')}`
  const h = Math.floor(m / 60)
  const r = m % 60
  return `${h} ${plural(h, 'час', 'часа', 'часов')}` + (r ? ` ${r} ${plural(r, 'минуту', 'минуты', 'минут')}` : '')
}

export const hhmm = (t: number | Date) => {
  const d = typeof t === 'number' ? new Date(t) : t
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const hhmmss = (t: number | Date) => {
  const d = typeof t === 'number' ? new Date(t) : t
  return `${hhmm(d)}:${pad(d.getSeconds())}`
}

export const MONTHS_G = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
export const MONTHS_S = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']

export const fmtDay = (d: Date | number) => {
  const x = typeof d === 'number' ? new Date(d) : d
  return `${x.getDate()} ${MONTHS_G[x.getMonth()]}`
}

export const DAY_MS = 864e5

/** "16:05" today, "19 октября, 16:05" on another day: deadlines and decisions span days. */
export const atTime = (t: number, now = Date.now()) => (dayStart(t) === dayStart(now) ? hhmm(t) : `${fmtDay(t)}, ${hhmm(t)}`)

/** Local calendar day of a timestamp (00:00 local). Stages are planned in whole days. */
export function dayStart(t: number | Date) {
  const d = new Date(typeof t === 'number' ? t : t.getTime())
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Plan dates come as ISO strings with a UTC midnight; read them as calendar days. */
export function planDay(iso: string) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

/** Seconds since local midnight → "07:30". */
export const clock = (sec: number) => (sec === 86400 ? '24:00' : `${pad(Math.floor(sec / 3600) % 24)}:${pad(Math.floor(sec / 60) % 60)}`)

export const conf2 = (c: number) => c.toFixed(2).replace('.', ',')

export function toLocalInput(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** "16.10.2026" — for documents. */
export const fmtDate = (t: number | Date) => {
  const d = typeof t === 'number' ? new Date(t) : t
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
}

export const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота']

/** "пятница, 16 октября 2026" — day headers in the journal. */
export const fmtDayLong = (t: number) => {
  const d = new Date(t)
  return `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS_G[d.getMonth()]} ${d.getFullYear()}`
}

/** A calendar day as the server stores plan dates: UTC midnight of that date. */
export function isoDay(t: number) {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T00:00:00Z`
}

/** Local calendar day shifted by whole days (DST-safe). */
export function addDays(t: number, n: number) {
  const d = new Date(t)
  d.setDate(d.getDate() + n)
  return d.getTime()
}

/** Whole calendar days from a to b. */
export const daysBetween = (a: number, b: number) => Math.round((dayStart(b) - dayStart(a)) / DAY_MS)

/** "2026-10-16" for <input type="date">. */
export const toDateInput = (t: number) => {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
export const fromDateInput = (v: string) => {
  const [y, m, d] = v.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}
