import { useEffect, useState } from 'react'
import { type PageKey } from '../../data'
import { type StageItem, type MachineryProbabilityItem, getCurrentStageByDate, loadDemoSchedule, uploadScheduleFile, clearSchedule, updateStageDates, cascadeShiftStages, fetchStageProbabilities, updateStageProbabilities, resetStageProbabilities } from '../../api/stroyControlApi'
import { getStageMachineryRules } from '../../domain/stageRules'
import { Icon, Status } from '../ui/Primitives'
import './planning.css'

const DAY = 86400000
const dateValue = (value?: string) => value?.slice(0, 10) || ''
const dateTime = (value?: string) => value ? new Date(`${dateValue(value)}T00:00:00`).getTime() : NaN
const formatDate = (value?: string) => Number.isFinite(dateTime(value))
  ? new Date(dateTime(value)).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
  : 'Не указана'
const messageOf = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback

function plannedPeriod(stage: StageItem, now: number) {
  const end = dateTime(stage.planned_end) + DAY
  const start = dateTime(stage.planned_start)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Сроки не указаны'
  if (end <= now) return 'Плановый период прошёл'
  if (start <= now) return 'По плану сейчас'
  return 'Предстоит по плану'
}

export function Progress({ stages, setStages, activeProjectId, navigate, toast }: {
  stages: StageItem[]
  setStages: React.Dispatch<React.SetStateAction<StageItem[]>>
  activeProjectId?: string | null
  navigate?: (p: PageKey) => void
  toast: (s: string) => void
}) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedStageId, setSelectedStageId] = useState<string | null>(null)
  const [editingStageId, setEditingStageId] = useState<string | null>(null)
  const [draftStart, setDraftStart] = useState('')
  const [draftEnd, setDraftEnd] = useState('')
  const [isShiftOpen, setIsShiftOpen] = useState(false)
  const [delayDays, setDelayDays] = useState(5)
  const [delayedStageId, setDelayedStageId] = useState('')
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000)
    return () => window.clearInterval(timer)
  }, [])

  const selectedStage = stages.find((stage) => stage.id === selectedStageId)
    || getCurrentStageByDate(stages, new Date(now)) || stages[0]
  const stageRules = selectedStage ? getStageMachineryRules(selectedStage.name) : null
  const startTimes = stages.map((stage) => dateTime(stage.planned_start)).filter(Number.isFinite)
  const endTimes = stages.map((stage) => dateTime(stage.planned_end) + DAY).filter(Number.isFinite)
  const minTime = startTimes.length ? Math.min(...startTimes) : now
  const maxTime = endTimes.length ? Math.max(...endTimes) : minTime + 30 * DAY
  const totalMs = Math.max(maxTime - minTime, DAY)
  const todayPct = ((now - minTime) / totalMs) * 100
  const isTodayInRange = todayPct >= 0 && todayPct <= 100
  const timelineTicks = Array.from({ length: 6 }, (_, index) => ({
    pct: index * 20,
    label: new Date(minTime + totalMs * index / 5).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }),
  }))

  const runAction = async (action: () => Promise<void>) => {
    setIsLoading(true)
    setError('')
    try {
      await action()
    } catch (cause) {
      const message = messageOf(cause, 'Не удалось сохранить изменения. Попробуйте ещё раз.')
      setError(message)
      toast(message)
    } finally {
      setIsLoading(false)
    }
  }

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    await runAction(async () => {
      const imported = await uploadScheduleFile(file, activeProjectId || undefined)
      setStages(imported)
      setSelectedStageId(null)
      setEditingStageId(null)
      toast(`План загружен: ${imported.length} этапов`)
    })
    input.value = ''
  }

  const handleLoadDemo = () => {
    if (stages.length && !window.confirm('Заменить текущий график демонстрационным планом?')) return
    void runAction(async () => {
      const demo = await loadDemoSchedule(activeProjectId || undefined)
      setStages(demo)
      setSelectedStageId(null)
      setEditingStageId(null)
      toast('Демонстрационный план загружен')
    })
  }

  const handleClear = () => {
    if (!window.confirm('Удалить календарный план объекта? Это действие нельзя отменить.')) return
    void runAction(async () => {
      await clearSchedule(activeProjectId || undefined)
      setStages([])
      setEditingStageId(null)
      toast('График очищен')
    })
  }

  const handleSaveDates = () => {
    if (!selectedStage || editingStageId !== selectedStage.id) return
    const duration = Math.round((dateTime(draftEnd) - dateTime(draftStart)) / DAY) + 1
    if (!Number.isFinite(duration) || duration < 1) {
      setError('Дата окончания должна быть не раньше даты начала.')
      return
    }
    void runAction(async () => {
      const saved = await updateStageDates(selectedStage.id, {
        planned_start: draftStart, planned_end: draftEnd, duration_days: duration,
      })
      setStages((previous) => previous.map((stage) => stage.id === saved.id ? saved : stage))
      setEditingStageId(null)
      toast('Сроки этапа сохранены')
    })
  }

  const handleAdjustDuration = (stage: StageItem, delta: number) => {
    if (stage.duration_days + delta < 1 || !Number.isFinite(dateTime(stage.planned_end))) return
    const end = new Date(dateTime(stage.planned_end))
    end.setDate(end.getDate() + delta)
    const endDate = `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`
    void runAction(async () => {
      const saved = await updateStageDates(stage.id, { planned_end: endDate, duration_days: stage.duration_days + delta })
      setStages(previous => previous.map(item => item.id === saved.id ? saved : item))
      toast('Длительность этапа сохранена')
    })
  }

  const handleCascadeShift = () => {
    if (!delayedStageId || !Number.isInteger(delayDays) || delayDays < 1 || delayDays > 180) return
    if (!window.confirm(`Сдвинуть все последующие этапы на ${delayDays} дн.?`)) return
    void runAction(async () => {
      const result = await cascadeShiftStages(delayedStageId, delayDays)
      setStages(result.updated_stages)
      setIsShiftOpen(false)
      setEditingStageId(null)
      toast(result.message)
    })
  }

  return (
    <div className="planning-page">
      <section className="panel planning-panel" aria-busy={isLoading}>
        <div className="planning-toolbar">
          <div className="planning-meta">
            <Status tone="neutral">{stages.length ? `${stages.length} этапов` : 'План не загружен'}</Status>
            <span>На {new Date(now).toLocaleDateString('ru-RU')}</span>
          </div>
          <div className="planning-toolbar-actions">
            <label className={`button primary planning-upload${isLoading ? ' planning-disabled' : ''}`}>
              <Icon name="file" size={16} /> Загрузить план
              <input aria-label="Загрузить план в формате XLSX или CSV" type="file" accept=".xlsx,.csv" disabled={isLoading} onChange={handleFileUpload} />
            </label>
            <details className="planning-actions">
              <summary className="button">Действия с графиком</summary>
              <div className="planning-actions-menu">
                <button className="button" disabled={isLoading} onClick={handleLoadDemo}>Загрузить демо-план</button>
                {stages.length > 0 && <>
                  <button className="button" disabled={isLoading} onClick={() => {
                    setDelayedStageId(selectedStage?.id || stages[0].id)
                    setIsShiftOpen(true)
                  }}>Сдвинуть следующие этапы</button>
                  <button className="button planning-danger" disabled={isLoading} onClick={handleClear}>Очистить график</button>
                </>}
              </div>
            </details>
          </div>
        </div>
        {error && !isShiftOpen && <div className="planning-error" role="alert">{error}</div>}
        {isLoading && <p className="planning-feedback" role="status">Выполняем действие…</p>}

        {stages.length === 0 ? (
          <div className="planning-empty">
            <Icon name="progress" size={30} />
            <h3>Добавьте план строительства</h3>
            <p>Загрузите XLSX или CSV с этапами и плановыми сроками.</p>
          </div>
        ) : <>
          <div className="planning-timeline-scroll" aria-label="Плановые сроки этапов строительства">
            <div className="planning-timeline planning-gantt-classic">
              <div className="planning-timeline-head">
                <span>Этап СМР / Длительность</span>
                <div className="planning-ruler">{timelineTicks.map((tick, index) => <span key={tick.pct}
                  className={`planning-tick planning-tick-${index === 0 ? 'first' : index === 5 ? 'last' : 'middle'}`}
                  style={{ left: `${tick.pct}%` }}>{tick.label}</span>)}
                  {isTodayInRange && <span className="planning-today-marker" style={{ left: `${todayPct}%` }}>Сегодня</span>}
                </div>
                <span className="planning-adjust-heading">Длительность</span>
              </div>
              {stages.map(stage => {
                const start = dateTime(stage.planned_start)
                const end = dateTime(stage.planned_end) + DAY
                const hasDates = Number.isFinite(start) && Number.isFinite(end) && end > start
                const left = hasDates ? Math.max(0, Math.min(99, ((start - minTime) / totalMs) * 100)) : 0
                const width = hasDates ? Math.max(1, Math.min(100 - left, ((end - start) / totalMs) * 100)) : 0
                const selected = selectedStage?.id === stage.id
                const period = !hasDates ? 'unknown' : end <= now ? 'past' : start <= now ? 'current' : 'future'
                return <div key={stage.id} className={`planning-row planning-row-${period}${selected ? ' planning-row-selected' : ''}`}>
                  <button type="button" className="planning-row-select" aria-pressed={selected} disabled={isLoading} onClick={() => {
                    setSelectedStageId(stage.id)
                    setEditingStageId(null)
                    setError('')
                  }}>
                    <span className="planning-stage-label"><strong>{stage.order_index}. {stage.name}{period === 'current' && <span className="planning-current-badge">По плану сейчас</span>}</strong>
                      <span>{stage.duration_days} дн. · {formatDate(stage.planned_start)} — {formatDate(stage.planned_end)}</span>
                    </span>
                    <span className="planning-track">
                      {isTodayInRange && <span className="planning-today-line" style={{ left: `${todayPct}%` }} aria-hidden="true" />}
                      {hasDates ? <span className="planning-bar" title={`${stage.duration_days} дн. · ${plannedPeriod(stage, now)}`} style={{ left: `${left}%`, width: `${width}%` }}>{stage.duration_days} дн.</span> : <span className="planning-no-dates">Сроки не указаны</span>}
                    </span>
                  </button>
                  <div className="planning-duration-actions">
                    <button type="button" className="button" aria-label={`Уменьшить длительность: ${stage.name}`} disabled={isLoading || !hasDates || stage.duration_days <= 1} onClick={() => handleAdjustDuration(stage, -1)}>−1д</button>
                    <button type="button" className="button" aria-label={`Увеличить длительность: ${stage.name}`} disabled={isLoading || !hasDates} onClick={() => handleAdjustDuration(stage, 1)}>+1д</button>
                  </div>
                </div>
              })}
            </div>
          </div>
          <div className="planning-legend"><span className="planning-legend-line" /> Сегодня <span>Показаны плановые сроки, а не фактическое выполнение.</span></div>
          {selectedStage && <section className="planning-inspector" aria-label="Выбранный этап">
            <div className="planning-inspector-heading">
              <div><span className="planning-caption">Этап {selectedStage.order_index}</span><h3>{selectedStage.name}</h3></div>
              <div className="planning-toolbar-actions">
                {navigate && <button className="button" onClick={() => {
                  localStorage.setItem('analytics_selected_stage_id', selectedStage.id)
                  navigate('analytics')
                }}>Правила контроля</button>}
                {editingStageId !== selectedStage.id && <button className="button" disabled={isLoading} onClick={() => {
                  setDraftStart(dateValue(selectedStage.planned_start))
                  setDraftEnd(dateValue(selectedStage.planned_end))
                  setEditingStageId(selectedStage.id)
                  setError('')
                }}>Изменить сроки</button>}
              </div>
            </div>
            {editingStageId === selectedStage.id ? <form className="planning-date-form" onSubmit={(event) => { event.preventDefault(); handleSaveDates() }}>
              <label>Начало<input type="date" required disabled={isLoading} value={draftStart} onChange={(event) => setDraftStart(event.target.value)} /></label>
              <label>Окончание<input type="date" required min={draftStart} disabled={isLoading} value={draftEnd} onChange={(event) => setDraftEnd(event.target.value)} /></label>
              <div className="planning-toolbar-actions"><button className="button primary" disabled={isLoading} type="submit">Сохранить</button><button className="button" type="button" disabled={isLoading} onClick={() => { setEditingStageId(null); setError('') }}>Отмена</button></div>
            </form> : <dl className="planning-stage-facts"><div><dt>Плановые сроки</dt><dd>{formatDate(selectedStage.planned_start)} — {formatDate(selectedStage.planned_end)}</dd></div><div><dt>Длительность</dt><dd>{selectedStage.duration_days} дн.</dd></div></dl>}
            {stageRules && <p className="planning-requirements">По справочнику обязательно: {stageRules.mandatory.join(', ') || 'не задано'}.</p>}
          </section>}
        </>}

        {isShiftOpen && <div className="planning-modal-backdrop" onClick={(event) => {
          if (event.target === event.currentTarget && !isLoading) setIsShiftOpen(false)
        }}>
          <section className="planning-dialog" role="dialog" aria-modal="true" aria-labelledby="planning-shift-title" onKeyDown={(event) => {
            if (event.key === 'Escape' && !isLoading) setIsShiftOpen(false)
            if (event.key === 'Tab') {
              const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)')
              const first = controls[0]
              const last = controls[controls.length - 1]
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
              if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
            }
          }}>
            <h3 id="planning-shift-title">Сдвинуть следующие этапы</h3>
            <p>Сроки всех этапов после выбранного изменятся на указанное количество дней.</p>
            <form onSubmit={(event) => { event.preventDefault(); handleCascadeShift() }}>
              <label>Этап задержки<select autoFocus disabled={isLoading} value={delayedStageId} onChange={(event) => setDelayedStageId(event.target.value)}>{stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.order_index}. {stage.name}</option>)}</select></label>
              <label>Дней задержки<input type="number" required min={1} max={180} step={1} disabled={isLoading} value={delayDays} onChange={(event) => setDelayDays(Number(event.target.value))} /></label>
              {error && <p className="planning-error" role="alert">{error}</p>}
              <div className="planning-toolbar-actions"><button className="button primary" disabled={isLoading} type="submit">Применить сдвиг</button><button className="button" disabled={isLoading} type="button" onClick={() => setIsShiftOpen(false)}>Отмена</button></div>
            </form>
          </section>
        </div>}
      </section>
    </div>
  )
}

