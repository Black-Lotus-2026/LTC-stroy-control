import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const dataUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
async function moduleUrl(path, replacements = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  let code = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022,jsx:ts.JsxEmit.React}}).outputText.replaceAll('import.meta.env','({})')
  for (const [from,to] of Object.entries(replacements)) code = code.replaceAll(`'${from}'`, `'${to}'`).replaceAll(`"${from}"`, `"${to}"`)
  return dataUrl(code)
}
const semanticsUrl = await moduleUrl('../src/domain/constructionObservations.ts')
const semantics = await import(semanticsUrl)
const machineryUrl = await moduleUrl('../src/sverka/lib/machinery.tsx')
const machinery = await import(machineryUrl)
const viewUrl = await moduleUrl('../src/sverka/lib/view.ts')
const loopUrl = await moduleUrl('../src/sverka/lib/loop.ts')

test('25 display classes preserve broad semantics and never become worker/hook stage rules', () => {
  assert.equal(semantics.OBSERVATION_CODES.length,25)
  assert.deepEqual(semantics.OBSERVATION_CODES,[...semantics.OBSERVATION_CODES].sort())
  for (const code of semantics.OBSERVATION_CODES) assert.equal(semantics.toObservationCode(`MACHINERY_${code.toUpperCase()}`),code)
  assert.equal(semantics.toObservationCode('crane'),null)
  assert.notEqual(semantics.OBSERVATION_LABELS.truck,semantics.OBSERVATION_LABELS.dump_truck)
  assert.notEqual(semantics.OBSERVATION_LABELS.mobile_crane,semantics.OBSERVATION_LABELS.truck_crane)
  assert.equal(machinery.CODES.length,13)
  for(const code of ['worker','hanging_head','truck','mobile_crane']) assert.equal(machinery.toCode(code),null)
  assert.equal(machinery.toCode('crawler_crane'),'crawler_crane')
})

test('actual engine retains all25 observations, records only stage13, fails closed on unavailable/error', async context => {
  const saved = Object.fromEntries(['document','window','HTMLImageElement','HTMLVideoElement','requestAnimationFrame'].map(k=>[k,globalThis[k]]))
  context.after(()=>Object.assign(globalThis,saved))
  globalThis.HTMLImageElement = class { naturalWidth=1920; naturalHeight=1080 }
  globalThis.HTMLVideoElement = class {}
  globalThis.requestAnimationFrame = () => 1
  globalThis.window = {setTimeout:()=>1}
  globalThis.document={createElement:()=>({getContext:()=>({drawImage(){},getImageData:()=>({data:new Uint8ClampedArray([1,2,3,255])})}),toDataURL:()=> 'data:image/jpeg;base64,realframe',toBlob:callback=>callback(new Blob(['image']))})}
  let response={model_ready:true,detections:semantics.OBSERVATION_CODES.map(code=>({raw_label:code,canonical_code:code,confidence:.8,x1:.1,y1:.2,x2:.3,y2:.4}))}
  globalThis.__inferenceUiMock = {detectFrame:async()=>{if(response instanceof Error)throw response;return response}}
  context.after(()=>{delete globalThis.__inferenceUiMock})
  const apiMock=dataUrl('export const detectFrame=(...args)=>globalThis.__inferenceUiMock.detectFrame(...args);')
  const {Engine}=await import(await moduleUrl('../src/sverka/engine.ts',{'./api':apiMock,'./lib/machinery':machineryUrl,'./lib/view':viewUrl,'./lib/loop':loopUrl,'../domain/constructionObservations':semanticsUrl}))
  const engine=new Engine()
  const rt={view:{id:'camera',kind:'camera',n:1,status:'live',dets:[]},el:new HTMLImageElement(),fails:0,same:0,hash:0,inFlight:false}
  engine.rts.set('camera',rt)
  const capture=async()=>{engine.capture(rt);await new Promise(resolve=>setImmediate(resolve))}
  await capture()
  assert.equal(rt.view.dets.length,25)
  assert.equal(engine.dets.size,13)
  assert.equal(engine.frames,1)
  assert.equal(engine.model,'ready')
  assert.equal(engine.snapshot().complianceEnabled,false)
  assert.deepEqual(engine.snapshot().evaluableClasses,[])
  response={...response,compliance_enabled:true,evaluable_classes:['excavator','worker']}
  await capture()
  assert.equal(engine.snapshot().complianceEnabled,true)
  assert.deepEqual(engine.snapshot().evaluableClasses,['excavator'])
  response={model_ready:false,detections:[],message:'weights unavailable'}
  await capture()
  assert.equal(engine.model,'down');assert.deepEqual(rt.view.dets,[]);assert.equal(engine.frames,2)
  response=new Error('offline')
  rt.view.dets=[{code:'excavator'}]
  await capture()
  assert.equal(engine.model,'down');assert.deepEqual(rt.view.dets,[]);assert.equal(engine.frames,2)
  let captured, calls=0
  engine.canvas.toBlob = callback => { captured=callback }
  globalThis.__inferenceUiMock.detectFrame = async () => { calls++; return {model_ready:true,detections:[]} }
  engine.capture(rt)
  engine.setSafetyRecordingCamera('different-camera')
  captured(new Blob(['frame']))
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(calls,0,'a pending capture cannot be submitted after camera context changed')
})

