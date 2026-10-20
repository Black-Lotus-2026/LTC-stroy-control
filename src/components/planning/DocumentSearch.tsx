import { useEffect, useRef, useState } from 'react'
import {
  deleteProjectDocument, downloadProjectDocument, fetchDocumentAgentStatus,
  fetchDocumentPlanRun, fetchLatestDocumentPlanRun, fetchProjectDocuments,
  revertDocumentPlanRule, startDocumentPlanRun, uploadProjectDocument,
  type DocumentAgentStatus, type DocumentKind, type DocumentPlanRun, type ProjectDocumentItem,
} from '../../api/stroyControlApi'

const KIND_LABELS: Record<DocumentKind, string> = { POS: 'ПОС', PPR: 'ППР', TER: 'ТЕР' }
const pct = (value: number | null) => value == null ? 'нет оценки' : `${Math.round(value * 100)}%`
const ruleKey = (stageId: string, code: string) => `${stageId}:${code}`

export function DocumentSearch({ projectId, stageId, stageName, toast }: {
  projectId: string
  stageId: string
  stageName: string
  toast: (message: string) => void
}) {
  const [documents, setDocuments] = useState<ProjectDocumentItem[]>([])
  const [kind, setKind] = useState<DocumentKind>('PPR')
  const [run, setRun] = useState<DocumentPlanRun | null>(null)
  const [agentStatus, setAgentStatus] = useState<DocumentAgentStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const startedHere = useRef(new Set<string>())
  const announced = useRef(new Set<string>())

  useEffect(() => {
    let cancelled = false
    setDocuments([])
    setRun(null)
    setAgentStatus(null)
    setError('')
    void Promise.all([
      fetchProjectDocuments(projectId),
      fetchLatestDocumentPlanRun(projectId),
      fetchDocumentAgentStatus(projectId),
    ]).then(([items, latest, status]) => {
      if (cancelled) return
      setDocuments(items)
      setRun(latest)
      setAgentStatus(status)
    }).catch(cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить документы')
    })
    return () => { cancelled = true }
  }, [projectId])

  useEffect(() => {
    if (!run || (run.status !== 'queued' && run.status !== 'running')) return
    let live = true
    const timer = window.setInterval(() => {
      void fetchDocumentPlanRun(projectId, run.id).then(result => {
        if (live) setRun(result)
      }).catch(cause => { if (live) setError(cause instanceof Error ? cause.message : 'Не удалось получить результат') })
    }, 2000)
    return () => { live = false; window.clearInterval(timer) }
  }, [projectId, run?.id, run?.status])

  useEffect(() => {
    if (!run || !['completed', 'partial', 'failed'].includes(run.status) || !startedHere.current.has(run.id) || announced.current.has(run.id)) return
    announced.current.add(run.id)
    const count = run.result.applied.filter(item => item.mode === 'automatic' && !item.reverted_at).length
    toast(run.status === 'failed' ? 'Анализ документов не завершён' : count
      ? `Агент изменил ${count} правил техники. Изменения можно отменить.`
      : 'Анализ завершён. Новых подтверждённых изменений нет.')
  }, [run?.id, run?.status])

  const act = async (action: () => Promise<void>) => {
    setBusy(true)
    setError('')
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Не удалось выполнить действие') }
    finally { setBusy(false) }
  }

  const upload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return
    void act(async () => {
      const item = await uploadProjectDocument(projectId, file, kind)
      setDocuments(previous => [item, ...previous])
      toast(`${KIND_LABELS[kind]} загружен: ${item.filename}`)
    }).finally(() => { input.value = '' })
  }

  const remove = (item: ProjectDocumentItem) => {
    if (!window.confirm(`Удалить документ «${item.filename}»?`)) return
    void act(async () => {
      await deleteProjectDocument(projectId, item.id)
      setDocuments(previous => previous.filter(doc => doc.id !== item.id))
      toast('Документ удалён')
    })
  }

  const analyze = () => void act(async () => {
    const created = await startDocumentPlanRun(projectId)
    startedHere.current.add(created.id)
    setRun(created)
  })

  const revert = (code: string) => {
    if (!run) return
    void act(async () => {
      setRun(await revertDocumentPlanRule(projectId, run.id, stageId, code))
      toast('Правило техники возвращено к прежнему значению')
    })
  }

  const current = run?.result.stages.find(item => item.stage_id === stageId)
  const applied = new Set((run?.result.applied || []).filter(item => !item.reverted_at).map(item => ruleKey(item.stage_id, item.class_code)))
  const reverted = new Set((run?.result.applied || []).filter(item => !!item.reverted_at).map(item => ruleKey(item.stage_id, item.class_code)))
  const running = run?.status === 'queued' || run?.status === 'running'
  const hasSource = documents.some(item => item.kind === 'POS' || item.kind === 'PPR')

  return <section className="document-search" aria-label="Документы и техника этапа">
    <div className="document-search-heading">
      <div><h4>Техника по документам</h4><p>Агент анализирует этапы графика по ПОС/ППР и автоматически обновляет подтверждённые требования. Ниже показаны изменения для «{stageName}».</p></div>
      <button className="button primary" type="button" disabled={busy || running || !hasSource || !agentStatus?.configured} onClick={analyze}>Проанализировать и обновить</button>
    </div>
    {agentStatus && <p className={agentStatus.configured ? 'document-muted' : 'planning-error'} role={agentStatus.configured ? 'status' : 'alert'}>
      API-ключ агента: {agentStatus.key_configured ? 'указан' : 'не указан'}. {agentStatus.configured ? `Модель: ${agentStatus.model}.` : agentStatus.key_configured ? 'Проверьте адрес API и имя модели в конфигурации сервера.' : 'Добавьте ключ в конфигурацию API и worker и перезапустите сервисы.'}
    </p>}
    <div className="document-upload-row">
      <label>Тип документа <select value={kind} disabled={busy} onChange={event => setKind(event.target.value as DocumentKind)}>
        <option value="POS">ПОС</option><option value="PPR">ППР</option><option value="TER">ТЕР</option>
      </select></label>
      <label className={`button document-upload${busy ? ' planning-disabled' : ''}`}>Загрузить документ
        <input type="file" accept=".pdf,.docx,.xlsx,.txt" disabled={busy} onChange={upload} aria-label="Загрузить ПОС, ППР или ТЕР" />
      </label>
      <span>PDF, DOCX, XLSX, TXT · до 10 МБ</span>
    </div>
    {error && <p className="planning-error" role="alert">{error}</p>}
    {run && <p className="planning-feedback" role="status">{running ? `Обработано ${run.completed_count} из ${run.stage_count} этапов` : run.status === 'failed' ? 'Анализ не завершён' : `Проверено ${run.completed_count} из ${run.stage_count} этапов`}</p>}
    {run?.error && <p className="planning-error">Ошибка анализа: {run.error}</p>}
    {documents.length ? <ul className="document-list">{documents.map(item => <li key={item.id}>
      <span><strong>{KIND_LABELS[item.kind]}</strong> {item.filename} <small>· {item.chunk_count} фрагментов</small></span>
      <span className="document-list-actions"><button className="button" disabled={busy} onClick={() => void act(() => downloadProjectDocument(projectId, item))}>Скачать</button><button className="button" disabled={busy} onClick={() => remove(item)}>Удалить</button></span>
    </li>)}</ul> : <p className="document-muted">Документы для объекта ещё не загружены.</p>}
    {current && <div className="document-analysis">
      <p>{current.summary}</p>
      {current.proposals.length ? <ul>{current.proposals.map(proposal => {
        const id = ruleKey(stageId, proposal.class_code)
        const isApplied = applied.has(id)
        return <li key={id}>
          <strong>{proposal.class_name}</strong> · {pct(proposal.current_probability)} → {pct(proposal.proposed_probability)} · {isApplied ? 'изменено агентом' : reverted.has(id) ? 'отменено' : proposal.status === 'manual_override' ? 'сохранена ручная правка' : proposal.status === 'conflict' ? 'спорное требование' : 'без изменения'}
          {isApplied && <button className="button document-source" disabled={busy} onClick={() => revert(proposal.class_code)}>Вернуть прежнее</button>}
          {proposal.evidence.map(item => <blockquote key={`${item.chunk_id}-${item.quote}`}>«{item.quote}» <small>{item.document_name} · {item.locator}</small></blockquote>)}
        </li>
      })}</ul> : <p className="document-muted">Подтверждённых изменений техники для этого этапа нет.</p>}
    </div>}
  </section>
}
