import { useEffect, useState } from 'react'
import {
  analyzeProjectDocuments, deleteProjectDocument, downloadProjectDocument,
  fetchProjectDocuments, uploadProjectDocument,
  type DocumentAnalysis, type DocumentKind, type ProjectDocumentItem,
} from '../../api/stroyControlApi'

const KIND_LABELS: Record<DocumentKind, string> = { POS: 'ПОС', PPR: 'ППР', TER: 'ТЕР' }

export function DocumentSearch({ projectId, stageId, stageName, toast }: {
  projectId: string
  stageId: string
  stageName: string
  toast: (message: string) => void
}) {
  const [documents, setDocuments] = useState<ProjectDocumentItem[]>([])
  const [kind, setKind] = useState<DocumentKind>('POS')
  const [analysis, setAnalysis] = useState<DocumentAnalysis | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setDocuments([])
    setAnalysis(null)
    setError('')
    void fetchProjectDocuments(projectId).then(items => {
      if (!cancelled) setDocuments(items)
    }).catch(cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : 'Не удалось загрузить документы')
    })
    return () => { cancelled = true }
  }, [projectId])

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
      setAnalysis(null)
      toast(`${KIND_LABELS[kind]} загружен: ${item.filename}`)
    }).finally(() => { input.value = '' })
  }

  const remove = (item: ProjectDocumentItem) => {
    if (!window.confirm(`Удалить документ «${item.filename}»?`)) return
    void act(async () => {
      await deleteProjectDocument(projectId, item.id)
      setDocuments(previous => previous.filter(doc => doc.id !== item.id))
      setAnalysis(null)
      toast('Документ удалён')
    })
  }

  const download = (item: ProjectDocumentItem) => {
    void act(() => downloadProjectDocument(projectId, item))
  }

  const analyze = () => {
    void act(async () => {
      const result = await analyzeProjectDocuments(projectId, stageId)
      setAnalysis(result)
    })
  }

  const currentAnalysis = analysis?.stage_id === stageId ? analysis : null

  return <section className="document-search" aria-label="Документы и техника этапа">
    <div className="document-search-heading">
      <div><h4>Техника по документам</h4><p>ПОС, ППР и ТЕР объекта. Агент ищет сведения для этапа «{stageName}» и показывает проверяемые цитаты.</p></div>
      <button className="button primary" type="button" disabled={busy || !documents.length} onClick={analyze}>Найти технику</button>
    </div>
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
    {busy && <p className="planning-feedback" role="status">Обрабатываем запрос…</p>}
    {documents.length ? <ul className="document-list">{documents.map(item => <li key={item.id}>
      <span><strong>{KIND_LABELS[item.kind]}</strong> {item.filename} <small>· {item.chunk_count} фрагментов</small></span>
      <span className="document-list-actions"><button className="button" disabled={busy} onClick={() => download(item)}>Скачать</button><button className="button" disabled={busy} onClick={() => remove(item)}>Удалить</button></span>
    </li>)}</ul> : <p className="document-muted">Документы для объекта ещё не загружены.</p>}
    {currentAnalysis && <div className="document-analysis">
      <p>{currentAnalysis.summary || (currentAnalysis.items.length ? 'Найдена техника с подтверждением в документах.' : 'Подтверждённая техника не найдена.')}</p>
      <p className="document-muted">Проверено фрагментов: {currentAnalysis.reviewed_chunks}; документов: {currentAnalysis.document_count}.</p>
      {currentAnalysis.items.length ? <ul>{currentAnalysis.items.map((item, index) => <li key={`${item.chunk_id}-${index}`}>
        <strong>{item.name}</strong>{item.purpose && <span> — {item.purpose}</span>}
        <blockquote>«{item.quote}»</blockquote>
            <small>{KIND_LABELS[item.document_kind]} · {item.document_name} · {item.locator}</small>
            <button className="button document-source" disabled={busy} onClick={() => {
              const source = documents.find(doc => doc.id === item.document_id)
              if (source) download(source)
            }}>Скачать источник</button>
      </li>)}</ul> : null}
    </div>}
  </section>
}
