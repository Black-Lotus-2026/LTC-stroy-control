import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
async function moduleUrl(path, replacements = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  let code = ts.transpileModule(source, { fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  for (const [from, to] of Object.entries(replacements)) code = code.replaceAll(`'${from}'`, `'${to}'`).replaceAll(`"${from}"`, `"${to}"`)
  return dataUrl(code)
}
const uid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const credentialsUrl = dataUrl(`let assignment='${uid(1)}'; export const API_PREFIX='/api/v1';export const API_BASE_URL='';export const getStoredToken=()=> 'synthetic-token';export const setStoredToken=()=>{};export const setAssignment=(value)=>{assignment=value};export const getAuthHeaders=()=>({'Authorization':'Bearer synthetic-token','X-Project-Assignment':assignment});`)
const credentials = await import(credentialsUrl)
const apiUrl = await moduleUrl('../src/sverka/api.ts', { '../api/stroyControlApi': credentialsUrl })
const schemasUrl = await moduleUrl('../src/api/generated/customerControl.ts')
const customer = await import(await moduleUrl('../src/sverka/customerApi.ts', { '../api/stroyControlApi': credentialsUrl, './api': apiUrl, '../api/generated/customerControl': schemasUrl }))
const context = { organization_id: uid(2), membership_id: uid(3), project_id: uid(4), participation_id: uid(5), assignment_id: uid(1), organization_name: 'Тестовый заказчик', project_name: 'Изолированный объект', role: 'customer_manager', side: 'customer', scope: { kind: 'project' }, authorization_version: 1, effective_permissions: ['incident.read'], is_demo: false, lifecycle: 'active' }
const incident = { id: uid(6), project_id: uid(4), code: 'QA-1', title: 'Тестовое дело', case_kind: 'construction', status: 'confirmed', row_version: 2, area_id: uid(7), responsible_participation_id: uid(5), assignee_assignment_id: uid(1), detected_at: null, first_seen_at: '2026-10-20T12:00:00Z', reaction_due_at: null, remediation_due_at: null, review_due_at: null, resolution_origin: null, verification_status: 'passed', allowed_actions: ['incident.start'], view: 'customer', origin_participation_id: uid(5), basis: null }

test('context transport rejects undeclared permissions, roles, missing scope and malformed list rather than trusting casts', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous })
  globalThis.fetch = async () => Response.json([context])
  assert.deepEqual(await customer.contexts(), [context])
  for (const invalid of [{ ...context, role: 'admin' }, { ...context, effective_permissions: ['all'] }, { ...context, scope: { kind: 'areas', area_ids: [] } }, { ...context, authorization_version: 0 }]) {
    globalThis.fetch = async () => Response.json([invalid])
    await assert.rejects(customer.contexts(), /Неверный ответ API/)
  }
  globalThis.fetch = async () => Response.json({ contexts: [] })
  await assert.rejects(customer.contexts(), /контракту списка/)
})

test('repeating an unacknowledged command keeps its idempotency receipt, while a changed assignment or version gets a new receipt', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous; credentials.setAssignment(uid(1)) })
  const calls = []; let fail = true
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); if (fail) throw new Error('offline'); return Response.json({ command_id: uid(8), event_id: uid(9), replayed: false, incident }) }
  const body = { action: 'start', expected_version: 2 }
  await assert.rejects(customer.command(incident.id, body), /Нет связи/)
  fail = false
  await customer.command(incident.id, body)
  assert.equal(calls[0].init.headers['Idempotency-Key'], calls[1].init.headers['Idempotency-Key'])
  credentials.setAssignment(uid(10)); await customer.command(incident.id, body)
  assert.notEqual(calls[1].init.headers['Idempotency-Key'], calls[2].init.headers['Idempotency-Key'])
  await customer.command(incident.id, { action: 'start', expected_version: 3 })
  assert.notEqual(calls[2].init.headers['Idempotency-Key'], calls[3].init.headers['Idempotency-Key'])
  assert.equal(calls[2].init.headers['X-Project-Assignment'], uid(10))
  assert.equal(calls.some(call => call.url.includes('synthetic-token')), false)
})

test('a forged contractor response containing private customer fields fails contract validation', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous })
  globalThis.fetch = async () => Response.json({ incident: { ...incident, view: 'contractor' }, evidence: [], submissions: [], disputes: [], history: [] })
  await assert.rejects(customer.incident(incident.id), /Неверный ответ API/)
})

test('evidence upload carries expected version and stable content receipt; response integrity is validated', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous })
  const calls = []; const asset = { id: uid(11), project_id: uid(4), sha256: 'a'.repeat(64), media_type: 'image/jpeg', size_bytes: 3, captured_at: null, received_at: '2026-10-20T12:00:00Z', source: 'upload', integrity: 'verified' }
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json(asset) }
  const file = new File(['abc'], 'after.jpg', { type: 'image/jpeg' })
  await customer.uploadEvidence(incident.id, file, 2); await customer.uploadEvidence(incident.id, file, 2)
  assert.equal(calls[0].init.body.get('expected_version'), '2')
  assert.equal(await calls[0].init.body.get('file').text(), 'abc')
  assert.equal(calls[0].init.headers['Idempotency-Key'], calls[1].init.headers['Idempotency-Key'])
  globalThis.fetch = async () => Response.json({ ...asset, sha256: 'invalid' })
  await assert.rejects(customer.uploadEvidence(incident.id, file, 2), /Неверный ответ API/)
})