test('photo and video call distinct real endpoints and preserve explicit fallback/error fields', async context => {
  const savedFetch=globalThis.fetch
  context.after(()=>{globalThis.fetch=savedFetch})
  const authMock=dataUrl("export const API_BASE_URL='';export const API_PREFIX='/api/v1';export const getStoredToken=()=> 'token';export const setStoredToken=()=>{};")
  const api=await import(await moduleUrl('../src/sverka/api.ts',{'../api/stroyControlApi':authMock}))
  const calls=[]
  globalThis.fetch=async(url,init)=>{calls.push({url,init});return Response.json({model_ready:true,source:'vlm',fallback_status:'used',confidence_calibrated:false,detections:[]})}
  const file=new File(['photo'],'site.png',{type:'image/png'})
  const result=await api.detectPhoto(file)
  await api.detectFrame(new Blob(['frame']))
  assert.equal(calls[0].url,'/api/v1/videos/detect-photo')
  assert.equal(calls[0].init.body.get('file').name,'site.png')
  assert.equal(calls[0].init.headers.Authorization,'Bearer token')
  assert.equal(calls[1].url,'/api/v1/videos/detect-frame')
  assert.equal(result.source,'vlm');assert.equal(result.fallback_status,'used');assert.equal(result.confidence_calibrated,false)
  globalThis.fetch=async()=>Response.json({detail:'weights missing'},{status:503})
  await assert.rejects(api.detectPhoto(file),/weights missing/)
})

test('stage evaluation preserves sightings but never infers absence or out-of-stage incidents without explicit class permission', async () => {
  const formatUrl = await moduleUrl('../src/sverka/lib/format.ts')
  const model = await import(await moduleUrl('../src/sverka/model.ts',{'./lib/machinery':machineryUrl,'./lib/format':formatUrl,'./lib/view':viewUrl}))
  const now = new Date(2026,9,19,12).getTime()
  const rules=Object.fromEntries(machinery.CODES.map(code=>[code,{code,lvl:'req',p:99,warnAfter:0,errAfter:1}]))
  rules.worker={code:'worker',lvl:'req'} // not part of the stage vocabulary
  const obs={t:now,model:'ready',sources:[{status:'live'}],coverageStart:()=>now-3_600_000,seenWithin:code=>code==='excavator'?[{src:'camera',c:.8}]:[],lastSeen:()=>null,episodeStart:()=>null,complianceEnabled:false,evaluableClasses:[]}
  const profile={rules}
  const ev=model.evaluate(obs,{id:'stage'},profile,model.DEFAULTS)
  assert.equal(ev.covered,true)
  assert.equal(ev.slots.length,13)
  assert.equal(ev.slots.find(s=>s.code==='excavator').state,'seen')
  assert.equal(ev.slots.find(s=>s.code==='loader').state,'unknown')
  const enabled=model.evaluate({...obs,complianceEnabled:true,evaluableClasses:['loader']},{id:'stage'},profile,model.DEFAULTS)
  assert.equal(enabled.slots.find(s=>s.code==='loader').state,'missing')
  assert.equal(enabled.slots.find(s=>s.code==='truck_crane').state,'unknown')
})
