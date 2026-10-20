import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
async function moduleUrl(path, replacements = {}) {
  if (path.endsWith('/sverka/model.ts') || path.endsWith('/sverka/engine.ts')) replacements = { './lib/view': await moduleUrl('../src/sverka/lib/view.ts'), './lib/loop': await moduleUrl('../src/sverka/lib/loop.ts'), ...replacements }
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React } }).outputText
  for (const [from, to] of Object.entries(replacements)) code = code.replaceAll(`'${from}'`, `'${to}'`).replaceAll(`"${from}"`, `"${to}"`)
  return dataUrl(code)
}
const credentials = dataUrl('export const API_PREFIX="/api/v1"; export const API_BASE_URL=""; export const getStoredToken=()=>"ppr-private-token"; export const getAuthHeaders=()=>({Authorization:"Bearer ppr-private-token"}); export const setStoredToken=()=>{}')
const apiUrl = await moduleUrl('../src/sverka/api.ts', { '../api/stroyControlApi': credentials })
const ppr = await import(await moduleUrl('../src/sverka/pprApi.ts', { '../api/stroyControlApi': credentials, './api': apiUrl }))
const project = 'object /?jury'
const documentId = 'document /?source'
const base = `/api/v1/projects/${encodeURIComponent(project)}/ppr-documents`

test('PPR file validation accepts advertised formats and boundary size, rejects empty, unsupported and oversized files', () => {
  for (const name of ['ППР.PDF', 'работы.docx', 'Схема.JpG', 'скан.jpeg', 'лист.png']) {
    assert.equal(ppr.validatePprFile({ name, size: ppr.MAX_PPR_BYTES }), null)
  }
  assert.match(ppr.validatePprFile({ name: 'ппр.pdf', size: 0 }), /пуст/)
  assert.match(ppr.validatePprFile({ name: 'ппр.pdf', size: ppr.MAX_PPR_BYTES + 1 }), /50 МБ/)
  for (const name of ['ппр.doc', 'ппр.pdf.exe', 'ппр', 'ппр.xlsx']) assert.match(ppr.validatePprFile({ name, size: 10 }), /PDF, DOCX, JPG или PNG/)
})

test('PPR list, detail and original use encoded object/document paths and header authentication without URL secrets', async context => {
  const previous = globalThis.fetch
  context.after(() => { globalThis.fetch = previous })
  const signal = new AbortController().signal
  const calls = []
  const originalBytes = Uint8Array.from([0, 1, 255, 42])
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return url.endsWith('/original') ? new Response(originalBytes, { headers: { 'Content-Type': 'application/pdf' } }) : Response.json(url === base ? [] : { id: documentId })
  }
  assert.deepEqual(await ppr.listPprDocuments(project, signal), [])
  assert.equal((await ppr.readPprDocument(project, documentId, signal)).id, documentId)
  const blob = await ppr.pprOriginal(project, documentId, signal)
  assert.equal(blob.type, 'application/pdf')
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), originalBytes)
  assert.deepEqual(calls.map(call => call.url), [base, `${base}/${encodeURIComponent(documentId)}`, `${base}/${encodeURIComponent(documentId)}/original`])
  for (const { url, init } of calls) {
    assert.equal(init.headers.Authorization, 'Bearer ppr-private-token')
    assert.equal(init.signal, signal)
    assert.equal(url.includes('ppr-private-token'), false)
  }
})

test('missing or inaccessible originals produce actionable errors without returning error bodies as files', async context => {
  const previous = globalThis.fetch
  context.after(() => { globalThis.fetch = previous })
  globalThis.fetch = async () => Response.json({ detail: 'missing' }, { status: 404 })
  await assert.rejects(ppr.pprOriginal(project, documentId), /Оригинал не найден/)
  globalThis.fetch = async () => new Response('forbidden', { status: 403 })
  await assert.rejects(ppr.pprOriginal(project, documentId), /Не удалось получить оригинал/)
})

