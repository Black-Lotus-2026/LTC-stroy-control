import React, { useEffect, useState } from 'react'
import {
  MachineryProbabilityItem,
  StageItem,
  StageProbabilityResponse,
  fetchStageProbabilities,
} from '../api/stroyControlApi'

interface StageAnalyticsProps {
  selectedStage: StageItem | null
  onClose?: () => void
}

export const StageAnalytics: React.FC<StageAnalyticsProps> = ({ selectedStage, onClose }) => {
  const [data, setData] = useState<StageProbabilityResponse | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'barchart' | 'radarchart'>('barchart')

  useEffect(() => {
    if (!selectedStage) {
      setData(null)
      return
    }

    let isMounted = true
    setIsLoading(true)

    fetchStageProbabilities(selectedStage.id)
      .then((res) => {
        if (isMounted) setData(res)
      })
      .catch((err) => {
        console.error('Failed to load probabilities:', err)
      })
      .finally(() => {
        if (isMounted) setIsLoading(false)
      })

    return () => {
      isMounted = false
    }
  }, [selectedStage])

  if (!selectedStage) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-center text-slate-400">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-slate-800 flex items-center justify-center text-slate-500">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </div>
        <p className="text-sm font-medium">Выберите этап на графике Ганта</p>
        <p className="text-xs text-slate-500 mt-1">
          Здесь появится вероятностный профиль строительной техники и правила валидации
        </p>
      </div>
    )
  }

  // Classification styling helpers
  const getBadgeStyle = (classification: MachineryProbabilityItem['classification']) => {
    switch (classification) {
      case 'MANDATORY':
        return 'bg-emerald-950/80 text-emerald-400 border border-emerald-700/60'
      case 'RECOMMENDED':
        return 'bg-amber-950/80 text-amber-300 border border-amber-700/60'
      case 'UNCHARACTERISTIC':
        return 'bg-rose-950/80 text-rose-400 border border-rose-700/60'
      default:
        return 'bg-slate-800 text-slate-400 border border-slate-700/50'
    }
  }

  const getBarColor = (classification: MachineryProbabilityItem['classification']) => {
    switch (classification) {
      case 'MANDATORY':
        return 'from-emerald-500 to-teal-400'
      case 'RECOMMENDED':
        return 'from-amber-500 to-yellow-400'
      case 'UNCHARACTERISTIC':
        return 'from-rose-500 to-red-400'
      default:
        return 'from-slate-600 to-slate-500'
    }
  }

  const getLabelRu = (classification: MachineryProbabilityItem['classification']) => {
    switch (classification) {
      case 'MANDATORY':
        return 'Обязательная (P > 0.8)'
      case 'RECOMMENDED':
        return 'Рекомендованная (0.6 - 0.8)'
      case 'UNCHARACTERISTIC':
        return 'Нехарактерная (P < 0.15)'
      default:
        return 'Нейтральная (0.15 - 0.6)'
    }
  }

  const items = data?.probabilities || []

  // SVG Radar Chart calculation
  const radarRadius = 110
  const centerCoord = 140
  const totalCount = items.length || 10
  const radarPoints = items.map((item, i) => {
    const angle = (Math.PI * 2 * i) / totalCount - Math.PI / 2
    const distance = Math.max(0.05, Math.min(1.0, item.probability)) * radarRadius
    const x = centerCoord + distance * Math.cos(angle)
    const y = centerCoord + distance * Math.sin(angle)
    return { x, y, angle, item }
  })

  const polygonPath = radarPoints.map((p) => `${p.x},${p.y}`).join(' ')

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-2xl transition-all">
      {/* Header */}
      <div className="px-5 py-4 border-b border-slate-800/80 bg-slate-950/60 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-indigo-950 text-indigo-400 border border-indigo-800/60">
              Этап #{selectedStage.order_index}
            </span>
            <h3 className="text-base font-bold text-slate-100 tracking-tight">
              {selectedStage.name}
            </h3>
          </div>
          <div className="mt-1 flex items-center gap-3 text-xs text-slate-400">
            <span>
              Справочник:{' '}
              <strong className="text-slate-300">
                {data?.matched_catalog_stage || selectedStage.matched_catalog_name || 'Автосопоставление'}
              </strong>
            </span>
            {data?.similarity_confidence !== undefined && (
              <span className="text-emerald-400 font-mono">
                {(data.similarity_confidence * 100).toFixed(0)}% сходство
              </span>
            )}
            <span className="text-slate-500">• {selectedStage.duration_days} дн.</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Chart mode tabs */}
          <div className="inline-flex rounded-lg bg-slate-950 p-1 border border-slate-800 text-xs">
            <button
              onClick={() => setActiveTab('barchart')}
              className={`px-3 py-1 rounded-md font-medium transition-all ${
                activeTab === 'barchart'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Рейтинг вероятностей
            </button>
            <button
              onClick={() => setActiveTab('radarchart')}
              className={`px-3 py-1 rounded-md font-medium transition-all ${
                activeTab === 'radarchart'
                  ? 'bg-indigo-600 text-white shadow'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Радар профиля
            </button>
          </div>

          {onClose && (
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-200 p-1.5 rounded-lg hover:bg-slate-800 transition"
              title="Закрыть аналитику"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="p-5">
        {isLoading ? (
          <div className="h-64 flex flex-col items-center justify-center gap-3">
            <div className="w-7 h-7 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
            <p className="text-xs text-slate-400">Расчет вероятностного профиля техники...</p>
          </div>
        ) : (
          <>
            {/* Top Machinery Summary */}
            {data?.top_machinery && data.top_machinery.length > 0 && (
              <div className="mb-4 p-3 bg-slate-950/60 border border-slate-800/80 rounded-lg flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Приоритетная техника этапа:
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {data.top_machinery.map((tech) => (
                      <span
                        key={tech}
                        className="text-xs px-2.5 py-0.5 rounded-full bg-indigo-950/80 text-indigo-300 border border-indigo-700/60 font-medium"
                      >
                        {tech}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="text-[11px] text-slate-500 font-mono">
                  10 классов YOLO v8/v11
                </div>
              </div>
            )}

            {/* View 1: Horizontal BarChart */}
            {activeTab === 'barchart' && (
              <div className="space-y-3 max-h-[380px] overflow-y-auto pr-1">
                {items.map((item) => {
                  const percent = (item.probability * 100).toFixed(1)
                  return (
                    <div
                      key={item.machinery_code}
                      className="bg-slate-950/50 p-2.5 rounded-lg border border-slate-800/60 hover:border-slate-700 transition"
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-slate-200">
                            {item.machinery_name_ru}
                          </span>
                          <span className="text-[10px] font-mono text-slate-500">
                            ({item.machinery_code})
                          </span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span
                            className={`text-[10px] px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider ${getBadgeStyle(
                              item.classification
                            )}`}
                          >
                            {getLabelRu(item.classification)}
                          </span>
                          <span className="text-xs font-mono font-bold text-slate-100 min-w-[42px] text-right">
                            {percent}%
                          </span>
                        </div>
                      </div>

                      {/* Progress Track */}
                      <div className="w-full bg-slate-800/70 h-2.5 rounded-full overflow-hidden p-0.5">
                        <div
                          className={`h-full rounded-full bg-gradient-to-r ${getBarColor(
                            item.classification
                          )} transition-all duration-500 shadow-sm`}
                          style={{ width: `${Math.max(2, item.probability * 100)}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}

            {/* View 2: Multi-dimensional RadarChart */}
            {activeTab === 'radarchart' && (
              <div className="flex flex-col items-center justify-center gap-4 py-2">
                <div className="text-center">
                  <span className="text-[10px] font-bold text-amber-500 uppercase tracking-widest block mb-0.5">
                    Многомерный профиль распределения
                  </span>
                  <h3 className="text-sm font-extrabold text-white uppercase tracking-wider">
                    ПРОФИЛЬ ТЕХНИКИ НА ЭТАПЕ
                  </h3>
                </div>
                <div className="flex flex-col md:flex-row items-center justify-center gap-6">
                <div className="relative">
                  <svg width="280" height="280" className="overflow-visible">
                    {/* Concentric Web Rings (25%, 50%, 75%, 100%) */}
                    {[0.25, 0.5, 0.75, 1.0].map((level) => {
                      const ringPoints = items.map((_, i) => {
                        const angle = (Math.PI * 2 * i) / totalCount - Math.PI / 2
                        const r = level * radarRadius
                        return `${centerCoord + r * Math.cos(angle)},${centerCoord + r * Math.sin(angle)}`
                      })
                      return (
                        <polygon
                          key={level}
                          points={ringPoints.join(' ')}
                          fill="none"
                          stroke="#334155"
                          strokeWidth="1"
                          strokeDasharray={level < 1 ? '2 2' : 'none'}
                        />
                      )
                    })}

                    {/* Radial Axis Lines */}
                    {items.map((_, i) => {
                      const angle = (Math.PI * 2 * i) / totalCount - Math.PI / 2
                      const x2 = centerCoord + radarRadius * Math.cos(angle)
                      const y2 = centerCoord + radarRadius * Math.sin(angle)
                      return (
                        <line
                          key={i}
                          x1={centerCoord}
                          y1={centerCoord}
                          x2={x2}
                          y2={y2}
                          stroke="#1e293b"
                          strokeWidth="1.5"
                        />
                      )
                    })}

                    {/* Filled Radar Polygon */}
                    <polygon
                      points={polygonPath}
                      fill="rgba(99, 102, 241, 0.25)"
                      stroke="#818cf8"
                      strokeWidth="2.5"
                    />

                    {/* Data Points & Label anchors */}
                    {radarPoints.map((p, idx) => (
                      <g key={idx}>
                        <circle
                          cx={p.x}
                          cy={p.y}
                          r="4"
                          fill={p.item.probability > 0.6 ? '#34d399' : '#818cf8'}
                          stroke="#0f172a"
                          strokeWidth="1.5"
                        />
                        {/* Outer Label */}
                        <text
                          x={centerCoord + (radarRadius + 18) * Math.cos(p.angle)}
                          y={centerCoord + (radarRadius + 18) * Math.sin(p.angle)}
                          textAnchor={
                            Math.cos(p.angle) > 0.2 ? 'start' : Math.cos(p.angle) < -0.2 ? 'end' : 'middle'
                          }
                          dominantBaseline="central"
                          fill="#94a3b8"
                          fontSize="9.5"
                          fontWeight="500"
                        >
                          {p.item.machinery_name_ru}
                        </text>
                      </g>
                    ))}
                  </svg>
                </div>

                {/* Radar Legend and Criteria */}
                <div className="max-w-xs space-y-2 text-xs">
                  <h4 className="font-bold text-slate-200 uppercase tracking-wider text-[11px] mb-2">
                    Пороговые правила этапа:
                  </h4>
                  <div className="flex items-start gap-2 bg-emerald-950/30 border border-emerald-800/40 p-2 rounded">
                    <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 mt-0.5 shrink-0" />
                    <div>
                      <strong className="text-emerald-400">P &gt; 0.8: Обязательная</strong>
                      <p className="text-slate-400 text-[11px]">
                        Отсутствие в рабочей зоне фиксируется как ERROR
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 bg-amber-950/30 border border-amber-800/40 p-2 rounded">
                    <span className="w-2.5 h-2.5 rounded-full bg-amber-500 mt-0.5 shrink-0" />
                    <div>
                      <strong className="text-amber-300">0.6 ≤ P ≤ 0.8: Рекомендованная</strong>
                      <p className="text-slate-400 text-[11px]">
                        Отсутствие техники фиксируется как WARNING
                      </p>
                    </div>
                  </div>
                  <div className="flex items-start gap-2 bg-rose-950/30 border border-rose-800/40 p-2 rounded">
                    <span className="w-2.5 h-2.5 rounded-full bg-rose-500 mt-0.5 shrink-0" />
                    <div>
                      <strong className="text-rose-400">P &lt; 0.15: Нехарактерная</strong>
                      <p className="text-slate-400 text-[11px]">
                        Присутствие на площадке фиксируется как ERROR
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
        )}
      </div>
    </div>
  )
}
