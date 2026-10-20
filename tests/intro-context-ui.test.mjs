import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
const dataUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
async function moduleUrl(path, replacements = {}) {
  let code = ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), { fileName: path, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  for (const [from, to] of Object.entries(replacements)) code = code.replaceAll(`'${from}'`, `'${to}'`).replaceAll(`"${from}"`, `"${to}"`)
  return dataUrl(code)
}
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const context = { organization_id: uuid(1), membership_id: uuid(2), project_id: uuid(3), participation_id: uuid(4), assignment_id: uuid(5), organization_name: 'Организация А', project_name: 'Объект А', role: 'customer_manager', side: 'customer', scope: { kind: 'project' }, authorization_version: 1, effective_permissions: ['project.read', 'incident.read', 'camera.read'], is_demo: false, lifecycle: 'active' }
const helpersUrl = await moduleUrl('../src/sverka/customerContext.ts')
const { introPresentation } = await import(await moduleUrl('../src/sverka/introContext.ts', { './customerContext': helpersUrl }))
const state = ctx => ({ context: ctx, accessLoading: false, accessError: '', accessNotice: '' })

test('intro describes the selected assignment and its actual work rather than the global account role', () => {
  const manager = introPresentation(state(context))
  const foreman = introPresentation(state({ ...context, role: 'contractor_foreman', side: 'contractor' }))
  const pto = introPresentation(state({ ...context, role: 'pto_engineer', side: 'contractor' }))
  assert.equal(manager.role, 'Управляющий заказчика'); assert.equal(manager.cta, 'Перейти к решениям')
  assert.equal(foreman.role, 'Прораб подрядчика'); assert.equal(foreman.cta, 'Открыть мои задачи')
  assert.equal(pto.role, 'ПТО подрядчика'); assert.equal(pto.cta, 'Открыть документы')
  assert.match(manager.task, /риски/); assert.match(foreman.task, /свои задачи/); assert.match(pto.task, /страницы ППР/)
  assert.equal(introPresentation(state({ ...context, is_demo: true })).cta, 'Открыть демонстрацию')
  assert.match(introPresentation(state({ ...context, is_demo: true })).task, /только просмотр/)
})

test('intro loading, failed access and missing assignments never invent a project role', () => {
  assert.equal(introPresentation({ ...state(null), accessLoading: true }).disabled, true)
  const failed = introPresentation({ ...state(null), accessError: 'Нет связи с сервером' })
  assert.equal(failed.role, 'Доступ не проверен'); assert.equal(failed.action, 'retry'); assert.match(failed.task, /Нет связи/)
  const empty = introPresentation(state(null))
  assert.equal(empty.role, 'Назначение не выбрано'); assert.equal(empty.cta, 'Организации и приглашения')
})

test('intro side data is selected by context, gates optional requests and propagates failures without fabricated empty lists', async () => {
  const apiUrl = dataUrl(`export const calls=[]; export let fail=false; export const setFail=value=>{fail=value};export const projects=async()=>{calls.push('projects');return[{id:'unrelated',name:'Чужой'}, {id:'${context.project_id}',name:'Выбранный'}]};export const stages=async()=>{calls.push('stages');if(fail)throw Error('plan unavailable');return[]};export const incidents=async()=>{calls.push('incidents');return[]};export const cameras=async()=>{calls.push('cameras');return[{id:'camera-id'}]};export const profile=async()=>{calls.push('profile');return{}};export const mediaUrl=value=>value;`)
  const modelUrl = dataUrl(`export const toStages=value=>value;export const stageAt=()=>null;export const toEvent=value=>value;export const loadSettings=()=>({});export const loadLocalRules=()=>({});export const toProfile=()=>({rules:{}});`)
  const api = await import(apiUrl)
  const { loadIntroSite } = await import(await moduleUrl('../src/sverka/introData.ts', { './api': apiUrl, './customerContext': helpersUrl, './projectScope': dataUrl('export const isSharedDemoProject=()=>false;'), './lib/machinery': dataUrl('export const CODES=[];'), './model': modelUrl }))
  assert.equal(await loadIntroSite(null), null); assert.deepEqual(api.calls, [])
  const pto = await loadIntroSite({ ...context, role: 'pto_engineer', side: 'contractor', effective_permissions: ['project.read', 'document.read'] })
  assert.deepEqual(api.calls, ['projects']); assert.equal(pto.project.name, 'Выбранный'); assert.equal(pto.planAvailable, false); assert.equal(pto.eventsAvailable, false); assert.equal(pto.camerasAvailable, false)
  api.calls.length = 0
  await loadIntroSite({ ...context, role: 'contractor_foreman', side: 'contractor' })
  assert.deepEqual(api.calls, ['projects', 'incidents', 'cameras'])
  api.calls.length = 0; api.setFail(true)
  await assert.rejects(loadIntroSite(context), /plan unavailable/)
  assert.deepEqual(api.calls, ['projects', 'stages', 'incidents', 'cameras'])
})