function installXHR(context) {
  const previous = globalThis.XMLHttpRequest
  const requests = []
  class FakeXHR {
    upload = {}
    headers = {}
    aborted = false
    constructor() { requests.push(this) }
    open(method, url) { this.method = method; this.url = url }
    setRequestHeader(key, value) { this.headers[key] = value }
    send(body) { this.body = body }
    abort() { this.aborted = true; this.onabort?.() }
    respond(status, body) { this.status = status; this.responseText = typeof body === 'string' ? body : JSON.stringify(body); this.onload() }
  }
  globalThis.XMLHttpRequest = FakeXHR
  context.after(() => { if (previous === undefined) delete globalThis.XMLHttpRequest; else globalThis.XMLHttpRequest = previous })
  return requests
}

test('PPR upload sends multipart original with authorization and accepts the server existing-document response', async context => {
  const requests = installXHR(context)
  const controller = new AbortController()
  const progress = []
  const file = new Blob(['original document'], { type: 'application/pdf' })
  const result = ppr.uploadPprDocument(project, file, controller.signal, percent => progress.push(percent))
  const xhr = requests[0]
  assert.equal(xhr.method, 'POST')
  assert.equal(xhr.url, base)
  assert.equal(xhr.url.includes('ppr-private-token'), false)
  assert.equal(xhr.headers.Authorization, 'Bearer ppr-private-token')
  assert.match(xhr.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/)
  assert.equal(await xhr.body.get('file').text(), 'original document')
  xhr.upload.onprogress({ lengthComputable: false, loaded: 1, total: 0 })
  xhr.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 })
  xhr.upload.onprogress({ lengthComputable: true, loaded: 110, total: 100 })
  assert.deepEqual(progress, [50, 100])
  const existing = { id: documentId, filename: 'ППР.pdf', sha256: 'same-original', project_id: project }
  xhr.respond(200, existing)
  assert.deepEqual(await result, existing)
  controller.abort()
  assert.equal(xhr.aborted, false, 'finished upload must remove its abort listener')
})

test('PPR upload reports server validation, malformed success and network failures', async context => {
  const requests = installXHR(context)
  const file = new Blob(['original'])
  const start = () => ppr.uploadPprDocument(project, file, new AbortController().signal, () => {})
  const invalid = start()
  requests.at(-1).respond(422, { detail: 'PDF защищён паролем' })
  await assert.rejects(invalid, /PDF защищён паролем/)
  const malformed = start()
  requests.at(-1).respond(200, '<html>proxy response</html>')
  await assert.rejects(malformed, /Не удалось сохранить документ/)
  const network = start()
  requests.at(-1).onerror()
  await assert.rejects(network, /Соединение прервано.*не подтверждён сервером/)
})

test('PPR upload cancellation aborts in-flight XHR and never sends a pre-cancelled request', async context => {
  const requests = installXHR(context)
  const file = new Blob(['original'])
  const controller = new AbortController()
  const pending = ppr.uploadPprDocument(project, file, controller.signal, () => {})
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  assert.equal(requests[0].aborted, true)
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  await assert.rejects(ppr.uploadPprDocument(project, file, alreadyAborted.signal, () => {}), error => error.name === 'AbortError')
  assert.equal(requests[1].body, undefined)
})

test('AI analysis distinguishes absent analysis from provider failure and preserves retry status and exact-page source bytes', async context => {
  const previous = globalThis.fetch
  context.after(() => { globalThis.fetch = previous })
  const calls = []
  const analysis = { id: 'analysis', status: 'PENDING', pages_total: 0, pages_processed: 0, requirements: [] }
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    if (url.endsWith('/analysis')) return Response.json({ detail: 'not analyzed' }, { status: 404 })
    if (url.endsWith('/analyze')) return Response.json(analysis, { status: 202 })
    return new Response('exact-page-source', { headers: { 'Content-Type': 'application/pdf' } })
  }
  assert.equal(await ppr.readPprAnalysis(project, documentId), null)
  assert.deepEqual(await ppr.analyzePprDocument(project, documentId), analysis)
  assert.equal(calls[1].init.method, 'POST')
  const source = await ppr.pprSourcePage(project, documentId, 17)
  assert.equal(await source.text(), 'exact-page-source')
  assert.equal(calls[2].url, `${base}/${encodeURIComponent(documentId)}/pages/17/original`)
  for (const { url, init } of calls) {
    assert.equal(init.headers.Authorization, 'Bearer ppr-private-token')
    assert.equal(url.includes('ppr-private-token'), false)
  }
  await assert.rejects(ppr.pprSourcePage(project, documentId, 0), /Номер страницы/)
  await assert.rejects(ppr.pprSourcePage(project, documentId, 1.5), /Номер страницы/)
  assert.equal(calls.length, 3)
  globalThis.fetch = async () => Response.json({ detail: 'provider offline' }, { status: 503 })
  await assert.rejects(ppr.readPprAnalysis(project, documentId), /provider offline/)
  await assert.rejects(ppr.analyzePprDocument(project, documentId), /provider offline/)
})