test('business conflict messages distinguish independent review and open disputes from a generic retry', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous })
  globalThis.fetch = async () => Response.json({ detail: { code: 'SELF_REVIEW_FORBIDDEN', message: 'independent manager required' } }, { status: 409 })
  try { await customer.command(incident.id, { action: 'start', expected_version: 2 }); assert.fail('must reject') } catch (error) { assert.match(customer.errorMessage(error), /другой управляющий/); assert.equal(error.status, 409) }
  globalThis.fetch = async () => Response.json({ detail: { code: 'OPEN_DISPUTE', message: 'open dispute' } }, { status: 409 })
  try { await customer.command(incident.id, { action: 'start', expected_version: 2 }); assert.fail('must reject') } catch (error) { assert.match(customer.errorMessage(error), /отзыв открытого спора/) }
})


test('large saved videos request audience cookies and canonical streaming URL without fetching an entire file', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous })
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ media_url: '/api/v1/videos/video-id/media', expires_at: '2026-12-31T12:00:00Z' }) }
  const session = await customer.savedVideoPlayback('video-id')
  assert.equal(session.media_url, '/api/v1/videos/video-id/media')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, '/api/v1/videos/video-id/playback-session')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.credentials, 'include')
  assert.equal(calls[0].init.headers['X-Project-Assignment'], uid(1))
  assert.match(calls[0].init.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/)
  globalThis.fetch = async () => Response.json({ media_url: 'https://outside.example/private.mp4', expires_at: '2026-12-31T12:00:00Z' })
  await assert.rejects(customer.savedVideoPlayback('video-id'), /недопустима/)
})

test('archive form requires explicit acknowledgement and sends the checked value with current project version', async t => {
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous })
  const project = { id: context.project_id, name: 'Изолированный объект', code: 'QA', kind: 'jury', lifecycle: 'active', row_version: 4 }
  const clientUrl = await moduleUrl('../src/sverka/customerApi.ts', { '../api/stroyControlApi': credentialsUrl, './api': apiUrl, '../api/generated/customerControl': schemasUrl })
  const hooksUrl = dataUrl(`
    let states=[], cursor=0, mounted=false, effects=[];
    export const begin=()=>{cursor=0};
    export const flush=async()=>{for(const fn of effects.splice(0)) fn();await Promise.resolve();await Promise.resolve();await Promise.resolve()};
    export function useState(initial){const index=cursor++;if(!(index in states))states[index]=initial;return[states[index],value=>{states[index]=typeof value==='function'?value(states[index]):value}]};
    export function useEffect(fn){if(!mounted){mounted=true;effects.push(fn)}};
  `)
  const runtimeUrl = dataUrl(`export const Fragment='fragment';export const jsx=(type,props)=>({type,props});export const jsxs=jsx;`)
  const readsUrl = dataUrl(`
    export { archiveProject,restoreProject,errorMessage } from '${clientUrl}';
    export const assignmentOptions=async()=>(${JSON.stringify({ project, assignments: [], participations: [], members: [], areas: [], zones: [], stages: [] })});
    export const incidents=async()=>[{id:'open-case',status:'in_progress'}];
  `)
  const helpersUrl = dataUrl(`export const can=(ctx,permission)=>ctx.effective_permissions.includes(permission);`)
  const policyUrl = dataUrl(`export const CustomerDeadlinePolicy=()=>null;`)
  const { CustomerParticipants } = await import(await moduleUrl('../src/sverka/parts/CustomerParticipants.tsx', { react: hooksUrl, 'react/jsx-runtime': runtimeUrl, '../customerApi': readsUrl, '../api': apiUrl, './CustomerWorkspace': helpersUrl, './CustomerDeadlinePolicy': policyUrl }))
  const hooks = await import(hooksUrl)
  const props = { context: { ...context, effective_permissions: ['project.manage'] }, onChanged() {} }
  const render = () => { hooks.begin(); return CustomerParticipants(props) }
  const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.props?.children)] : []
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : node == null || typeof node === 'boolean' ? '' : String(node)
  render(); await hooks.flush()
  let tree = render()
  let button = nodes(tree).find(node => node.type === 'button' && text(node) === 'Архивировать объект')
  assert.equal(button.props.disabled, true)
  nodes(tree).find(node => node.type === 'textarea').props.onChange({ target: { value: 'Работы завершены, открытое дело сохраняется' } })
  tree = render(); button = nodes(tree).find(node => node.type === 'button' && text(node) === 'Архивировать объект')
  assert.equal(button.props.disabled, true, 'a reason alone does not acknowledge the open case')
  nodes(tree).find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } })
  tree = render(); button = nodes(tree).find(node => node.type === 'button' && text(node) === 'Архивировать объект')
  assert.equal(button.props.disabled, false)
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ ...project, lifecycle: 'archived', row_version: 5 }) }
  button.props.onClick(); await hooks.flush()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, `/api/v1/customer-control/projects/${context.project_id}/archive`)
  assert.deepEqual(JSON.parse(calls[0].init.body), { expected_version: 4, reason: 'Работы завершены, открытое дело сохраняется', acknowledge_open_cases: true })
  assert.equal(calls[0].init.headers['X-Project-Assignment'], context.assignment_id)
  assert.match(calls[0].init.headers['Idempotency-Key'], /^[0-9a-f-]{36}$/)
})

test('privacy-redacted notification titles use human text and never expose technical event codes', async () => {
  const { notificationTitle } = await import(await moduleUrl('../src/sverka/notificationText.ts'))
  assert.equal(notificationTitle({ title: '', event_type: 'incident.workflow_changed' }), 'Изменён статус дела')
  assert.equal(notificationTitle({ title: '   ', event_type: 'internal.resource_secret_changed' }), 'Изменение по доступному ресурсу')
  assert.equal(notificationTitle({ event_type: 'incident.workflow_changed' }), 'Изменён статус дела')
  assert.equal(notificationTitle({ title: 'Опубликованы требования', event_type: 'requirements.published' }), 'Опубликованы требования')
})
