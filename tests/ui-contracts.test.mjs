import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

async function loadTypeScript(path) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replaceAll('import.meta.env', '({})')
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
}
const presentation = await loadTypeScript('../src/domain/incidentPresentation.ts')
const workflow = await loadTypeScript('../src/domain/incidentWorkflow.ts')
const observation = await loadTypeScript('../src/domain/observationScope.ts')
const store = new Map()
globalThis.localStorage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) }
const api = await loadTypeScript('../src/api/stroyControlApi.ts')
const stageId = '11111111-1111-4111-8111-111111111111'
const projectId = '22222222-2222-4222-8222-222222222222'

test('counts use mutually exclusive categories, stream recovery remains informational', () => {
  assert.equal(presentation.incidentKind({ severity: 'ERROR', discrepancyType: 'MISSING_RECOMMENDED' }), 'error')
  assert.equal(presentation.incidentKind({ severity: 'WARNING', discrepancyType: 'STREAM_ONLINE', priority: 'Критический' }), 'info')
  assert.equal(presentation.isDeviation({ severity: 'WARNING', discrepancyType: 'STREAM_ONLINE' }), false)
  assert.equal(presentation.isOpenIncident({ status: 'Устранено' }), false)
})

test('scope filters never borrow events from another object or unspecified site', () => {
  const a = { projectId: 'a', zoneId: 'x' }, b = { projectId: 'b', zoneId: 'x' }, c = { projectId: 'a' }
  assert.deepEqual(presentation.filterIncidents([a,b,c], 'a', 'x'), [a])
  assert.deepEqual(presentation.filterIncidents([a,b,c], 'a', 'all'), [a,c])
  assert.deepEqual(presentation.filterIncidents([a,b,c], undefined, 'all'), [])
})

test('failed writes never return fabricated cameras, schedules or saved rules', async context => {
  const previous = globalThis.fetch
  context.after(() => { globalThis.fetch = previous })
  globalThis.fetch = async () => new Response(JSON.stringify({detail:'Unavailable'}), {status:503})
  const before = store.get('stroy_prob_overrides')
  await assert.rejects(api.createCamera(projectId, { name:'Camera' }), /Unavailable/)
  await assert.rejects(api.updateCamera(projectId, stageId, { name:'Camera' }), /Unavailable/)
  await assert.rejects(api.loadDemoSchedule(projectId), /Unavailable/)
  await assert.rejects(api.clearSchedule(projectId))
  await assert.rejects(api.cascadeShiftStages(stageId, 3), /Unavailable/)
  await assert.rejects(api.updateStageProbabilities(stageId, { truck:'MANDATORY' }, 'Shared name'), /Unavailable/)
  await assert.rejects(api.resetStageProbabilities(stageId, 'Shared name'), /Unavailable/)
  assert.equal(store.get('stroy_prob_overrides'), before)
})

test('read errors are errors, not empty projects or invented probabilities', async context => {
  const previous = globalThis.fetch
  context.after(() => { globalThis.fetch = previous })
  globalThis.fetch = async () => { throw new Error('Offline') }
  await assert.rejects(api.fetchProjects(), /Offline/)
  await assert.rejects(api.fetchStages(projectId), /Offline/)
  await assert.rejects(api.fetchStageProbabilities(stageId), /Offline/)
})

test('confirmed rule responses populate only their unique stage cache', async context => {
  const previous = globalThis.fetch
  context.after(() => { globalThis.fetch = previous })
  const data = { stage_id:stageId, probabilities:[{ machinery_code:'truck', classification:'RECOMMENDED' }], has_custom_override:true }
  globalThis.fetch = async () => new Response(JSON.stringify(data), {status:200})
  await api.updateStageProbabilities(stageId, {truck:'RECOMMENDED'}, 'Shared name')
  assert.deepEqual(api.getStageCustomOverrides(stageId), {truck:'RECOMMENDED'})
  assert.deepEqual(api.getStageCustomOverrides('other-stage', 'Shared name'), {})
})

test('calendar selection uses its explicit date even before the old demo year', () => {
  const stages = [
    {id:'old',planned_start:'2025-01-01',planned_end:'2025-01-31',status:'planned'},
    {id:'future',planned_start:'2026-09-01',planned_end:'2026-09-30',status:'planned'},
  ]
  assert.equal(api.getCurrentStageByDate(stages, new Date('2025-01-15T12:00:00Z')).id, 'old')
})