test('one context loader rejects stale user responses, clears 401 and ignores refresh callbacks after logout', async t => {
  const hooksUrl = dataUrl(`
    let slots=[],cursor=0,effects=[];
    const same=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
    export const begin=()=>{cursor=0};
    export function useState(value){const i=cursor++;if(!(i in slots))slots[i]={value:typeof value==='function'?value():value};return[slots[i].value,next=>{slots[i].value=typeof next==='function'?next(slots[i].value):next}]};
    export function useRef(value){return useState(()=>({current:value}))[0]};
    export function useCallback(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={value:fn,deps};return slots[i].value};
    export function useEffect(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps)){const previous=slots[i];slots[i]={deps,cleanup:previous?.cleanup};effects.push(()=>{slots[i].cleanup?.();slots[i].cleanup=fn()})}};
    export const flush=async()=>{for(const fn of effects.splice(0))fn();await new Promise(resolve=>setTimeout(resolve,0))};
    export const dispose=()=>{for(const slot of slots)slot?.cleanup?.()};
  `)
  const runtimeUrl = dataUrl(`export const Fragment='fragment';export const jsx=(type,props)=>({type,props});export const jsxs=jsx;`)
  const credentialsUrl = dataUrl(`let assignment=null;export const setProjectAssignment=value=>{assignment=value};export const getAssignment=()=>assignment;`)
  const apiUrl = dataUrl(`export const requests=[];export const contexts=signal=>new Promise((resolve,reject)=>requests.push({resolve,reject,signal}));export const errorMessage=error=>error.message;`)
  const { CustomerWorkspace } = await import(await moduleUrl('../src/sverka/parts/CustomerWorkspace.tsx', { react: hooksUrl, 'react/jsx-runtime': runtimeUrl, '../../api/stroyControlApi': credentialsUrl, '../customerApi': apiUrl, '../customerContext': helpersUrl, './CustomerOrganizations': dataUrl('export const CustomerOrganizations=()=>null;'), '../customer-control.css': dataUrl('') }))
  const hooks = await import(hooksUrl), api = await import(apiUrl), credentials = await import(credentialsUrl)
  t.after(() => hooks.dispose())
  let logouts = 0
  const props = { user: { id: 'user-a', username: 'A', role: 'viewer' }, onLogout: () => { logouts++ }, renderWorkspace: access => ({ type: 'native', access }), render: (access, workspace) => ({ access, workspace }) }
  const render = () => { hooks.begin(); return CustomerWorkspace(props) }
  let view = render(); assert.equal(view.access.context, null); assert.equal(view.access.accessLoading, true)
  await hooks.flush(); assert.equal(api.requests.length, 1)
  api.requests[0].resolve([context]); await hooks.flush(); view = render()
  assert.equal(view.access.context.assignment_id, context.assignment_id); assert.equal(credentials.getAssignment(), context.assignment_id)
  const beforeChange = view.access.onRefreshAccess; beforeChange(); await hooks.flush()
  props.user = { id: 'user-b', username: 'B', role: 'viewer' }
  view = render(); assert.equal(view.access.context, null, 'old user context is hidden before effects run')
  await hooks.flush(); assert.equal(api.requests.length, 3)
  const next = { ...context, assignment_id: uuid(6), project_id: uuid(7), role: 'pto_engineer' }
  api.requests[2].resolve([next]); await hooks.flush(); view = render()
  api.requests[1].resolve([context]); await hooks.flush(); view = render()
  assert.equal(view.access.context.assignment_id, next.assignment_id); assert.equal(credentials.getAssignment(), next.assignment_id)
  view.access.onRefreshAccess(); await hooks.flush()
  api.requests[3].reject(Object.assign(new Error('expired'), { status: 401 })); await hooks.flush(); view = render()
  assert.equal(logouts, 1); assert.equal(view.access.context, null); assert.equal(credentials.getAssignment(), null)
  const staleRefresh = view.access.onRefreshAccess
  props.user = null; render(); await hooks.flush()
  const requestCount = api.requests.length; staleRefresh(); await hooks.flush()
  assert.equal(api.requests.length, requestCount); assert.equal(credentials.getAssignment(), null)
})

test('an intro project response from an abandoned assignment starts no downstream source or plan requests', async () => {
  const apiUrl = dataUrl(`export const calls=[];export let resolveProjects;export const projects=()=>{calls.push('projects');return new Promise(resolve=>{resolveProjects=resolve})};export const stages=async()=>{calls.push('stages');return[]};export const incidents=async()=>{calls.push('incidents');return[]};export const cameras=async()=>{calls.push('cameras');return[]};export const profile=async()=>{calls.push('profile');return{}};export const mediaUrl=value=>value;`)
  const api = await import(apiUrl)
  const emptyModel = dataUrl(`export const toStages=value=>value;export const stageAt=()=>null;export const toEvent=value=>value;export const loadSettings=()=>({});export const loadLocalRules=()=>({});export const toProfile=()=>({rules:{}});`)
  const { loadIntroSite } = await import(await moduleUrl('../src/sverka/introData.ts', { './api': apiUrl, './customerContext': helpersUrl, './projectScope': dataUrl('export const isSharedDemoProject=()=>false;'), './lib/machinery': dataUrl('export const CODES=[];'), './model': emptyModel }))
  let current = true
  const pending = loadIntroSite(context, () => current)
  current = false; api.resolveProjects([{ id: context.project_id }])
  assert.equal(await pending, null); assert.deepEqual(api.calls, ['projects'])
})
