import { useEffect, useState } from 'react'
import { fetchWeather, refreshWeather, type WeatherForecast as Forecast } from '../api/stroyControlApi'
import './weather-forecast.css'

export function WeatherForecast({ projectId, configured }: { projectId: string; configured: boolean }) {
  const [forecast, setForecast] = useState<Forecast | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    setForecast(null)
    setError('')
    setBusy(false)
    if (!configured) return () => { active = false }
    setBusy(true)
    void fetchWeather(projectId)
      .then(async saved => {
        if (!active) return saved
        setForecast(saved)
        return saved.days.length === 7 && saved.resolved_address ? saved : refreshWeather(projectId)
      })
      .then(data => { if (active) setForecast(data) })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Прогноз недоступен') })
      .finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [projectId, configured])

  const refresh = async () => {
    setBusy(true)
    setError('')
    try {
      setForecast(await refreshWeather(projectId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Прогноз недоступен')
    } finally {
      setBusy(false)
    }
  }

  return <section className="weather-forecast panel" aria-label="Прогноз погоды на семь дней">
    <div className="weather-forecast-heading">
      <div><h3>Погода на 7 дней</h3><p>Прогноз для объекта строительства</p></div>
      {configured && <button className="button" type="button" disabled={busy} onClick={refresh}>Обновить</button>}
    </div>
    {!configured && <p>Укажите адрес объекта в настройках, чтобы получать прогноз.</p>}
    {busy && !forecast && <p>Загружаем прогноз…</p>}
    {error && <p className="weather-forecast-error" role="alert">{error}</p>}
    {forecast?.resolved_address && <p className="weather-forecast-location">Найденное место: {forecast.resolved_address} · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a></p>}
    {forecast?.days.length === 0 && !busy && <p>Сохранённого прогноза пока нет.</p>}
    {!!forecast?.days.length && <>
      <div className="weather-forecast-grid">
        {forecast.days.map(day => <article className={day.warnings.length ? 'warning' : ''} key={day.forecast_date}>
          <strong>{new Date(`${day.forecast_date}T12:00:00`).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'short' })}</strong>
          <span>{day.conditions.join(', ') || 'Нет данных'}</span>
          <span>{day.temperature_min_c ?? '—'}…{day.temperature_max_c ?? '—'} °C</span>
          <small>Осадки: {day.precipitation_mm ?? '—'} мм · Снег: {day.snowfall_cm ?? '—'} см</small>
          <small>Порывы ветра: {day.wind_gust_kmh ?? '—'} км/ч</small>
          {day.warnings.map(warning => <em key={warning}>⚠ {warning}</em>)}
        </article>)}
      </div>
      <p className="weather-forecast-source">Погода: Open-Meteo · обновлено {new Date(forecast.days[0].fetched_at).toLocaleString('ru-RU')}</p>
    </>}
  </section>
}