test('rules for another stage never contaminate the cache', async context => {
  const previous = globalThis.fetch
  context.after(() => { globalThis.fetch = previous })
  const before = store.get('stroy_prob_overrides')
  globalThis.fetch = async () => new Response(JSON.stringify({ stage_id:projectId, probabilities:[] }), {status:200})
  await assert.rejects(api.fetchStageProbabilities(stageId), /другого этапа/)
  await assert.rejects(api.updateStageProbabilities(stageId, {}), /другого этапа/)
  await assert.rejects(api.resetStageProbabilities(stageId), /другого этапа/)
  assert.equal(store.get('stroy_prob_overrides'), before)
})

test('event dates stay distinguishable across days, missing dates stay explicit', () => {
  assert.notEqual(presentation.incidentDateTime({createdAt:'2026-10-16T08:00:00Z'}), presentation.incidentDateTime({createdAt:'2026-10-15T08:00:00Z'}))
  assert.equal(presentation.incidentDateTime({createdAt:'bad'}), 'Время не указано')
})


test('a camera keeps its own site, ambiguous video never borrows the first site', () => {
  const zones = [{id:'a',name:'A'},{id:'b',name:'B'}]
  const cameras = [{id:'c',code:'C',zone_id:'b'}]
  assert.equal(observation.observationScope(cameras,zones,'c','all').zone.id,'b')
  assert.equal(observation.observationScope(cameras,zones,'c','a').zone.id,'b')
  assert.equal(observation.observationScope(cameras,zones,'video-source','all').zone,undefined)
  assert.equal(observation.observationScope(cameras,zones,'video-source','a').zone.id,'a')
})

test('repeated observations replace one saved case and preserve its confirmed status and time', () => {
  const saved = {id:'INC-1',uuid:'uuid-1',status:'Подтверждено',createdAt:'2026-10-15T12:00:00Z'}
  const items = [{id:'temporary',status:'Ожидает обработки'}, saved, {id:'INC-2',uuid:'uuid-2'}]
  const result = observation.upsertIncident(items, saved, 'temporary')
  assert.equal(result.length,2)
  assert.equal(result.filter(item=>item.uuid==='uuid-1').length,1)
  assert.equal(result[0].status,'Подтверждено')
  assert.equal(result[0].createdAt,'2026-10-15T12:00:00Z')
})


test('schedule imports carry authentication without inventing successful stages', async context => {
  const previous = globalThis.fetch
  const previousToken = store.get('stroy_control_token')
  context.after(() => { globalThis.fetch = previous; if(previousToken) store.set('stroy_control_token',previousToken); else store.delete('stroy_control_token') })
  store.set('stroy_control_token','test-local-token')
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization,'Bearer test-local-token')
    assert.equal(options.headers['Content-Type'],undefined)
    assert.ok(options.body instanceof FormData)
    return new Response(JSON.stringify({detail:'Import unavailable'}),{status:503})
  }
  await assert.rejects(api.uploadScheduleFile(new File(['stage,start,end'], 'plan.csv'), projectId), /Import unavailable/)
})


test('incident actions follow assignment and verification from merged alert lifecycle', () => {
  const user = {id:'a',username:'owner',role:'manager'}
  assert.equal(workflow.canChangeIncident({assignedUserId:'b'},user,'owner'),false)
  assert.equal(workflow.canChangeIncident({assignedUserId:'a'},user,'other'),true)
  assert.equal(workflow.canChangeIncident({},user,'owner'),true)
  assert.equal(workflow.canChangeIncident({assignedUserId:'a'},{...user,role:'viewer'},'owner'),false)
  assert.deepEqual(workflow.incidentActions({status:'Подтверждено',verificationStatus:'requested'}),[])
  assert.deepEqual(workflow.incidentActions({status:'Устранено'}),[])
  assert.equal(workflow.incidentActions({status:'В работе',canDismiss:false}).includes('Проблемы нет'),false)
  assert.equal(workflow.incidentActions({status:'В работе',canDismiss:true}).includes('Проблемы нет'),true)
})
