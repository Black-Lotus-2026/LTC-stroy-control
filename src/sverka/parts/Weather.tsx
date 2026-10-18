import type { Weather, WeatherDay } from '../api'
import type { Profile, Stage } from '../model'
import type { Code } from '../lib/machinery'
import { MONTHS_G, dayStart, hhmm, planDay } from '../lib/format'

/** A line drawing per WMO weather code: clear, cloud, fog, rain, snow, storm. */
export function WeatherGlyph({ code }: { code: number | null }) {
  const c = code ?? -1
  const sun = <><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" /></>
  const cloud = <path d="M7.5 18h9.2a3.8 3.8 0 0 0 .4-7.6A5.5 5.5 0 0 0 6.6 9.6 4.2 4.2 0 0 0 7.5 18z" />
  let body: React.ReactNode
  if (c === 0) body = sun
  else if (c >= 1 && c <= 3) body = <><path d="M9 7.2A3.5 3.5 0 0 1 15 5" /><path d="M8 4.4V3M4.6 7.4H3.2M5 4.2l-1-1" />{cloud}</>
  else if (c === 45 || c === 48) body = <path d="M4 9h16M3 13h18M5 17h14" />
  else if ((c >= 71 && c <= 77) || c === 85 || c === 86) body = <>{cloud}<path d="M9 21.2v.1M12 20v.1M15 21.2v.1" /></>
  else if (c >= 95) body = <>{cloud}<path d="m12.5 18-2 3h3l-2 3" /></>
  else if (c >= 51) body = <>{cloud}<path d="m9 20-1 2M12.5 20l-1 2M16 20l-1 2" /></>
  else body = cloud
  return (
    <svg className="wx-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {body}
    </svg>
  )
}

const deg = (v: number | null) => {
  if (v == null) return '—'
  const r = Math.round(v)
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}°`
}
const gust = (kmh: number | null) => (kmh == null ? null : `${Math.round(kmh / 3.6)} м/с`)
const dayOf = (d: WeatherDay) => planDay(d.forecast_date)
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
const wday = (t: number) => WD[new Date(t).getDay()]

/* What a warning means for the work, when the stage needs the machinery it concerns. Said as a
   possibility: a forecast is not an observation. */
const EFFECT: { warn: string; codes: Code[]; text: string }[] = [
  { warn: 'Сильный ветер', codes: ['tower_crane', 'truck_crane'], text: 'работа кранов может быть ограничена' },
  { warn: 'Гроза', codes: ['tower_crane', 'truck_crane'], text: 'крановые и высотные работы могут быть остановлены' },
  { warn: 'Туман', codes: ['tower_crane', 'truck_crane'], text: 'крановщику может не хватить видимости' },
  { warn: 'Сильные осадки', codes: ['concrete_pump', 'concrete_mixer'], text: 'бетонирование может быть отложено' },
  { warn: 'Сильные осадки', codes: ['excavator', 'dump_truck', 'bulldozer'], text: 'земляные работы и вывоз грунта могут быть затруднены' },
  { warn: 'Заморозки', codes: ['concrete_pump', 'concrete_mixer'], text: 'бетону понадобится прогрев' },
  { warn: 'Сильный снегопад', codes: ['dump_truck', 'concrete_mixer', 'truck_crane'], text: 'движение техники по площадке может быть затруднено' },
]
function effects(day: WeatherDay, prof: Profile | null) {
  return day.warnings.map((w) => {
    const hit = prof && EFFECT.find((e) => e.warn === w && e.codes.some((c) => prof.rules[c]?.lvl === 'req' || prof.rules[c]?.lvl === 'rec'))
    return hit ? `${w.toLowerCase()} — ${hit.text}` : w.toLowerCase()
  })
}

/** Warnings that fall on the stage's days, from today on: what the plan should know about. */
export function stageAlerts(weather: Weather | null, stage: Stage | null, prof: Profile | null, from: number) {
  if (!weather || !stage) return []
  return weather.days
    .filter((d) => d.warnings.length && dayOf(d) >= dayStart(from) && dayOf(d) >= stage.start && dayOf(d) <= stage.end)
    .map((d) => ({ at: dayOf(d), first: d.warnings[0].toLowerCase(), text: effects(d, prof).join('; '), touches: effects(d, prof).some((x) => x.includes(' — ')) }))
}

/** A short word for the day of an alert, as the folded plan says it. */
export const whenWord = (at: number, now: number) => {
  const n = Math.round((at - dayStart(now)) / 864e5)
  return n === 0 ? 'сегодня' : n === 1 ? 'завтра' : `${new Date(at).getDate()} ${MONTHS_G[new Date(at).getMonth()]}`
}

/** The week ahead in the stage card: the stage's own days stand out, warnings carry their meaning. */
export function WeekWeather({ weather, stage, prof, t }: { weather: Weather; stage: Stage; prof: Profile | null; t: number }) {
  const today = dayStart(Date.now())
  const days = weather.days.filter((d) => dayOf(d) >= today).slice(0, 7)
  if (!days.length) return null
  const alerts = stageAlerts(weather, stage, prof, today)
  const fetched = Math.max(...days.map((d) => new Date(d.fetched_at).getTime()))
  return (
    <section className="wx" aria-label="Погода на неделю">
      <span className="kicker">Погода на неделю</span>
      <div className="wx-days">
        {days.map((d) => {
          const at = dayOf(d)
          const inStage = at >= stage.start && at <= stage.end
          const g = gust(d.wind_gust_kmh)
          return (
            <div
              key={d.forecast_date}
              className="wx-day"
              data-out={!inStage || undefined}
              data-warn={d.warnings.length > 0 || undefined}
              data-now={at === dayStart(t) || undefined}
              title={[d.conditions.join(', '), d.precipitation_mm ? `осадки ${d.precipitation_mm} мм` : '', d.snowfall_cm ? `снег ${d.snowfall_cm} см` : '', g ? `порывы до ${g}` : '', ...d.warnings].filter(Boolean).join(' · ')}
            >
              <span className="wx-d">{at === today ? 'сег' : wday(at)}</span>
              <WeatherGlyph code={d.weather_code} />
              <span className="wx-t">{deg(d.temperature_max_c)}</span>
              <span className="wx-t2">{deg(d.temperature_min_c)}</span>
            </div>
          )
        })}
      </div>
      {alerts.map((a) => (
        <p key={a.at} className="wx-alert">
          {whenWord(a.at, today)[0].toUpperCase() + whenWord(a.at, today).slice(1)}: {a.text}.
        </p>
      ))}
      <small className="wx-src">
        Прогноз Open-Meteo, обновлён в {hhmm(fetched)}
        {weather.resolved_address && (
          <span className="wx-place" title={weather.resolved_address}>
            Место: {weather.resolved_address} · ©{' '}
            <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
              OpenStreetMap
            </a>
          </span>
        )}
      </small>
    </section>
  )
}
