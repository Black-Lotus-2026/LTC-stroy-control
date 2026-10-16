import { useEffect, useRef, useState } from 'react'
import { isValidUuid, normalizeSnapshotUrl, updateIncidentStatus, type ProjectItem } from '../../api/stroyControlApi'
import { managementApi, type AnalysisMode, type DemoEpisode, type ManagementRun, type ManagementRunSummary, type ManagementSnapshot, type ScenarioResult, type DecimalValue } from '../../api/managementApi'
import './management.css'

const statusLabels: Record<string, string> = { queued: 'В очереди', pending: 'Ожидает', running: 'Выполняется', completed: 'Завершён', complete: 'Рассчитано', partial: 'Частичный результат', needs_input: 'Нужны данные', failed: 'Ошибка', skipped: 'Пропущен', passed: 'Проверка пройдена', needs_revision: 'Есть замечания', insufficient_data: 'Недостаточно данных', invalid_input: 'Ошибка входных данных', supported_risk: 'Риск обоснован', needs_review: 'Нужна проверка', insufficient_evidence: 'Недостаточно наблюдений' }
const roles: Record<string, string> = { evidence: 'Проверка оснований', calculation: 'Расчёт сценариев', actions: 'Предложение действия', reviewer: 'Проверка обоснования' }
const episodes: [DemoEpisode, string][] = [['baseline', 'Контрольный пример'], ['camera_unavailable', 'Камера недоступна'], ['slack', 'Запас времени'], ['expensive_action', 'Дорогое вмешательство']]
const incidentStatuses: Record<string, string> = { pending: 'Требует проверки', confirmed: 'Подтверждён человеком', in_progress: 'В работе', resolved: 'Устранён', false_positive: 'Ложное срабатывание' }
const inputLabels: Record<string, string> = { model_unavailable: 'Модель распознавания недоступна — вывод по этому кадру невозможен.', model_failed: 'Ошибка распознавания кадра.', camera_offline: 'Камера недоступна — нужны свежие наблюдения.', camera_unknown: 'Состояние камеры неизвестно.', human_blockage_confirmation: 'Нужно подтверждение блокировки и загрузки ресурсов человеком.', no_evidence: 'Наблюдения не приложены.', stale_capture: 'Кадр устарел относительно даты анализа.', future_capture: 'Время съёмки позже даты анализа.', camera_time_skew: 'Время съёмки камер недостаточно согласовано.', camera_zone_mismatch: 'Камера не соответствует зоне анализа.', unknown_zone: 'Зона наблюдения не определена.', rule_not_applicable: 'Правило не применяется к выбранной работе.', required_class_missing: 'Требуемый класс техники отсутствует в детекциях; это не подтверждает простой.' }
const active = (run: ManagementRun | null) => run?.status === 'queued' || run?.status === 'running'
const date = (value?: string | null) => value ? new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : 'Не задано'
function numeric(value: DecimalValue | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'Нет данных'
  // Keep Decimal strings exact, including totals above Number.MAX_SAFE_INTEGER.
  let raw = String(value)
  const scientific = /^(-?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(raw)
  if (scientific) {
    const digits = scientific[2] + (scientific[3] || '')
    const point = scientific[2].length + Number(scientific[4])
    if (Math.abs(point) < 1000) raw = scientific[1] + (point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point))
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw)
  if (!match) return Number.isFinite(Number(raw)) ? new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 8 }).format(Number(raw)) : 'Нет данных'
  const fraction = (match[3] || '').replace(/0+$/, '')
  return `${match[1]}${new Intl.NumberFormat('ru-RU').format(BigInt(match[2]))}${fraction ? ',' + fraction : ''}`
}
const money = (value: DecimalValue | null | undefined, currency = 'RUB') => value === null || value === undefined ? 'Нет данных' : `${numeric(value)} ${currency === 'RUB' ? '₽' : currency}`
const label = (status: string) => statusLabels[status] || status
const message = (error: unknown) => error instanceof Error ? error.message : 'Не удалось выполнить запрос'
const storageKey = (projectId: string) => `management-selected-run:${projectId}`
function remember(projectId: string, id: string) { try { localStorage.setItem(storageKey(projectId), id) } catch { /* History remains on the server. */ } }
function remembered(projectId: string) { try { return localStorage.getItem(storageKey(projectId)) } catch { return null } }
function Lines({ items }: { items: string[] }) { return items.length ? <ul className="mg-lines">{items.map((text, index) => <li key={index}>{inputLabels[text] || text}</li>)}</ul> : null }
function Badge({ status }: { status: string }) { return <span className={`mg-badge mg-status-${status}`}>{label(status)}</span> }
function References({ values }: { values: string[] }) { return values.length ? <span className="mg-refs">Источники: {values.join(' · ')}</span> : null }
function metricText(reference: string, run: ManagementRun): string {
  const match = /^scenario\.([A-Za-z0-9_.:-]+)\.(total_cost|idle_cost|extension_cost|intervention_cost|other_cost|incremental_delay_work_hours|scenario_milestone_at)$/.exec(reference)
  if (!match) return reference
  const result = run.results.find(item => item.scenario_id === match[1])
  if (!result) return `${reference} — результат недоступен`
  const scenario = run.snapshot.scenarios.find(item => item.id === match[1])?.title || match[1]
  const metric = match[2] as 'total_cost' | 'idle_cost' | 'extension_cost' | 'intervention_cost' | 'other_cost' | 'incremental_delay_work_hours' | 'scenario_milestone_at'
  const titles = { total_cost: 'всего', idle_cost: 'простой', extension_cost: 'продление', intervention_cost: 'действие', other_cost: 'другие затраты', incremental_delay_work_hours: 'перенос', scenario_milestone_at: 'контрольная точка' }
  const value = metric === 'scenario_milestone_at' ? `${date(result[metric])} МСК` : metric === 'incremental_delay_work_hours' ? `${numeric(result[metric])} раб. ч` : money(result[metric], result.currency)
  return `${scenario} · ${titles[metric]}: ${value}`
}