type Classification = MachineryProbabilityItem['classification']
const ruleLabels: Record<Classification, string> = {
  MANDATORY: 'Обязательная', RECOMMENDED: 'Рекомендованная', NEUTRAL: 'Допустимая', UNCHARACTERISTIC: 'Нехарактерная',
}

export function Analytics({ stages, navigate, toast, onStageOverridesUpdated }: {
  stages: StageItem[]
  navigate: (p: PageKey) => void
  toast?: (s: string) => void
  onStageOverridesUpdated?: (stageId: string) => void
}) {
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem('analytics_selected_stage_id') || '')
  const [probItems, setProbItems] = useState<MachineryProbabilityItem[]>([])
  const [loadedStageId, setLoadedStageId] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState<Record<string, Classification>>({})
  const [hasOverride, setHasOverride] = useState(false)
  const selectedStage = stages.find((stage) => stage.id === selectedId) || getCurrentStageByDate(stages, new Date()) || stages[0]
  const stageId = selectedStage?.id || ''

  useEffect(() => {
    if (!stageId) return
    let current = true
    setIsLoading(true)
    setIsEditing(false)
    setError('')
    fetchStageProbabilities(stageId).then((response) => {
      if (!current) return
      if (response.stage_id !== stageId) throw new Error('Сервис вернул правила другого этапа. Обновите график и повторите загрузку.')
      setProbItems(response.probabilities || [])
      setLoadedStageId(stageId)
      setHasOverride(Boolean(response.has_custom_override))
    }).catch((cause: unknown) => {
      if (current) setError(messageOf(cause, 'Не удалось загрузить правила контроля.'))
    }).finally(() => {
      if (current) setIsLoading(false)
    })
    return () => { current = false }
  }, [stageId, reload])

  const saveRules = async (reset = false) => {
    if (!selectedStage || loadedStageId !== stageId || isLoading || isSaving) return
    if (reset && !window.confirm('Вернуть правила справочника правил выбранного этапа?')) return
    setIsSaving(true)
    setError('')
    try {
      const response = reset
        ? await resetStageProbabilities(stageId, selectedStage.name)
        : await updateStageProbabilities(stageId, draft, selectedStage.name)
      if (response.stage_id !== stageId) throw new Error('Сервис вернул другой этап. Сохранение правил не подтверждено.')
      setProbItems(response.probabilities || [])
      setLoadedStageId(stageId)
      setHasOverride(Boolean(response.has_custom_override))
      setIsEditing(false)
      onStageOverridesUpdated?.(stageId)
      toast?.(reset ? 'Правила возвращены к справочнику' : 'Правила контроля сохранены')
    } catch (cause) {
      setError(messageOf(cause, 'Не удалось сохранить правила. Изменения не применены.'))
    } finally {
      setIsSaving(false)
    }
  }

  if (!stages.length) return <section className="panel rules-panel"><div className="planning-empty"><Icon name="chart" size={30} /><h3>Для правил контроля нужен график</h3><p>Добавьте этапы строительства, чтобы посмотреть требования к технике.</p><button className="button primary" onClick={() => navigate('progress')}>Перейти к графику</button></div></section>

  const ready = loadedStageId === stageId && !isLoading
  return <section className="panel rules-panel" aria-busy={isLoading || isSaving}>
    <div className="rules-toolbar">
      <label className="rules-stage-picker">Этап строительства<select value={stageId} disabled={isSaving} onChange={(event) => {
        if (isEditing && !window.confirm('Перейти к другому этапу без сохранения изменений?')) return
        setIsEditing(false)
        setSelectedId(event.target.value)
        localStorage.setItem('analytics_selected_stage_id', event.target.value)
      }}>{stages.map((stage) => <option key={stage.id} value={stage.id}>{stage.order_index}. {stage.name}</option>)}</select></label>
      {ready && probItems.length > 0 && <div className="planning-toolbar-actions">{isEditing ? <><button className="button" disabled={isSaving} onClick={() => { setIsEditing(false); setError('') }}>Отмена</button><button className="button primary" disabled={isSaving} onClick={() => void saveRules()}>{isSaving ? 'Сохраняем…' : 'Сохранить'}</button></> : <button className="button" disabled={isSaving} onClick={() => {
        setDraft(Object.fromEntries(probItems.map((item) => [item.machinery_code, item.classification])))
        setIsEditing(true)
      }}>Редактировать</button>}</div>}
    </div>
    {isSaving && <p className="planning-feedback" role="status">Сохраняем правила контроля…</p>}
    {error && <div className="planning-error" role="alert">{error} {!isEditing && <button className="button" disabled={isLoading || isSaving} onClick={() => setReload((value) => value + 1)}>Повторить</button>}</div>}
    {!ready ? <div className="planning-empty" role="status">{error ? 'Правила недоступны' : 'Загружаем правила контроля…'}</div> : probItems.length === 0 ? <div className="planning-empty"><h3>Для этого этапа пока нет правил</h3><p>Выберите другой этап или повторите загрузку.</p><button className="button" onClick={() => setReload((value) => value + 1)}>Обновить</button></div> : <>
      <p className="rules-context">{hasOverride ? 'Сохранённые правила этапа.' : 'Правила этапа из справочника.'}</p>
      <div className="rules-table-scroll"><table className="rules-table"><thead><tr><th scope="col">Техника</th><th scope="col">Правило контроля</th></tr></thead><tbody>{probItems.map((item) => <tr key={item.machinery_code}>
        <th scope="row">{item.machinery_name_ru}</th>
        <td>{isEditing ? <select aria-label={`Правило контроля: ${item.machinery_name_ru}`} disabled={isSaving} value={draft[item.machinery_code] || item.classification} onChange={(event) => setDraft((previous) => ({ ...previous, [item.machinery_code]: event.target.value as Classification }))}>{Object.entries(ruleLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : <span className={`rules-level rules-level-${item.classification.toLowerCase()}`}>{ruleLabels[item.classification]}</span>}</td>
      </tr>)}</tbody></table></div>
      {!isEditing && hasOverride && <details className="rules-reset"><summary>Настройки правил</summary><p>Вернуть требования выбранного этапа к значениям справочника.</p><button className="button" disabled={isSaving} onClick={() => void saveRules(true)}>Вернуть правила справочника</button></details>}
    </>}
  </section>
}
