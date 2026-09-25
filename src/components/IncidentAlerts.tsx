import React, { useEffect, useState } from 'react'
import {
  IncidentAlertItem,
  fetchIncidents,
  verifyIncidentVlm,
} from '../api/stroyControlApi'

interface IncidentAlertsProps {
  onSelectIncident?: (incident: IncidentAlertItem) => void
}

export const IncidentAlerts: React.FC<IncidentAlertsProps> = ({ onSelectIncident }) => {
  const [incidents, setIncidents] = useState<IncidentAlertItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
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

  const handleVerify = async (incident: IncidentAlertItem, e: React.MouseEvent) => {
    e.stopPropagation()
    setVerifyingId(incident.id)
    try {
      const res = await verifyIncidentVlm(incident.id)
      setIncidents((prev) =>
        prev.map((item) =>
          item.id === incident.id
            ? {
                ...item,
                is_vlm_verified: !res.fallback_used,
                vlm_summary: res.compact_alert_text || res.reasoning,
              }
            : item
        )
      )
    } catch (err) {
      console.error('Verification failed:', err)
      alert('Ошибка VLM-верификации. Проверьте соединение с API.')
    } finally {
      setVerifyingId(null)
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
              Инциденты и VLM-Алерты
            </h3>
            <span className="text-[11px] text-slate-400">
              Двухуровневый контроль (YOLO + Google Gemini Vision)
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
            const isVerifying = verifyingId === incident.id

            return (
              <div
                key={incident.id}
                onClick={() => onSelectIncident?.(incident)}
                className={`p-3.5 rounded-lg border transition cursor-pointer ${
                  isError
                    ? 'bg-rose-950/20 border-rose-900/40 hover:border-rose-700/60'
                    : 'bg-amber-950/20 border-amber-900/40 hover:border-amber-700/60'
                }`}
              >
                {/* Top Row: Code, Severity & Verification Badge */}
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
                      {incident.machinery_type}
                    </span>
                  </div>

                  {/* VLM Verification Badge */}
                  <div>
                    {incident.is_vlm_verified ? (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-emerald-950/80 text-emerald-300 border border-emerald-700/60 shadow-sm">
                        <svg className="w-3 h-3 text-emerald-400" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                        Gemini VLM подтверждено
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700">
                        <svg className="w-2.5 h-2.5 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        Без VLM-верификации
                      </span>
                    )}
                  </div>
                </div>

                {/* Compact 1-2 sentence operator description */}
                <p className="text-xs text-slate-300 leading-relaxed font-sans mb-2.5">
                  {incident.vlm_summary ||
                    `На этапе «${incident.stage_name || 'СМР'}» зафиксировано несоответствие: ${incident.discrepancy_type}.`}
                </p>

                {/* Footer with stage context, probability & re-verify action */}
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
                    onClick={(e) => handleVerify(incident, e)}
                    disabled={isVerifying}
                    className="shrink-0 ml-2 inline-flex items-center gap-1 px-2.5 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white transition text-[11px] border border-slate-700 disabled:opacity-50"
                    title="Запустить повторную валидацию через Google Gemini Vision"
                  >
                    {isVerifying ? (
                      <span className="w-3 h-3 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin mr-1" />
                    ) : (
                      <svg className="w-3 h-3 text-indigo-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    )}
                    {isVerifying ? 'Анализ сцены...' : 'VLM-проверка'}
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
