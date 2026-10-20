import { useEffect, useState } from 'react'
import * as api from '../api'
import type { DocumentKind, DocumentRun, DocumentSelection, ProjectDocument } from '../api'

const kindName: Record<DocumentKind, string> = { POS: 'ПОС', PPR: 'ППР', TER: 'ТЕР' }
const key = (stageId: string, code: string) => `${stageId}:${code}`
const pct = (value: number | null) => value == null ? 'нет оценки' : `${Math.round(value * 100)}%`

export function DocumentsPanel({ projectId, canWrite, onRulesChanged }: {
  projectId: string
  canWrite: boolean
  onRulesChanged: (stageIds: string[]) => Promise<void>
}) {
  const [docs, setDocs] = useState<ProjectDocument[]>([])
  const [kind, setKind] = useState<DocumentKind>('PPR')
  const [run, setRun] = useState<DocumentRun | null>(null)
  const [history, setHistory] = useState<DocumentRun[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let live = true
    setReady(false)
    setRun(null)
    setDocs([])
    setError('')
    Promise.all([api.documents(projectId), api.documentRuns(projectId)]).then(([documents, runs]) => {
      if (!live) return
      setDocs(documents)
      setHistory(runs)
      setRun(runs[0] || null)
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
    if (!run || (run.status !== 'completed' && run.status !== 'partial')) return
    const applied = new Set(run.result.applied.filter(item => !item.reverted_at).map(item => key(item.stage_id, item.class_code)))
    setSelected(run.result.stages.flatMap(stage => stage.proposals
      .filter(proposal => proposal.status === 'ready' && !applied.has(key(stage.stage_id, proposal.class_code)))
      .map(proposal => key(stage.stage_id, proposal.class_code))))
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
    setSelected([])
    const created = await api.analyzeDocuments(projectId)
    setRun(created)
    setHistory(previous => [created, ...previous])
  })
  const apply = () => {
    if (!run || !selected.length) return
    const selections: DocumentSelection[] = selected.map(value => {
      const split = value.indexOf(':')
      return { stage_id: value.slice(0, split), class_code: value.slice(split + 1) }
    })
    void act(async () => {
      const result = await api.applyDocumentProposals(projectId, run.id, selections)
      setRun(result)
      setHistory(previous => previous.map(item => item.id === result.id ? result : item))
      setSelected([])
      await onRulesChanged([...new Set(selections.map(item => item.stage_id))])
    })
  }
  const revert = (selection: DocumentSelection) => {
    if (!run) return
    void act(async () => {
      const result = await api.revertDocumentProposals(projectId, run.id, [selection])
      setRun(result)
      setHistory(previous => previous.map(item => item.id === result.id ? result : item))
      await onRulesChanged([selection.stage_id])
    })
  }
  const applied = new Set((run?.result.applied || []).filter(item => !item.reverted_at).map(item => key(item.stage_id, item.class_code)))
  const hasSource = docs.some(doc => doc.kind === 'POS' || doc.kind === 'PPR')
  const running = run?.status === 'queued' || run?.status === 'running'

  return <div className="doc-panel">
    <h3>Документы проекта и агент техники</h3>
    <p>Загрузите ПОС или ППР. Агент через внешний API сопоставит их с этапами графика и покажет цитаты перед изменением правил.</p>
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
      {canWrite && <button className="btn small primary" disabled={busy || running || !hasSource} onClick={start}>Проанализировать этапы</button>}
      {run && <span role="status">{running ? `Обработано ${run.completed_count} из ${run.stage_count} этапов` : run.status === 'failed' ? 'Анализ не завершён' : `Проверено ${run.completed_count} из ${run.stage_count} этапов`}</span>}
    </div>
    {history.length > 1 && <label className="doc-history">История анализов <select className="select" value={run?.id || ''} onChange={event => {
      const chosen = history.find(item => item.id === event.target.value)
      if (chosen) void act(async () => setRun(await api.documentRun(projectId, chosen.id)))
    }}>{history.map(item => <option key={item.id} value={item.id}>{new Date(item.created_at).toLocaleString('ru-RU')} · {item.status}</option>)}</select></label>}
    {run?.error && <p className="err-line">Ошибка запуска: {run.error}</p>}
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
            {proposal.status === 'ready' && !isApplied && canWrite && <input type="checkbox" aria-label={`Применить ${proposal.class_name} для этапа ${stage.stage_name}`} checked={selected.includes(id)} disabled={busy} onChange={event => setSelected(previous => event.target.checked ? [...previous, id] : previous.filter(value => value !== id))} />}
            <strong>{proposal.class_name}</strong>
            <span>{pct(proposal.current_probability)} → {pct(proposal.proposed_probability)}</span>
            <small>{isApplied ? 'Применено' : proposal.status === 'conflict' ? 'Противоречивые требования' : proposal.status === 'manual_override' ? 'Сохранена ручная правка' : proposal.status === 'unchanged' ? 'Уже совпадает' : 'Предложение'}</small>
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
    {canWrite && run && selected.length > 0 && <div className="doc-apply"><button className="btn small primary" disabled={busy || running} onClick={apply}>Применить выбранные ({selected.length})</button></div>}
  </div>
}