export function ManagementPanel({ projects, selectedProjectId, onSelectProject }: { projects: ProjectItem[]; selectedProjectId: string | null; onSelectProject: (id: string) => void }) {
  const available = projects.filter(p => isValidUuid(p.id))
  const projectId = available.some(p => p.id === selectedProjectId) ? selectedProjectId || '' : available[0]?.id || ''
  // Keying the body isolates asynchronous responses and drafts when the object changes.
  return <section className="mg-panel">
    <div className="mg-heading"><div><span className="mg-eyebrow">Управление реакцией</span><h2>Решения</h2><p>Основания, последствия и три сценария на одну дату анализа.</p></div>
      <label className="mg-project">Объект<select aria-label="Объект для решения" value={projectId} onChange={e => onSelectProject(e.target.value)} disabled={!available.length}>{!available.length && <option value="">Нет доступных объектов</option>}{available.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></label>
    </div>
    {projectId ? <ManagementWorkspace key={projectId} projectId={projectId} /> : <div className="mg-empty">Добавьте доступный объект во вкладке «Объекты», чтобы сохранить профиль и карточку решения. Пустой список не содержит демонстрационных событий.</div>}
  </section>
}

function ManagementWorkspace({ projectId }: { projectId: string }) {
  const [draft, setDraft] = useState<ManagementSnapshot | null>(null)
  const [savedDraft, setSavedDraft] = useState<ManagementSnapshot | null>(null)
  const [run, setRun] = useState<ManagementRun | null>(null)
  const [runs, setRuns] = useState<ManagementRunSummary[]>([])
  const [mode, setMode] = useState<AnalysisMode>('deterministic')
  const [episode, setEpisode] = useState<DemoEpisode>('baseline')
  const [busy, setBusy] = useState<string | null>('load')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [profileTime, setProfileTime] = useState<string | null>(null)
  const [pollError, setPollError] = useState('')
  const mounted = useRef(true)
  const pendingSubmission = useRef<{ signature: string; key: string } | null>(null)
  const form = useRef<HTMLFormElement>(null)
  const changed = Boolean(draft && run && JSON.stringify(draft) !== JSON.stringify(run.snapshot))
  const profileChanged = Boolean(draft && JSON.stringify(draft) !== JSON.stringify(savedDraft))

  useEffect(() => {
    mounted.current = true
    const controller = new AbortController()
    async function load() {
      try {
        const [profile, history] = await Promise.all([managementApi.profile(projectId, controller.signal), managementApi.runs(projectId, controller.signal)])
        if (!mounted.current) return
        setSavedDraft(profile.snapshot); setDraft(profile.snapshot); setProfileTime(profile.updated_at); setRuns(history)
        const selected = history.find(item => item.id === remembered(projectId)) || history[0]
        if (selected) {
          const item = await managementApi.run(selected.id, controller.signal)
          if (!mounted.current) return
          setRun(item); setDraft(profile.snapshot || item.snapshot); setMode(item.mode)
          if (profile.snapshot && JSON.stringify(profile.snapshot) !== JSON.stringify(item.snapshot)) setNotice('В форме — сохранённый профиль. Ниже — ранее рассчитанная карточка со своими входами.')
        }
      } catch (failure) { if (!controller.signal.aborted) setError(message(failure)) }
      finally { if (mounted.current) setBusy(null) }
    }
    void load()
    return () => { mounted.current = false; controller.abort() }
  }, [projectId])

  useEffect(() => {
    if (!run || !active(run)) return
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout>
    async function poll(id: string) {
      try {
        const item = await managementApi.run(id, controller.signal)
        if (controller.signal.aborted) return
        setRun(item); setPollError('')
        setRuns(previous => [item, ...previous.filter(other => other.id !== item.id)])
        if (active(item)) timeout = setTimeout(() => { void poll(id) }, 2000)
      } catch (failure) {
        if (!controller.signal.aborted) {
          setPollError(`Обновление статуса недоступно: ${message(failure)}. Показаны последние сохранённые данные.`)
          timeout = setTimeout(() => { void poll(id) }, 5000)
        }
      }
    }
    timeout = setTimeout(() => { void poll(run.id) }, 1500)
    return () => { controller.abort(); clearTimeout(timeout) }
  }, [run?.id, run?.status])

  async function perform(name: string, action: () => Promise<void>) {
    if (busy) return
    setBusy(name); setError(''); setNotice('')
    try { await action() } catch (failure) { if (mounted.current) setError(message(failure)) }
    finally { if (mounted.current) setBusy(null) }
  }
  function edit(mutator: (copy: ManagementSnapshot) => void) {
    setDraft(previous => { if (!previous) return previous; const copy = structuredClone(previous); mutator(copy); return copy })
    setNotice('')
  }
  async function selectRun(id: string) {
    await perform('history', async () => {
      const item = await managementApi.run(id)
      if (!mounted.current) return
      setRun(item); setDraft(item.snapshot); setMode(item.mode); setPollError(''); remember(projectId, id)
    })
  }
  function saveProfile() {
    if (!draft || !form.current?.reportValidity()) return
    void perform('save', async () => {
      const profile = await managementApi.saveProfile(projectId, draft)
      if (!mounted.current) return
      setSavedDraft(profile.snapshot); setProfileTime(profile.updated_at); setNotice('Профиль сохранён на сервере. Ранее созданные карточки не изменились.')
    })
  }
  function startRun() {
    if (!draft || !form.current?.reportValidity()) return
    const signature = JSON.stringify({ draft, mode, parent: run?.id || null })
    if (pendingSubmission.current?.signature !== signature) pendingSubmission.current = { signature, key: crypto.randomUUID() }
    const idempotencyKey = pendingSubmission.current.key
    void perform('run', async () => {
      const item = await managementApi.create(draft, mode, idempotencyKey, run?.id || null)
      if (!mounted.current) return
      setRun(item); setDraft(item.snapshot); setRuns(previous => [item, ...previous.filter(other => other.id !== item.id)])
      remember(projectId, item.id); pendingSubmission.current = null; setPollError('')
      setNotice('Создана сохранённая карточка с неизменяемым снимком входных данных.')
    })
  }

  return <>
    <div className="mg-toolbar">
      <label>Демонстрационный эпизод<select value={episode} onChange={e => setEpisode(e.target.value as DemoEpisode)} disabled={Boolean(busy)}>{episodes.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
      <button type="button" disabled={Boolean(busy) || active(run)} onClick={() => void perform('demo', async () => {
        const snapshot = await managementApi.demo(projectId, episode)
        if (!mounted.current) return
        setDraft(snapshot); setRun(null); setPollError(''); setNotice('Демонстрационный профиль загружен. Он не является фактическими данными объекта и ещё не сохранён.')
      })}>{busy === 'demo' ? 'Загрузка…' : 'Загрузить демо профиль'}</button>
      <label className="mg-history">Сохранённые карточки<select aria-label="История решений" value={run?.id || ''} disabled={Boolean(busy) || !runs.length} onChange={e => { if (e.target.value) void selectRun(e.target.value) }}><option value="">{runs.length ? 'Выберите сохранённый запуск' : 'Карточек пока нет'}</option>{runs.map(item => <option key={item.id} value={item.id}>{date(item.created_at)} · {label(item.status)} · {item.mode === 'llm' ? 'LLM' : 'Без LLM'} · {item.id.slice(0, 6)}</option>)}</select></label>
    </div>
    {error && <div role="alert" className="mg-notice mg-error">{error}</div>}
    {pollError && <div role="alert" className="mg-notice mg-warning">{pollError}</div>}
    {notice && <div role="status" className="mg-notice">{notice}</div>}
    {busy === 'load' && <div className="mg-empty" role="status">Загружаем сохранённый профиль и историю…</div>}
    {!draft && !busy && <div className="mg-empty"><h3>Исходные данные ещё не заданы</h3><p>Загрузите явно обозначенный демонстрационный профиль, затем изучите допущения и запустите сравнение. Сохранённых результатов и подтверждённых наблюдений пока нет.</p></div>}
    {draft && <form ref={form} className="mg-card mg-editor" onSubmit={event => { event.preventDefault(); startRun() }}>
      <div className="mg-section-heading"><div><h3>Сценарные входы</h3><p>Восстановление задаётся в рабочих часах от {date(draft.as_of)} МСК.</p></div><span className={`mg-badge ${draft.data_mode === 'demo' ? 'mg-demo' : ''}`}>{draft.data_mode === 'demo' ? 'Демо · условные входы' : 'Пользовательские входы'}</span></div>
      <fieldset disabled={Boolean(busy) || active(run)} className="mg-fields">
        <div className="mg-scenario-inputs">{draft.scenarios.map((scenario, index) => <label key={scenario.id}>{scenario.title}<div className="mg-number"><input aria-label={`Восстановление: ${scenario.title}`} required type="number" min="0" max="87600" step="any" value={scenario.recovery_work_hours} onChange={e => edit(copy => { copy.scenarios[index].recovery_work_hours = e.target.value; copy.scenarios[index].assumptions = copy.scenarios[index].assumptions.map(text => text.startsWith(`demo:scenario:${scenario.id}:`) ? `demo:scenario:${scenario.id}: время восстановления отредактировано пользователем; действующее значение указано в поле сценария. Это допущение, не прогноз наличия техники.` : text) })} /><span>раб. ч</span></div>{!scenario.action_allowed && <small>Действие недопустимо по входным ограничениям</small>}</label>)}</div>
        <details className="mg-input-details"><summary>Ставки и затронутые ресурсы · {draft.resources.length}</summary><p className="mg-muted">Отметка означает сценарное допущение об оплачиваемом простое. Наличие машины в кадре само по себе его не подтверждает.</p><div className="mg-resource-grid">{draft.resources.map((resource, ri) => <div className="mg-resource" key={resource.resource_id}>
          <label className="mg-check"><input type="checkbox" checked={resource.paid_and_affected} onChange={e => edit(copy => { copy.resources[ri].paid_and_affected = e.target.checked })} /><strong>{resource.name}</strong><span>Оплачивается и затронут</span></label>
          <p className="mg-muted">Количество: {numeric(resource.quantity)} · Доля простоя: {numeric(resource.idle_fraction)}<br />Источник: {resource.source}</p>
          {resource.rates.map((rate, index) => <label key={rate.id}>Ставка · {rate.currency}/{rate.unit === 'work_hour' ? 'раб. ч' : rate.unit === 'work_day' ? 'раб. день' : 'кал. день'}<input aria-label={`Ставка: ${resource.name}, ${rate.id}`} type="number" min="0" max="1000000000000" step="any" placeholder="Неизвестна" value={rate.amount ?? ''} onChange={e => edit(copy => { copy.resources[ri].rates[index].amount = e.target.value === '' ? null : e.target.value; copy.resources[ri].rates[index].confirmation = copy.data_mode === 'demo' ? 'demo' : 'user_assumption'; copy.assumptions = copy.assumptions.map(text => text.startsWith('Источник demo:rates:') ? 'Источник demo:rates: ставки отредактированы пользователем; действующие значения и единицы сохранены отдельно для каждого ресурса.' : text) })} /><small>{rate.confirmation === 'demo' ? 'Демонстрационная' : rate.confirmation === 'confirmed' ? 'Подтверждённая' : 'Допущение пользователя'} · {rate.source}</small></label>)}
        </div>)}</div></details>
        <div className="mg-actions"><label>Режим анализа<select value={mode} onChange={e => setMode(e.target.value as AnalysisMode)}><option value="deterministic">Без LLM · расчёт и проверки</option><option value="llm">Три LLM роли</option></select></label><button type="button" onClick={saveProfile} disabled={!profileChanged}>{busy === 'save' ? 'Сохранение…' : 'Сохранить профиль'}</button><button type="submit" className="mg-primary">{busy === 'run' ? 'Создание карточки…' : active(run) ? 'Анализ выполняется…' : run ? 'Новый расчёт' : 'Рассчитать и сохранить'}</button>{savedDraft && profileChanged && <button type="button" onClick={() => { setDraft(savedDraft); setNotice('Загружен сохранённый профиль. Ранее рассчитанная карточка не изменилась.') }}>Загрузить сохранённый профиль</button>}{run && changed && <button type="button" onClick={() => { setDraft(run.snapshot); setNotice('В форме — входы выбранной карточки. Сохранённый профиль не изменён.') }}>Входы выбранной карточки</button>}</div>
      </fieldset>
      <p className="mg-footnote">{mode === 'deterministic' ? 'Детерминированный режим: агентные роли пропускаются, сроки и суммы рассчитывает калькулятор.' : 'Три отдельных вызова LLM: основания, выбор действия и проверка. При недоступности провайдера отсутствие анализа будет явно обозначено.'}{profileTime && <> Профиль сохранён {date(profileTime)} МСК.</>}</p>
      {changed && <p className="mg-draft-warning">Входы изменены. Ниже — прежний сохранённый результат. Новый расчёт создаст отдельную версию.</p>}
    </form>}
    {run && <><IncidentStatusControl key={`${run.id}:${run.incident?.status}`} run={run} disabled={Boolean(busy)} onSave={status => void perform('incident', async () => {
      if (!run.incident_id) return
      await updateIncidentStatus(run.incident_id, status)
      const updated = await managementApi.run(run.id)
      if (!mounted.current) return
      setRun(updated)
      if (updated.incident?.status !== status) throw new Error('Сервер не подтвердил выбранный статус. Показано сохранённое состояние инцидента.')
      setNotice('Статус инцидента сохранён и повторно прочитан с сервера. Снимок допущений расчёта не изменён.')
    })} /><DecisionCard run={run} /></>}
  </>
}

function IncidentStatusControl({ run, disabled, onSave }: { run: ManagementRun; disabled: boolean; onSave: (status: string) => void }) {
  const [status, setStatus] = useState(run.incident?.status || '')
  if (!run.incident_id || !run.incident) return null
  return <div className="mg-incident"><div><strong>{run.incident.code} · Статус инцидента</strong><p>Сохранён: {incidentStatuses[run.incident.status] || run.incident.status}. Статус не подтверждает допущения сценария автоматически.</p></div><label>Новый статус<select aria-label="Статус инцидента" value={status} disabled={disabled} onChange={event => setStatus(event.target.value)}>{Object.entries(incidentStatuses).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label><button type="button" disabled={disabled || status === run.incident.status} onClick={() => onSave(status)}>Сохранить статус</button></div>
}

function DecisionCard({ run }: { run: ManagementRun }) {
  const { snapshot, assessment, proposal, review } = run
  const recommendedId = proposal?.recommended_scenario_id || run.comparison?.recommended_scenario_id
  const recommendation = snapshot.scenarios.find(item => item.id === recommendedId)
  const milestone = snapshot.tasks.find(item => item.id === snapshot.milestone_task_id)
  const blocked = snapshot.tasks.find(item => item.id === snapshot.blocked_task_id)
  const result = run.results.find(item => item.scenario_id === recommendedId)
  const showRecommendation = !review || review.status === 'passed'
  const actualMode = run.effective_mode || run.mode
  const reviewerStep = run.steps.find(step => step.role === 'reviewer')
  const reviewLabel = review ? `${reviewerStep?.generation === 'llm' ? 'LLM' : 'По правилам'}: ${label(review.status).toLocaleLowerCase('ru-RU')}` : run.mode === 'deterministic' ? 'LLM проверка пропущена' : 'Нет результата проверки'
  return <article className="mg-card mg-decision">
    <div className="mg-section-heading"><div><span className="mg-eyebrow">{active(run) ? 'Текущий запуск' : 'Сохранённая карточка'} · {date(run.created_at)} МСК</span><h3>{blocked?.name || 'Ситуация на объекте'}</h3></div><Badge status={run.status} /></div>
    <div className="mg-context"><span>Зона: {snapshot.zone_id}</span><span>Анализ на {date(run.as_of)} МСК</span><span>{snapshot.data_mode === 'demo' ? 'Демонстрационные наблюдения' : 'Пользовательские данные'}</span><span>{actualMode === 'deterministic' ? 'Детерминированный результат · без LLM' : actualMode === 'partial' ? 'Частичный LLM анализ · подробности в журнале' : active(run) ? 'Запрошены три LLM роли' : 'Результат LLM анализа'}</span>{run.incident && <span>{run.incident.code} · {incidentStatuses[run.incident.status] || run.incident.status}</span>}</div>
    {run.mode === 'llm' && actualMode === 'deterministic' && <p className="mg-notice mg-warning">LLM анализ не выполнен. Сохранён расчёт и проверки по правилам. Реальные статусы каждого этапа показаны ниже.</p>}
    {run.error && <p className="mg-notice mg-error">{run.error}</p>}
    <div className="mg-progress" aria-label="Сохранённые этапы анализа">{Object.entries(roles).map(([role, title]) => {
      const step = run.steps.find(item => item.role === role)
      return <div key={role}><span>{title}</span>{step ? <Badge status={step.status} /> : <small>Нет сохранённого этапа</small>}</div>
    })}</div>
    <div className="mg-signal"><div><span className="mg-eyebrow">01 · Основания</span><h4>{assessment ? label(assessment.verdict) : 'Анализ оснований ещё не завершён'}</h4><p>{snapshot.blockage_confirmation === 'human_confirmed' ? `Блокировка подтверждена человеком: ${snapshot.confirmation_source}` : 'Блокировка — гипотеза. Отсутствие детекции не доказывает простой.'}</p></div><div><span className="mg-eyebrow">02 · Контрольная точка</span><h4>{milestone?.name || snapshot.milestone_task_id}</h4><p>{result ? `${date(result.scenario_milestone_at)} МСК · перенос ${numeric(result.incremental_delay_work_hours)} раб. ч` : 'Дата и перенос появятся после расчёта сценариев.'}</p><small>Относительно опорного прогноза без новой блокировки</small></div></div>
    {assessment?.missing_inputs.length ? <div className="mg-notice mg-warning"><strong>Не хватает оснований</strong><Lines items={assessment.missing_inputs} /></div> : null}
    <div className="mg-section-heading"><h4>03 · Сравнение реакции</h4><small>Будущие дополнительные затраты от даты анализа</small></div>
    <div className="mg-table-scroll"><table className="mg-scenarios"><thead><tr><th scope="col">Сценарий</th><th scope="col">Восстановление</th><th scope="col">Перенос точки</th><th scope="col">Простой</th><th scope="col">Продление</th><th scope="col">Действие</th><th scope="col">Другие</th><th scope="col">Всего</th></tr></thead><tbody>{snapshot.scenarios.map(scenario => {
      const item = run.results.find(value => value.scenario_id === scenario.id)
      return <tr key={scenario.id} className={scenario.id === recommendedId ? 'mg-selected-scenario' : ''}><th scope="row">{scenario.title}{scenario.id === recommendedId && <small>{showRecommendation ? 'Предлагаемый вариант' : 'Предложение требует проверки'}</small>}{!scenario.action_allowed && <small>Действие недопустимо</small>}</th><td>{numeric(scenario.recovery_work_hours)} раб. ч</td><td>{item ? `${numeric(item.incremental_delay_work_hours)} раб. ч` : 'Ожидает расчёта'}</td><td>{money(item?.idle_cost, item?.currency)}</td><td>{money(item?.extension_cost, item?.currency)}</td><td>{money(item?.intervention_cost, item?.currency)}</td><td>{money(item?.other_cost, item?.currency)}</td><td className="mg-total">{money(item?.total_cost, item?.currency)}{item && item.status !== 'complete' && <small>{label(item.status)}</small>}</td></tr>
    })}</tbody></table></div>
    {run.comparison && <div className="mg-effect"><div><span>Расчётное сокращение дополнительных затрат</span><strong>{money(run.comparison.net_avoidable_cost, run.comparison.currency)}</strong></div><p>При указанных допущениях, относительно сценария без дополнительного действия. Это условная разница сценариев, не фактически достигнутая экономия.<br /><small>Критерий: {run.comparison.criterion}</small></p></div>}
    <div className="mg-recommendation"><div><span className="mg-eyebrow">04 · Предлагаемое действие</span><h4>{proposal?.proposed_action.title || recommendation?.title || (active(run) ? 'Предложение ещё не готово' : 'Действие пока не рекомендовано')}</h4><p>{proposal ? `Условие проверки: ${proposal.proposed_action.verification_condition}` : run.mode === 'deterministic' ? 'Шаблонное сравнение допустимых сценариев по критерию калькулятора; агентного предложения нет.' : 'Для предложения нужны валидные результаты агентного этапа.'}</p>{proposal?.proposed_action.suggested_due_at && <p>Предлагаемый срок: {date(proposal.proposed_action.suggested_due_at)} МСК</p>}<Lines items={proposal?.required_human_inputs || []} /></div><div><span className="mg-eyebrow">05 · Проверка вывода</span><h4>{reviewLabel}</h4>{review?.issues.map((issue, index) => <p key={index}>{issue.affected_claim}<br /><strong>{issue.suggested_fix}</strong><References values={issue.source_refs} /></p>)}<Lines items={review?.unresolved_assumptions || []} /></div></div>
    <details className="mg-details"><summary>Наблюдения, гипотезы и источники</summary>
      {assessment && <div className="mg-two-columns"><div><h4>Наблюдения</h4>{assessment.observations.map((item, index) => <p key={index}>{item.claim}<References values={item.source_refs} /></p>)}{!assessment.observations.length && <p className="mg-muted">Подтверждённых наблюдений нет.</p>}</div><div><h4>Гипотезы</h4>{assessment.hypotheses.map((item, index) => <div key={index}><p>{item.claim}<References values={item.supporting_refs} /></p><Lines items={item.missing_checks} /></div>)}<Lines items={assessment.unsupported_claims} /></div></div>}
      <div className="mg-evidence-grid">{snapshot.evidence.map(evidence => <div className="mg-evidence" key={evidence.source_ref}>{evidence.image_url ? <img src={normalizeSnapshotUrl(evidence.image_url)} alt={`Наблюдение ${evidence.source_ref}, ${date(evidence.captured_at)} МСК`} loading="lazy" /> : <div className="mg-no-image">Изображение не приложено</div>}<strong>{evidence.camera_id} · {evidence.zone_id}</strong><p>Снято {date(evidence.captured_at)} МСК<br />Камера: {evidence.camera_status === 'online' ? 'доступна' : evidence.camera_status === 'offline' ? 'недоступна' : 'статус неизвестен'} · Модель: {evidence.model_status === 'valid' ? 'валидный результат' : evidence.model_status === 'unavailable' ? 'недоступна' : 'ошибка'}</p><p>{evidence.origin === 'demo_replay' ? 'Демонстрационное наблюдение' : evidence.origin === 'persisted_frame' ? 'Сохранённый кадр' : 'Наблюдение пользователя'}. Классы: {evidence.model_status === 'valid' ? evidence.detected_classes.join(', ') || 'нет детекций' : 'не интерпретируются'}</p><References values={[evidence.source_ref]} /></div>)}</div>
      {!snapshot.evidence.length && <p>Наблюдения не приложены. Сценарный расчёт не является подтверждением нарушения.</p>}
      <p className="mg-muted">Правило {snapshot.rule.version}: требуется {snapshot.rule.required_class}; этапы {snapshot.rule.applicable_task_ids.join(', ')}. Источник: {snapshot.rule.source_ref}. Допустимый возраст кадра: {snapshot.rule.max_frame_age_minutes} мин.</p>
    </details>
    <details className="mg-details"><summary>Допущения, ставки и воспроизводимый расчёт</summary>
      <p>Смена {snapshot.calendar.shift_start}–{snapshot.calendar.shift_end}, {snapshot.calendar.timezone}. Версия графика: {snapshot.schedule_version}; профиля: {snapshot.profile_version}.</p><Lines items={snapshot.assumptions} />
      {proposal && <div className="mg-alternatives"><h4>Основания выбора действия</h4>{proposal.alternatives.map(alternative => <div key={alternative.scenario_id}><strong>{snapshot.scenarios.find(item => item.id === alternative.scenario_id)?.title || alternative.scenario_id}</strong><p>{alternative.rationale}</p><Lines items={alternative.metric_refs.map(reference => metricText(reference, run))} /><Lines items={alternative.assumptions} /></div>)}<References values={proposal.source_refs} /></div>}
      {run.results.map(item => <CalculationDetails key={item.scenario_id} result={item} snapshot={snapshot} />)}
      <details className="mg-raw"><summary>Неизменяемые исходные данные карточки</summary><pre>{JSON.stringify(snapshot, null, 2)}</pre></details>
    </details>
    <details className="mg-details"><summary>Журнал выполнения · {run.steps.filter(step => step.status === 'completed').length} из {run.steps.length} этапов завершено</summary><p className="mg-muted">Показаны только сохранённые сервером состояния. Пропуск роли не означает успешную LLM проверку.</p><div className="mg-step-list">{run.steps.map((step, index) => <div className="mg-step" key={`${step.role}-${index}`}><div><strong>{roles[step.role] || step.role}</strong><Badge status={step.status} /></div><p>{step.started_at ? `${date(step.started_at)} → ${date(step.finished_at)} МСК` : 'Выполнение не начато'} · LLM вызовов: {step.llm_calls ?? 0} · Попыток: {step.attempts ?? 0}</p>{(step.provider || step.model) && <p>{step.provider} / {step.model} · Инструкция {step.prompt_version || 'не задана'}</p>}{step.error && <p className="mg-step-error">{step.error}</p>}{step.result != null && <details className="mg-raw"><summary>Сохранённый результат этапа</summary><pre>{JSON.stringify(step.result, null, 2)}</pre></details>}</div>)}</div>{!run.steps.length && <p>Сохранённых этапов пока нет.</p>}</details>
    <footer className="mg-card-footer"><span>Карточка: {run.id}</span><span>Инцидент: {run.incident_id || 'не привязан'}</span>{run.parent_run_id && <span>Предыдущая версия: {run.parent_run_id}</span>}</footer>
  </article>
}

function CalculationDetails({ result, snapshot }: { result: ScenarioResult; snapshot: ManagementSnapshot }) {
  return <details className="mg-calculation"><summary>{snapshot.scenarios.find(item => item.id === result.scenario_id)?.title || result.scenario_id} · {money(result.total_cost, result.currency)}</summary><p><Badge status={result.status} /> Опорная точка: {date(result.reference_milestone_at)}; сценарная: {date(result.scenario_milestone_at)} МСК.</p><p>Перенос относительно опорного прогноза: {numeric(result.incremental_delay_work_hours)} раб. ч. Отклонение от согласованного срока: {result.deadline_variance_work_hours === null ? 'срок не задан' : `${numeric(result.deadline_variance_work_hours)} раб. ч`}.</p><Lines items={result.missing_inputs} />
    <div className="mg-components">{result.cost_components.map(component => <div key={component.id}><strong>{component.title} · {money(component.amount, component.currency)}</strong><p>{component.formula}<br />Источник: {component.source}<br />Группа затрат: {component.cost_group}</p><pre>{JSON.stringify(component.inputs, null, 2)}</pre></div>)}</div><Lines items={result.assumptions} /><Lines items={result.calculation_trace} />
    <div className="mg-table-scroll"><table><thead><tr><th>Работа</th><th>Опорный финиш, раб. ч</th><th>Сценарный финиш, раб. ч</th><th>Финиш, МСК</th></tr></thead><tbody>{result.affected_tasks.map(task => <tr key={task.task_id}><td>{snapshot.tasks.find(item => item.id === task.task_id)?.name || task.task_id}</td><td>{numeric(task.reference_finish_work_hours)}</td><td>{numeric(task.finish_work_hours)}</td><td>{date(task.finish_at)}</td></tr>)}</tbody></table></div><p className="mg-footnote">Калькулятор: {result.calculator_version}<br />Хеш входа: <code>{result.input_hash}</code></p>
  </details>
}

export default ManagementPanel
