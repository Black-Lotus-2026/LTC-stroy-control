import React, { useEffect, useState } from 'react'
import {
  IncidentAlertItem,
  fetchIncidents,
  updateIncidentStatus,
  toRussianMachineryName,
} from '../api/stroyControlApi'

interface IncidentAlertsProps {
  onSelectIncident?: (incident: IncidentAlertItem) => void
  onOpenAlbum?: (incidentId: string) => void
}

const mapStatusToLabel = (status?: string | null): 'Ожидает обработки' | 'Подтверждено' | 'Проблемы нет' => {
  if (!status) return 'Ожидает обработки'
  const s = status.toLowerCase()
  if (s === 'confirmed' || s === 'подтверждено') return 'Подтверждено'
  if (s === 'false_positive' || s === 'проблемы нет' || s === 'dismissed') return 'Проблемы нет'
  return 'Ожидает обработки'
}

export const IncidentAlerts: React.FC<IncidentAlertsProps> = ({ onSelectIncident, onOpenAlbum }) => {
  const [incidents, setIncidents] = useState<IncidentAlertItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [filterSeverity, setFilterSeverity] = useState<'ALL' | 'ERROR' | 'WARNING'>('ALL')

  const loadIncidentsList = async () => {
    setIsLoading(true)
    try {
      const items = await fetchIncidents()
      setIncidents(items)
    } catch (err) {
      console.error('Failed to fetch incidents:', err)
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadIncidentsList()
    // Poll for new incidents every 15 seconds
    const interval = setInterval(loadIncidentsList, 15000)
    return () => clearInterval(interval)
  }, [])

  const handleStatusChange = async (incidentId: string, newLabel: string, e: React.ChangeEvent<HTMLSelectElement>) => {
    e.stopPropagation()
    const apiStatus = newLabel === 'Подтверждено' ? 'confirmed' : newLabel === 'Проблемы нет' ? 'false_positive' : 'pending'
    setIncidents((prev) =>
      prev.map((item) => (item.id === incidentId ? { ...item, status: apiStatus } : item))
    )
    try {
      await updateIncidentStatus(incidentId, apiStatus)
    } catch (err) {
      console.error('Failed to update incident status:', err)
    }
  }

  const filteredIncidents = incidents.filter((inc) => {
    if (filterSeverity === 'ALL') return true
    return inc.severity === filterSeverity
  })

  const errorCount = incidents.filter((i) => i.severity === 'ERROR').length
  const warningCount = incidents.filter((i) => i.severity === 'WARNING').length

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl flex flex-col h-full">
      {/* Header */}
      <div className="px-5 py-3.5 border-b border-slate-800/80 bg-slate-950/70 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block animate-ping absolute top-0 right-0"></span>
            <span className="w-2.5 h-2.5 rounded-full bg-rose-500 inline-block"></span>
          </div>
          <div>
            <h3 className="text-sm font-bold text-slate-100 uppercase tracking-wider">
              Инциденты и нарушения СМР
            </h3>
            <span className="text-[11px] text-slate-400">
              Мультикамерный контроль техники по графику
            </span>
          </div>
        </div>

        {/* Severity Filters */}
        <div className="flex items-center gap-1.5 text-xs">
          <button
            onClick={() => setFilterSeverity('ALL')}
            className={`px-2.5 py-1 rounded-md font-medium transition ${
              filterSeverity === 'ALL'
                ? 'bg-slate-800 text-white'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Все ({incidents.length})
          </button>
          <button
            onClick={() => setFilterSeverity('ERROR')}
            className={`px-2.5 py-1 rounded-md font-medium transition flex items-center gap-1 ${
              filterSeverity === 'ERROR'
                ? 'bg-rose-950 text-rose-300 border border-rose-800'
                : 'text-rose-400 hover:bg-rose-950/40'
            }`}
          >
            Ошибки ({errorCount})
          </button>
          <button
            onClick={() => setFilterSeverity('WARNING')}
            className={`px-2.5 py-1 rounded-md font-medium transition flex items-center gap-1 ${
              filterSeverity === 'WARNING'
                ? 'bg-amber-950 text-amber-300 border border-amber-800'
                : 'text-amber-400 hover:bg-amber-950/40'
            }`}
          >
            Предупреждения ({warningCount})
          </button>
        </div>
      </div>

      {/* Incident List */}
      <div className="p-4 space-y-3 overflow-y-auto max-h-[360px] flex-1">
        {isLoading && incidents.length === 0 ? (
          <div className="py-12 text-center text-slate-500 text-xs">
            Загрузка списка нарушений...
          </div>
        ) : filteredIncidents.length === 0 ? (
          <div className="py-10 text-center text-slate-400 text-xs">
            <svg
              className="w-8 h-8 mx-auto mb-2 text-emerald-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
            </svg>
            Нарушений в выбранной категории не обнаружено
          </div>
        ) : (
          filteredIncidents.map((incident) => {
            const isError = incident.severity === 'ERROR'
            const primaryPhoto = incident.snapshot_url || incident.frame_snapshot_url
            const totalCameraCount = incident.album_photos?.length || (primaryPhoto ? 1 : 0)

            return (
              <div
                key={incident.id}
                onClick={() => {
                  if (onOpenAlbum) {
                    onOpenAlbum(incident.id)
                  } else if (onSelectIncident) {
                    onSelectIncident(incident)
                  }
                }}
                className={`p-3.5 rounded-lg border transition cursor-pointer ${
                  isError
                    ? 'bg-rose-950/20 border-rose-900/40 hover:border-rose-700/60'
                    : 'bg-amber-950/20 border-amber-900/40 hover:border-amber-700/60'
                }`}
              >
                {/* Top Row: Code, Severity & Status */}
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`text-[10px] font-mono px-2 py-0.5 rounded font-bold ${
                        isError
                          ? 'bg-rose-900/60 text-rose-300 border border-rose-700/50'
                          : 'bg-amber-900/60 text-amber-300 border border-amber-700/50'
                      }`}
                    >
                      {incident.code} • {incident.severity}
                    </span>

                    <span className="text-xs font-semibold text-slate-200">
                      {toRussianMachineryName(incident.machinery_type)}
                    </span>
                  </div>

                  <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <select
                      value={mapStatusToLabel(incident.status)}
                      onChange={(e) => handleStatusChange(incident.id, e.target.value, e)}
                      aria-label="Статус инцидента"
                      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded cursor-pointer border outline-none transition ${
                        mapStatusToLabel(incident.status) === 'Подтверждено'
                          ? 'bg-rose-950 text-rose-300 border-rose-700'
                          : mapStatusToLabel(incident.status) === 'Проблемы нет'
                          ? 'bg-emerald-950 text-emerald-300 border-emerald-700'
                          : 'bg-amber-950 text-amber-300 border-amber-700'
                      }`}
                    >
                      <option value="Ожидает обработки" className="bg-slate-900 text-amber-300">⏳ Ожидает обработки</option>
                      <option value="Подтверждено" className="bg-slate-900 text-rose-300">✓ Подтверждено</option>
                      <option value="Проблемы нет" className="bg-slate-900 text-emerald-300">✕ Проблемы нет</option>
                    </select>

                    <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
                      YOLO
                    </span>
                  </div>
                </div>

                {/* Primary photo preview & album thumbnail row */}
                {primaryPhoto && (
                  <div className="flex items-center gap-3 my-2 p-1.5 rounded bg-slate-950/60 border border-slate-800">
                    <img
                      src={primaryPhoto}
                      alt={incident.title || 'Первое фото инцидента'}
                      className="w-16 h-11 object-cover rounded border border-slate-700 shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-medium text-slate-300 truncate">
                        Первое фото инцидента
                      </div>
                      <div className="text-[10px] text-sky-400 flex items-center gap-1 mt-0.5">
                        <span>📷</span>
                        <span>{totalCameraCount > 1 ? `В архиве альбом: ${totalCameraCount} камер` : 'Фотоархив'}</span>
                        <span className="text-slate-500">· клик для перехода</span>
                      </div>
                    </div>
                  </div>
                )}

                {/* Operator description */}
                <p className="text-xs text-slate-300 leading-relaxed font-sans mb-2.5">
                  {incident.description ||
                    `На этапе «${incident.stage_name || 'СМР'}» зафиксировано несоответствие: ${incident.discrepancy_type}.`}
                </p>

                {/* Footer with stage context, probability & open album action */}
                <div className="flex items-center justify-between text-[11px] text-slate-400 pt-2 border-t border-slate-800/60">
                  <div className="flex items-center gap-2 truncate">
                    <span className="truncate">
                      Этап: <span className="text-slate-300 font-medium">{incident.stage_name || 'Не указан'}</span>
                    </span>
                    <span className="text-slate-600">•</span>
                    <span>
                      Ожидание: <strong className="text-slate-200">{((incident.stage_probability ?? 0.8) * 100).toFixed(0)}%</strong>
                    </span>
                  </div>

                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      if (onOpenAlbum) {
                        onOpenAlbum(incident.id)
                      } else if (onSelectIncident) {
                        onSelectIncident(incident)
                      }
                    }}
                    className="shrink-0 ml-2 inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-sky-300 hover:text-white transition text-[11px] border border-slate-700"
                    title="Перейти в фотоархив и открыть альбом ошибки со всех камер"
                  >
                    <svg className="w-3 h-3 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    Альбом ошибки
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