test('manual PPR activation sends explicit applicability, stage identity and human confirmation; server denial never fabricates activation', async context => {
  const previous = globalThis.fetch
  context.after(() => { globalThis.fetch = previous })
  let request
  const body = { active: true, applicability: 'stage', stage_id: 'owned-stage', human_confirmed: true }
  globalThis.fetch = async (url, init) => { request = { url, init }; return Response.json({ id: 'requirement', ...body }) }
  const saved = await ppr.activatePprRequirement(project, documentId, 'rule /1', body)
  assert.equal(saved.active, true)
  assert.equal(request.url, `${base}/${encodeURIComponent(documentId)}/requirements/rule%20%2F1`)
  assert.equal(request.init.method, 'PATCH')
  assert.deepEqual(JSON.parse(request.init.body), body)
  assert.equal(request.init.headers.Authorization, 'Bearer ppr-private-token')
  globalThis.fetch = async () => Response.json({ detail: 'Требование не поддерживается моделью' }, { status: 422 })
  await assert.rejects(ppr.activatePprRequirement(project, documentId, 'rule', body), /не поддерживается/)
})

test('assigned event viewers use the restricted citation route and never send bearer credentials to external source URLs', async context => {
  const previous = globalThis.fetch
  context.after(() => { globalThis.fetch = previous })
  const requests = []
  globalThis.fetch = async (url, init) => { requests.push({ url, init }); return new Response('cited-page') }
  for (const source of ['/api/v1/incidents/incident-id/ppr-sources/requirement-id', '/api/v1/safety/events/event-id/ppr-sources/requirement-id']) {
    assert.equal(await (await ppr.pprSourcePage('private-project', 'private-document', 5, undefined, source)).text(), 'cited-page')
    assert.equal(requests.at(-1).url, source)
    assert.equal(requests.at(-1).init.headers.Authorization, 'Bearer ppr-private-token')
  }
  const count = requests.length
  for (const source of ['https://evil.example/api/v1/incidents/id/ppr-sources/rule', '//evil.example/api/v1/incidents/id/ppr-sources/rule', '/api/v1/incidents/id/ppr-sources/rule?token=secret', '/api/v1/projects/other/ppr-documents/other/pages/5/original', '/api/v1/incidents/../ppr-sources/rule']) {
    await assert.rejects(ppr.pprSourcePage('private-project', 'private-document', 5, undefined, source), /недопустима/)
  }
  assert.equal(requests.length, count)
})

const machineryUrl = await moduleUrl('../src/sverka/lib/machinery.tsx')
const formatUrl = await moduleUrl('../src/sverka/lib/format.ts')
const model = await import(await moduleUrl('../src/sverka/model.ts', { './lib/machinery': machineryUrl, './lib/format': formatUrl }))

