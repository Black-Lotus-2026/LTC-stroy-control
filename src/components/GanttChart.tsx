import React, { useState } from 'react'
import {
  StageItem,
  cascadeShiftStages,
  loadDemoSchedule,
  updateStageDates,
  uploadScheduleFile,
} from '../api/stroyControlApi'

interface GanttChartProps {
  stages: StageItem[]
  onStagesChange: (stages: StageItem[]) => void
  onSelectStage: (stageId: string) => void
  selectedStageId?: string | null
}

export const GanttChart: React.FC<GanttChartProps> = ({
  stages,
  onStagesChange,
  onSelectStage,
  selectedStageId,
}) => {
  const [isShiftModalOpen, setIsShiftModalOpen] = useState(false)
  const [selectedDelayedStageId, setSelectedDelayedStageId] = useState<string>(
    stages[1]?.id || stages[0]?.id || ''
  )
  const [delayDays, setDelayDays] = useState<number>(5)
  const [isUploading, setIsUploading] = useState(false)
  const [feedbackMsg, setFeedbackMsg] = useState<string | null>(null)

  // Compute timeline boundaries
  const startTimestamps = stages.map((s) => new Date(s.planned_start).getTime()).filter(Boolean)
  const endTimestamps = stages.map((s) => new Date(s.planned_end).getTime()).filter(Boolean)

  const minTime = startTimestamps.length > 0 ? Math.min(...startTimestamps) : Date.now()
  const maxTime =
    endTimestamps.length > 0
      ? Math.max(...endTimestamps)
      : minTime + 30 * 24 * 3600 * 1000
  const totalDurationMs = Math.max(maxTime - minTime, 1)

  const handleCascadeShift = async () => {
    if (!selectedDelayedStageId || delayDays <= 0) return
    try {
      const res = await cascadeShiftStages(selectedDelayedStageId, delayDays)
      onStagesChange(res.updated_stages)
      setFeedbackMsg(res.message)
      setIsShiftModalOpen(false)
      setTimeout(() => setFeedbackMsg(null), 4000)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Ошибка выполнения сдвига'
      alert(errorMsg)
    }
  }

  const handleLoadDemo = async () => {
    setIsUploading(true)
    try {
      const demoStages = await loadDemoSchedule()
      onStagesChange(demoStages)
      setFeedbackMsg('Эталонный демо-план «Многоквартирный жилой дом» успешно загружен')
      setTimeout(() => setFeedbackMsg(null), 4000)
    } finally {
      setIsUploading(false)
    }
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setIsUploading(true)
    try {
      const newStages = await uploadScheduleFile(file)
      onStagesChange(newStages)
      setFeedbackMsg(`График из файла ${file.name} успешно импортирован`)
      setTimeout(() => setFeedbackMsg(null), 4000)
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : 'Ошибка импорта файла'
      alert(errorMsg)
    } finally {
      setIsUploading(false)
      e.target.value = ''
    }
  }

  const handleAdjustDuration = async (stage: StageItem, deltaDays: number) => {
    const currentEnd = new Date(stage.planned_end)
    currentEnd.setDate(currentEnd.getDate() + deltaDays)
    const newEndStr = currentEnd.toISOString().split('T')[0]
    const newDuration = Math.max(1, stage.duration_days + deltaDays)

    await updateStageDates(stage.id, {
      planned_end: newEndStr,
      duration_days: newDuration,
    })

    onStagesChange(
      stages.map((s) => (s.id === stage.id ? { ...s, planned_end: newEndStr, duration_days: newDuration } : s))
    )
  }

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 text-slate-100 shadow-2xl flex flex-col gap-6">
      {/* Header & Controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold text-white tracking-wide">
              Календарный график СМР и Гант
            </h2>
            <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              {stages.length} этапов
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Интерактивное управление сроками, привязка к справочнику работ и каскадный сдвиг при задержках
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <label className="cursor-pointer bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 px-3.5 py-2 rounded-lg text-xs font-medium transition-all shadow-sm">
            <span>{isUploading ? 'Загрузка...' : 'Загрузить файл (.xlsx / .csv)'}</span>
            <input
              type="file"
              accept=".xlsx,.csv"
              className="hidden"
              onChange={handleFileUpload}
              disabled={isUploading}
            />
          </label>

          <button
            onClick={handleLoadDemo}
            disabled={isUploading}
            className="bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 px-3.5 py-2 rounded-lg text-xs font-medium transition-all"
          >
            Эталонный демо-план
          </button>

          <button
            onClick={() => setIsShiftModalOpen(true)}
            className="bg-amber-600 hover:bg-amber-500 text-slate-950 font-semibold px-4 py-2 rounded-lg text-xs transition-all shadow-lg shadow-amber-950/40 flex items-center gap-1.5"
          >
            <span>⏩</span>
            <span>Сдвинуть все этапы при отставании</span>
          </button>
        </div>
      </div>

      {feedbackMsg && (
        <div className="bg-emerald-950/50 border border-emerald-500/40 text-emerald-300 px-4 py-2.5 rounded-lg text-xs flex items-center justify-between animate-fadeIn">
          <span>✓ {feedbackMsg}</span>
          <button onClick={() => setFeedbackMsg(null)} className="text-emerald-400 hover:text-emerald-200">
            ✕
          </button>
        </div>
      )}

      {/* Gantt Timeline View */}
      <div className="bg-slate-950/70 border border-slate-800/80 rounded-lg p-4 overflow-x-auto">
        <div className="text-xs font-semibold text-slate-400 mb-3 uppercase tracking-wider flex justify-between">
          <span>Таймлайн строительства ({new Date(minTime).toLocaleDateString()} — {new Date(maxTime).toLocaleDateString()})</span>
          <span>Кликните на этап для аналитики техники</span>
        </div>

        <div className="flex flex-col gap-2 min-w-[700px]">
          {stages.map((stage) => {
            const startMs = new Date(stage.planned_start).getTime()
            const endMs = new Date(stage.planned_end).getTime()
            const leftPercent = Math.max(0, Math.min(100, ((startMs - minTime) / totalDurationMs) * 100))
            const widthPercent = Math.max(3, Math.min(100 - leftPercent, ((endMs - startMs) / totalDurationMs) * 100))
            const isSelected = selectedStageId === stage.id

            return (
              <div
                key={stage.id}
                onClick={() => onSelectStage(stage.id)}
                className={`relative flex items-center h-9 px-2 rounded-md cursor-pointer transition-all ${
                  isSelected ? 'bg-indigo-950/40 ring-1 ring-indigo-500' : 'hover:bg-slate-800/40'
                }`}
              >
                {/* Bar */}
                <div
                  style={{ left: `${leftPercent}%`, width: `${widthPercent}%` }}
                  className={`absolute h-6 rounded-md transition-all flex items-center px-2.5 shadow-md ${
                    isSelected
                      ? 'bg-gradient-to-r from-indigo-500 to-indigo-600 ring-2 ring-indigo-400 text-white font-medium'
                      : 'bg-gradient-to-r from-emerald-600 to-teal-500 text-emerald-50 hover:brightness-110'
                  }`}
                >
                  <span className="truncate text-[11px] font-semibold tracking-tight">
                    {stage.name} ({stage.duration_days} дн.)
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Tabular Editor */}
      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-left text-xs text-slate-300">
          <thead className="bg-slate-950 text-slate-400 uppercase tracking-wider text-[11px] border-b border-slate-800">
            <tr>
              <th className="py-3 px-3 w-12 text-center">№</th>
              <th className="py-3 px-4">Наименование этапа</th>
              <th className="py-3 px-3">Начало</th>
              <th className="py-3 px-3">Окончание</th>
              <th className="py-3 px-3 text-center">Дней</th>
              <th className="py-3 px-4">Справочник работ</th>
              <th className="py-3 px-3 text-center">Правка срока</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60 font-mono">
            {stages.map((stage) => {
              const isSelected = selectedStageId === stage.id
              return (
                <tr
                  key={stage.id}
                  onClick={() => onSelectStage(stage.id)}
                  className={`cursor-pointer transition-colors ${
                    isSelected ? 'bg-indigo-950/30 text-white font-medium' : 'hover:bg-slate-800/30'
                  }`}
                >
                  <td className="py-2.5 px-3 text-center text-slate-400">{stage.order_index}</td>
                  <td className="py-2.5 px-4 font-sans text-slate-200">
                    <div className="flex items-center gap-2">
                      {isSelected && <span className="w-1.5 h-1.5 rounded-full bg-indigo-400"></span>}
                      <span>{stage.name}</span>
                    </div>
                  </td>
                  <td className="py-2.5 px-3 text-slate-300">{stage.planned_start.slice(0, 10)}</td>
                  <td className="py-2.5 px-3 text-slate-300">{stage.planned_end.slice(0, 10)}</td>
                  <td className="py-2.5 px-3 text-center font-bold text-emerald-400">{stage.duration_days}</td>
                  <td className="py-2.5 px-4 text-slate-400 font-sans text-[11px]">
                    {stage.matched_catalog_name ? (
                      <span className="text-slate-300 bg-slate-800/80 px-2 py-0.5 rounded border border-slate-700/60">
                        {stage.matched_catalog_name}
                      </span>
                    ) : (
                      <span className="text-slate-500">—</span>
                    )}
                  </td>
                  <td className="py-2.5 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                    <div className="inline-flex rounded-md shadow-sm">
                      <button
                        onClick={() => handleAdjustDuration(stage, -1)}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded-l text-[10px] border border-slate-700"
                        title="Уменьшить на 1 день"
                      >
                        -1д
                      </button>
                      <button
                        onClick={() => handleAdjustDuration(stage, 1)}
                        className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-1 rounded-r text-[10px] border-t border-b border-r border-slate-700"
                        title="Увеличить на 1 день"
                      >
                        +1д
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Cascade Shift Modal */}
      {isShiftModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn">
          <div className="bg-slate-900 border border-slate-700 w-full max-w-md rounded-2xl p-6 shadow-2xl flex flex-col gap-4 text-slate-100">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h3 className="font-bold text-base text-amber-400 flex items-center gap-2">
                <span>⏩</span>
                <span>Каскадный сдвиг при отставании</span>
              </h3>
              <button
                onClick={() => setIsShiftModalOpen(false)}
                className="text-slate-400 hover:text-white text-lg"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed">
              При задержке выбранного этапа все последующие этапы (расположенные ниже в очереди графика)
              будут автоматически сдвинуты вперёд на указанное число дней с сохранением их длительности.
            </p>

            <div className="flex flex-col gap-3 my-2">
              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">
                  Задержанный этап СМР:
                </label>
                <select
                  value={selectedDelayedStageId}
                  onChange={(e) => setSelectedDelayedStageId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-amber-500"
                >
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      #{s.order_index} {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-400 mb-1">
                  Величина задержки (дней сдвига вперёд):
                </label>
                <input
                  type="number"
                  min={1}
                  max={365}
                  value={delayDays}
                  onChange={(e) => setDelayDays(Math.max(1, parseInt(e.target.value) || 1))}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-amber-500"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                onClick={() => setIsShiftModalOpen(false)}
                className="bg-slate-800 hover:bg-slate-700 text-slate-300 px-4 py-2 rounded-lg text-xs"
              >
                Отмена
              </button>
              <button
                onClick={handleCascadeShift}
                className="bg-amber-600 hover:bg-amber-500 text-slate-950 font-semibold px-4 py-2 rounded-lg text-xs shadow-md"
              >
                Применить сдвиг
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
