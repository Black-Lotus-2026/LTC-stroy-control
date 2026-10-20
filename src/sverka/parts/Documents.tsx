import { useEffect, useRef, useState } from 'react'
import * as api from '../api'
import type { DocumentAgentStatus, DocumentKind, DocumentRun, DocumentSelection, ProjectDocument } from '../api'
import { useToast } from './common'

const kindName: Record<DocumentKind, string> = { POS: 'ПОС', PPR: 'ППР', TER: 'ТЕР' }
const key = (stageId: string, code: string) => `${stageId}:${code}`
const pct = (value: number | null) => value == null ? 'нет оценки' : `${Math.round(value * 100)}%`
const skipReason: Record<string, string> = {
  documents_changed: 'документы изменились во время анализа',
  stage_changed: 'этап изменился во время анализа',
  rule_changed: 'правило было изменено во время анализа',
  manual_override: 'сохранена ручная правка',
  already_applied: 'правило уже применено',
}

export function DocumentsPanel({ projectId, canWrite, onRulesChanged }: {
  projectId: string
  canWrite: boolean
  onRulesChanged: (stageIds: string[]) => Promise<void>
}) {
  const toast = useToast()
  const [docs, setDocs] = useState<ProjectDocument[]>([])
  const [kind, setKind] = useState<DocumentKind>('PPR')
  const [run, setRun] = useState<DocumentRun | null>(null)
  const [history, setHistory] = useState<DocumentRun[]>([])
  const [agentStatus, setAgentStatus] = useState<DocumentAgentStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  const startedHere = useRef(new Set<string>())
  const reported = useRef(new Set<string>())

  useEffect(() => {
    let live = true
    setReady(false)
    setRun(null)
    setDocs([])
    setAgentStatus(null)
    setError('')
    Promise.all([api.documents(projectId), api.documentRuns(projectId), api.documentAgentStatus(projectId)]).then(([documents, runs, status]) => {
      if (!live) return
      setDocs(documents)
      setHistory(runs)
      setRun(runs[0] || null)
      setAgentStatus(status)
      setReady(true)
    }, (cause: Error) => {
      if (!live) return
      setError(cause.message)
      setReady(true)
    })
    return () => { live = false }
  }, [projectId])

  useEffect(() => {
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return
    let live = true
    const timer = window.setInterval(() => {
      api.documentRun(projectId, run.id).then(next => {
        if (live) {
          setRun(next)
          setHistory(previous => previous.map(item => item.id === next.id ? next : item))
        }
      }, (cause: Error) => { if (live) setError(cause.message) })
    }, 2000)
    return () => { live = false; window.clearInterval(timer) }
  }, [projectId, run?.id, run?.status])

  useEffect(() => {
    if (!run || !['completed', 'partial', 'failed'].includes(run.status) || reported.current.has(run.id)) return
    reported.current.add(run.id)
    const changed = run.result.applied.filter(item => !item.reverted_at)
    if (changed.length) void onRulesChanged([...new Set(changed.map(item => item.stage_id))]).catch((cause: Error) => setError(cause.message))
    if (startedHere.current.has(run.id)) {
      toast(run.status === 'failed' ? 'Анализ документов не завершён' : changed.length
        ? `Агент обновил ${changed.length} ${changed.length === 1 ? 'правило техники' : 'правил техники'}. Изменения можно отменить во вкладке «Документы».`
        : 'Анализ завершён. Новых подтверждённых изменений техники нет.', { error: run.status === 'failed' })
    }
  }, [run?.id, run?.status])

  const act = async (task: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try { await task() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось выполнить действие') }
    finally { setBusy(false) }
  }
  const upload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0]
    event.currentTarget.value = ''
    if (!file) return
    void act(async () => {
      const uploaded = await api.uploadDocument(projectId, file, kind)
      setDocs(previous => [uploaded, ...previous])
    })
  }
  const start = () => void act(async () => {
    const created = await api.analyzeDocuments(projectId)
    startedHere.current.add(created.id)
    setRun(created)
    setHistory(previous => [created, ...previous])
  })
  const revert = (selection: DocumentSelection) => {
    if (!run) return
    void act(async () => {
      const result = await api.revertDocumentProposals(projectId, run.id, [selection])
      setRun(result)
      setHistory(previous => previous.map(item => item.id === result.id ? result : item))
      await onRulesChanged([selection.stage_id])
      toast('Правило техники возвращено к прежнему значению')
    })
  }
  const applied = new Set((run?.result.applied || []).filter(item => !item.reverted_at).map(item => key(item.stage_id, item.class_code)))
  const reverted = new Set((run?.result.applied || []).filter(item => !!item.reverted_at).map(item => key(item.stage_id, item.class_code)))
  const automatic = (run?.result.applied || []).filter(item => item.mode === 'automatic')
  const appliedSummary = automatic.map(item => {
    const stage = run?.result.stages.find(row => row.stage_id === item.stage_id)
    const proposal = stage?.proposals.find(row => row.class_code === item.class_code)
    return { item, stage, proposal }
  })
  const hasSource = docs.some(doc => doc.kind === 'POS' || doc.kind === 'PPR')
  const running = run?.status === 'queued' || run?.status === 'running'

  return <div className="doc-panel">
    <h3>Документы проекта и агент техники</h3>
    <p>Загрузите ПОС или ППР. После анализа агент обновит подтверждённые требования к технике и покажет, что изменилось. Любое изменение можно отменить.</p>
    {agentStatus && <div className={`doc-key-status ${agentStatus.configured ? 'is-ready' : 'is-missing'}`} role={agentStatus.configured ? 'status' : 'alert'}>
      <strong>API-ключ агента: {agentStatus.key_configured ? 'указан' : 'не указан'}</strong>
      <span>{agentStatus.configured ? `Модель: ${agentStatus.model}. Ключ хранится на сервере.` : agentStatus.key_configured ? 'Проверьте адрес API и имя модели на сервере.' : 'Добавьте DOCUMENT_LLM_API_KEY или OPENROUTER_API_KEY в конфигурацию API и worker, затем перезапустите сервисы.'}</span>
    </div>}
    <p className="doc-limitation">Анализ документа определяет плановое требование. Текущая CV-модель работает в режиме наблюдения; отсутствие техники по кадрам автоматически не подтверждается.</p>
    {error && <p className="err-line" role="alert">{error}</p>}
    {!ready && <p role="status">Загружаем документы…</p>}
    {canWrite && <div className="doc-upload-row">
      <label>Тип документа <select className="select" value={kind} disabled={busy} onChange={event => setKind(event.target.value as DocumentKind)}>
        <option value="PPR">ППР</option><option value="POS">ПОС</option><option value="TER">ТЕР</option>
      </select></label>
      <label className="btn small">Загрузить файл<input type="file" accept=".pdf,.docx,.xlsx,.txt" hidden disabled={busy} onChange={upload} /></label>
      <small>PDF, DOCX, XLSX, TXT · до 10 МБ. Скану PDF нужен распознанный текст.</small>
    </div>}
    <ul className="doc-list">{docs.map(doc => <li key={doc.id}>
      <span><b>{kindName[doc.kind]}</b> {doc.filename}<small> · {doc.chunk_count} фрагментов</small></span>
      <span><button className="btn small" disabled={busy} onClick={() => void act(() => api.downloadDocument(projectId, doc))}>Скачать</button>
        {canWrite && <button className="btn small ghost" disabled={busy} onClick={() => {
          if (!window.confirm(`Удалить «${doc.filename}»?`)) return
          void act(async () => { await api.deleteDocument(projectId, doc.id); setDocs(previous => previous.filter(item => item.id !== doc.id)) })
        }}>Удалить</button>}</span>
    </li>)}</ul>
    {!docs.length && ready && <p>Документы пока не загружены.</p>}
    <div className="doc-actions">
      {canWrite && <button className="btn small primary" disabled={busy || running || !hasSource || !agentStatus?.configured} onClick={start}>Проанализировать и обновить технику</button>}
      {run && <span role="status">{running ? `Обработано ${run.completed_count} из ${run.stage_count} этапов` : run.status === 'failed' ? 'Анализ не завершён' : `Проверено ${run.completed_count} из ${run.stage_count} этапов`}</span>}
    </div>
    {history.length > 1 && <label className="doc-history">История анализов <select className="select" value={run?.id || ''} onChange={event => {
      const chosen = history.find(item => item.id === event.target.value)
      if (chosen) void act(async () => setRun(await api.documentRun(projectId, chosen.id)))
    }}>{history.map(item => <option key={item.id} value={item.id}>{new Date(item.created_at).toLocaleString('ru-RU')} · {item.status}</option>)}</select></label>}
    {run?.error && <p className="err-line">Ошибка запуска: {run.error}</p>}
    {run && ['completed', 'partial'].includes(run.status) && <div className="doc-change-summary" role="status">
      <strong>{automatic.length ? `Агент изменил ${automatic.length} ${automatic.length === 1 ? 'правило' : 'правил'} техники` : 'Автоматических изменений нет'}</strong>
      {appliedSummary.length > 0 && <ul>{appliedSummary.map(({ item, stage, proposal }) => <li key={key(item.stage_id, item.class_code)}>
        {stage?.stage_name || 'Этап'} · {proposal?.class_name || item.class_code}: {pct(item.previous_probability ?? null)} → {pct(item.new_probability ?? null)}{item.reverted_at ? ' · отменено' : ''}
      </li>)}</ul>}
      {run.result.auto_apply?.skipped.map((item, index) => <p key={`${item.stage_id || 'all'}-${item.class_code || index}`}>
        Не изменено: {item.class_code || 'все этапы'} · {skipReason[item.reason] || item.reason}.
      </p>)}
      {!automatic.length && !run.result.auto_apply?.skipped.length && <p>В документах не найдено новых однозначных требований. Действующие правила сохранены.</p>}
    </div>}
    {run && run.result.stages.map(stage => <section className="doc-stage" key={stage.stage_id}>
      <h4>{stage.stage_name}</h4>
      <p>{stage.summary}</p>
      {stage.trace && <small className="doc-trace">Проверено фрагментов: {stage.reviewed_chunks} · шаги агента: {stage.trace.map(item => item.step).join(' → ')}</small>}
      {stage.status === 'failed' && <p className="err-line">Анализ этапа не завершён. Можно запустить его повторно.</p>}
      {stage.proposals.map(proposal => {
        const id = key(stage.stage_id, proposal.class_code)
        const isApplied = applied.has(id)
        return <div className="doc-proposal" key={id}>
          <div className="doc-proposal-title">
            <strong>{proposal.class_name}</strong>
            <span>{pct(proposal.current_probability)} → {pct(proposal.proposed_probability)}</span>
            <small>{isApplied ? 'Изменено агентом' : reverted.has(id) ? 'Отменено пользователем' : proposal.status === 'conflict' ? 'Противоречивые требования' : proposal.status === 'manual_override' ? 'Сохранена ручная правка' : proposal.status === 'unchanged' ? 'Уже совпадает' : 'Не применено'}</small>
            {isApplied && canWrite && <button className="btn small ghost" disabled={busy} onClick={() => revert({ stage_id: stage.stage_id, class_code: proposal.class_code })}>Отменить</button>}
          </div>
          {proposal.evidence.map(item => <blockquote key={item.chunk_id + item.quote}>
            «{item.quote}»<cite>{kindName[item.document_kind]} · {item.document_name} · {item.locator}{item.mapping_method === 'agent' ? ' · класс предложен агентом, проверьте перед применением' : ''}</cite>
          </blockquote>)}
        </div>
      })}
      {stage.findings.filter(item => item.review_status !== 'cited').map(item => <div className="doc-unmapped" key={item.chunk_id + item.name}>
        <b>{item.name}</b> · {item.review_status === 'unmapped' ? 'нет однозначного класса CV' : item.review_status === 'cv_unsupported' ? 'класс CV пока не поддерживается' : item.review_status === 'mapping_conflict' ? 'неоднозначное сопоставление' : item.review_status === 'requirement_conflict' ? 'вывод агента расходится с цитатой' : 'нет явного требования'}
        <blockquote>«{item.quote}»<cite>{item.document_name} · {item.locator}</cite></blockquote>
      </div>)}
    </section>)}
  </div>
}
