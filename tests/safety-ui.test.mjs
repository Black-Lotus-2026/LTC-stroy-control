import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
async function moduleUrl(path, replacements = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
  for (const [from, to] of Object.entries(replacements)) code = code.replaceAll(`'${from}'`, `'${to}'`).replaceAll(`"${from}"`, `"${to}"`)
  return dataUrl(code)
}
const legacy = dataUrl('export const API_PREFIX="/api/v1"; export const API_BASE_URL=""; export const getStoredToken=()=>"safety-token"; export const setStoredToken=()=>{}')
const apiUrl = await moduleUrl('../src/sverka/api.ts', { '../api/stroyControlApi': legacy })
const api = await import(apiUrl)
const safety = await import(await moduleUrl('../src/sverka/safetyApi.ts', { '../api/stroyControlApi': legacy, './api': apiUrl }))

test('safety analysis sends authenticated camera context and video flag, never VLM', async context => {
  const saved = globalThis.fetch; context.after(() => { globalThis.fetch = saved })
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({url, init}); return Response.json({model_ready:true,detections:[]}) }
  await api.detectFrame(new Blob(['local-frame']), undefined, {projectId:'project',cameraId:'camera',sourceId:'recording-session',positionMs:1792400000200,recordingMode:true})
  assert.equal(calls[0].url, '/api/v1/safety/projects/project/analyze-frame')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer safety-token')
  for (const [key, val] of Object.entries({camera_id:'camera',source_id:'recording-session',position_ms:'1792400000200',recording_mode:'true'})) assert.equal(calls[0].init.body.get(key),val)
  assert.equal(calls[0].init.body.has('detections'), false)
  await api.detectFrame(new Blob(['local-frame']))
  assert.equal(calls[1].url, '/api/v1/videos/detect-frame')
})

test('wire event preserves document limitations, evidence identity and source time', async context => {
  const saved = globalThis.fetch; context.after(() => { globalThis.fetch = saved })
  const wire = { id:'event',status:'candidate',can_review:false,scenario:'worker_danger_zone',title:'Человек в опасной зоне',camera_id:'camera',source_id:'session',first_position_ms:1792400000000,last_position_ms:1792400003000,created_at:'2026-10-19T12:00:00Z',model_sha256:'model',evidence_sha256:'last',snapshot:{zone:{name:'Зона',camera_name:'Камера А'},detections:[],requirements:[{clause:'P03',applicability_note:'Область требования',document:{code:'ГОСТ',applicability_note:'Поправка не подтверждена'}}],sanctions:[],limitations:'Идентичность не доказана',observations:2,algorithm_version:'camera-zone-v1',first_evidence_sha256:'first'} }
  globalThis.fetch = async () => Response.json([wire])
  const [event] = await safety.safetyEvents('project')
  assert.equal(event.status,'pending'); assert.equal(event.can_review,false)
  assert.equal(event.camera_name,'Камера А')
  assert.equal(event.norm_snapshot[0].document_applicability_note,'Поправка не подтверждена')
  assert.equal(event.norm_snapshot[0].applicability_note,'Область требования')
  assert.equal(event.first_evidence_sha256,'first'); assert.equal(event.evidence_sha256,'last')
  assert.equal(event.limitations,'Идентичность не доказана'); assert.equal(event.observations,2)
  assert.equal(event.first_seen,new Date(wire.first_position_ms).toISOString())
  assert.equal(safety.sourceTime(61000),'Позиция записи: 1:01')
})

test('review errors propagate and evidence uses authorization without URL secrets', async context => {
  const saved = globalThis.fetch; context.after(() => { globalThis.fetch = saved })
  globalThis.fetch = async () => Response.json({detail:'Решение уже принято'},{status:409})
  await assert.rejects(safety.reviewSafetyEvent('event','confirmed','Проверено'),/Решение уже принято/)
  let request
  globalThis.fetch = async (url, init) => { request={url,init}; return new Response('image',{headers:{'Content-Type':'image/jpeg'}}) }
  await safety.safetyEvidence('event', new AbortController().signal,'first')
  assert.equal(request.url,'/api/v1/safety/events/event/evidence?kind=first')
  assert.equal(request.init.headers.Authorization,'Bearer safety-token')
  assert.equal(request.url.includes('safety-token'),false)
})

const geometry = await import(await moduleUrl('../src/sverka/safetyGeometry.ts'))

test('polygon validation accepts concave zones with disjoint collinear edges and rejects crossings', () => {
  assert.equal(geometry.polygonProblem([[.1,.1],[.3,.1],[.3,.3],[.7,.3],[.7,.1],[.9,.1],[.9,.9],[.1,.9]]), '')
  assert.match(geometry.polygonProblem([[0,0],[1,1],[0,1],[1,0],[.5,.1]]), /пересекает/)
  assert.match(geometry.polygonProblem([[0,0],[1,0],[1,0]]), /повторяться/)
  assert.match(geometry.polygonProblem([[0,0],[1,0],[NaN,1]]), /Координаты/)
})
