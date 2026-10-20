import { useEffect, useRef, useState } from 'react'
import { pprSourcePage, type PprCitation } from '../pprApi'
import '../ppr.css'

/** Source bytes stay authenticated; only the resulting local blob URL enters the new tab. */
export function PprSourceLink({ projectId, citation, converted = false }: { projectId: string; citation: PprCitation; converted?: boolean }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fallback, setFallback] = useState('')
  const controller = useRef<AbortController | null>(null)
  const sources = useRef(new Set<string>())
  useEffect(() => () => { controller.current?.abort(); for (const url of sources.current) URL.revokeObjectURL(url); sources.current.clear() }, [])
  const openSource = async () => {
    if (busy) return
    const popup = window.open('about:blank', '_blank')
    if (popup) { popup.opener = null; popup.document.title = 'Открываем страницу ППР…' }
    const request = new AbortController()
    controller.current = request
    setBusy(true); setError(''); setFallback('')
    try {
      const blob = await pprSourcePage(projectId, citation.document_id, citation.page_number, request.signal, citation.source_url, citation.analysis_id)
      if (request.signal.aborted) { popup?.close(); return }
      const url = URL.createObjectURL(blob)
      sources.current.add(url)
      if (popup && !popup.closed) popup.location.replace(url)
      else setFallback(url)
      // The browser receives the full single-page source before the temporary URL expires.
      window.setTimeout(() => { URL.revokeObjectURL(url); sources.current.delete(url) }, 300_000)
    } catch (reason) {
      popup?.close()
      if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : 'Не удалось открыть источник ППР.')
    } finally { if (!request.signal.aborted) setBusy(false) }
  }
  return <span className="ppr-source-link"><button type="button" className="link" disabled={busy} onClick={() => void openSource()}>{busy ? 'Открываем источник…' : `Страница ${citation.page_number}${converted ? ' PDF-представления' : ''} ↗`}</button>{fallback && <a href={fallback} target="_blank" rel="noopener noreferrer">Открыть страницу в новой вкладке ↗</a>}{error && <span className="ppr-error" role="alert">{error}</span>}</span>
}

export function PprCitations({ projectId, citations }: { projectId: string; citations: PprCitation[] }) {
  if (!citations.length) return null
  return <div className="ppr-citations">{citations.map((citation, index) => <article key={`${citation.document_id}-${citation.page_number}-${index}`}><strong>{citation.title || citation.filename || 'Требование ППР'}</strong>{citation.quote && <blockquote>{citation.quote}</blockquote>}<PprSourceLink projectId={projectId} citation={citation} converted={!!citation.filename?.toLowerCase().endsWith('.docx')} /><small>Источник требования{citation.document_sha256 ? ` · SHA256 ${citation.document_sha256.slice(0, 12)}…` : ''}</small></article>)}</div>
}