test('PPR profiles ignore stale browser overrides and preserve citation identity, revision and neutral conflict behavior', () => {
  const citation = { requirement_id: 'rule', document_id: 'source', page_number: 8, document_sha256: 'sha', rule_activated_at: '2026-10-20T11:00:00Z' }
  const profile = model.toProfile({ stage_id: 'stage', ppr_revision: 'current-revision', probabilities: [{ machinery_code: 'excavator', classification: 'MANDATORY', probability: 1, basis: 'ppr', ppr_requirements: [citation] }, { machinery_code: 'dump_truck', classification: 'NEUTRAL', probability: .5, basis: 'ppr_conflict', ppr_requirements: [citation] }] }, model.DEFAULTS, { excavator: { base: 'no', skip: true, warnAfter: 999, errAfter: 9999, at: 1 } })
  assert.equal(profile.rules.excavator.lvl, 'req')
  assert.equal(profile.rules.excavator.edited, false)
  assert.equal(profile.rules.excavator.warnAfter, model.DEFAULTS.warnAfter)
  assert.equal(profile.rules.excavator.ownTiming, false)
  assert.deepEqual(profile.rules.excavator.pprRequirements, [citation])
  assert.equal(profile.rules.dump_truck.lvl, 'ok')
  assert.equal(profile.rules.dump_truck.basis, 'ppr_conflict')
  assert.equal(profile.pprRevision, 'current-revision')
  assert.equal(profile.edited, false)
})

test('historical incidents keep saved PPR citations; source fingerprints separate activation versions and ignore citation order', () => {
  const citation = { requirement_id: 'rule', document_id: 'doc', page_number: 3, document_sha256: 'sha', rule_activated_at: '2026-10-20T11:00:00Z', quote: 'Обязателен экскаватор' }
  const wire = { id: 'event', code: 'INC-1', project_id: 'object', created_at: '2026-10-20T11:00:00Z', severity: 'WARNING', discrepancy_type: 'MISSING_MANDATORY', ppr_requirements: [citation] }
  const event = model.toEvent(wire, value => value)
  assert.equal(event.projectId, 'object')
  assert.deepEqual(event.pprRequirements, [citation])
  assert.notEqual(ppr.pprCitationFingerprint([citation]), ppr.pprCitationFingerprint([]))
  assert.notEqual(ppr.pprCitationFingerprint([citation]), ppr.pprCitationFingerprint([{ ...citation, rule_activated_at: '2026-10-20T12:00:00Z' }]))
  const other = { ...citation, requirement_id: 'second', page_number: 4 }
  assert.equal(ppr.pprCitationFingerprint([citation, other]), ppr.pprCitationFingerprint([other, citation]))
})

test('PPR revision resets engine coverage synchronously while preserving sources and rejecting frames started before activation', async context => {
  const previous = Object.fromEntries(['document', 'window', 'HTMLImageElement', 'HTMLVideoElement'].map(key => [key, globalThis[key]]))
  context.after(() => Object.assign(globalThis, previous))
  globalThis.HTMLImageElement = class { naturalWidth = 800; naturalHeight = 600 }
  globalThis.HTMLVideoElement = class {}
  let pendingCapture
  globalThis.window = { setTimeout: () => 1 }
  globalThis.document = { createElement: () => ({ toBlob: callback => { pendingCapture = callback }, toDataURL: () => 'data:image/jpeg;base64,frame', getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) }) }) }) }
  const semanticsUrl = await moduleUrl('../src/domain/constructionObservations.ts')
  const apiMock = dataUrl('export const detectFrame=async()=>({model_ready:true,compliance_enabled:true,evaluable_classes:["excavator"],detections:[{raw_label:"excavator",confidence:.9,x1:0,y1:0,x2:.5,y2:.5}]});')
  const { Engine } = await import(await moduleUrl('../src/sverka/engine.ts', { './api': apiMock, './lib/machinery': machineryUrl, '../domain/constructionObservations': semanticsUrl }))
  const engine = new Engine()
  const source = { view: { id: 'camera', kind: 'camera', n: 1, status: 'live', dets: [] }, el: new HTMLImageElement(), inFlight: false }
  engine.rts.set('camera', source)
  engine.dets.set('excavator', [{ at: 1000, src: 'camera', c: .9 }])
  engine.cov = [[1000, 2000]]
  engine.frames = 1
  let notification
  engine.subscribe(() => { notification = { coverage: engine.snapshot().coverage(), frames: engine.frames } })
  engine.capture(source)
  engine.resetEvaluationWindow()
  assert.deepEqual(notification, { coverage: [], frames: 0 })
  assert.equal(engine.rts.get('camera'), source)
  assert.equal(engine.dets.size, 0)
  pendingCapture(new Blob(['pre-activation frame']))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(engine.frames, 0)
  assert.equal(engine.dets.size, 0)
})
