import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const dataUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
async function moduleUrl(path, replacements = {}) {
  if (path.endsWith('/sverka/model.ts') || path.endsWith('/sverka/engine.ts')) replacements = { './lib/view': await moduleUrl('../src/sverka/lib/view.ts'), './lib/loop': await moduleUrl('../src/sverka/lib/loop.ts'), ...replacements }
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

test('one designated shared demo is default while jury projects stay private and selectable', async () => {
  const scope=await import(await moduleUrl('../src/sverka/projectScope.ts'))
  const jury={id:'jury-id',username:'jury',role:'manager'}
  const projects=[{id:'own',code:'JURY',owner_username:'jury'},{id:'private',code:'PRIVATE',owner_username:'other'},{id:'unowned',code:'OLD-TEST',owner_username:null},{id:'demo',code:'MANAGEMENT-DEMO',owner_username:null}]
  assert.deepEqual(scope.visibleProjects(projects,jury).map(p=>p.id),['demo','own'])
  assert.deepEqual(scope.visibleProjects(projects,{username:'new-user',role:'manager'}).map(p=>p.id),['demo'])
  assert.equal(scope.visibleProjects(projects,{username:'admin',role:'admin'})[0].id,'demo')
  assert.equal(scope.isSharedDemoProject({...projects[3],owner_username:'other'}),false)
  const cameras=[{id:'camera2',project_id:'demo',zone_id:'zone2'}]
  assert.equal(scope.sourceCamera(cameras,'recording','camera2')?.zone_id,'zone2')
  assert.equal(scope.sourceCamera(cameras,'recording','foreign-camera'),undefined)
  assert.equal(scope.sourceCamera(cameras,'recording'),undefined)
  assert.equal(scope.recordingAnalysisLabel('RUNNING'),'Анализируется')
  assert.equal(scope.recordingAnalysisLabel('COMPLETED'),'Обработано')
  assert.equal(scope.recordingAnalysisLabel('FAILED'),'Ошибка')
})

test('shared demo has explicit fast intervals isolated from ordinary and old cached settings', async context => {
  const previous=globalThis.localStorage
  context.after(()=>{globalThis.localStorage=previous})
  const store=new Map([['sverka:settings:demo',JSON.stringify({warnAfter:999,errAfter:1000})]])
  globalThis.localStorage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)}
  const formatUrl=await moduleUrl('../src/sverka/lib/format.ts')
  const model=await import(await moduleUrl('../src/sverka/model.ts',{'./lib/machinery':machineryUrl,'./lib/format':formatUrl}))
  const demo=model.loadSettings('demo',true)
  assert.deepEqual([demo.window,demo.warnAfter,demo.errAfter,demo.oopAfter,demo.startGrace],[30,30,60,30,0])
  assert.equal(model.loadSettings('new-jury-project').warnAfter,300)
  assert.equal(model.loadSettings('new-jury-project').errAfter,1800)
  model.saveSettings('demo',{...demo,warnAfter:60,errAfter:120},true)
  assert.equal(model.loadSettings('demo',true).warnAfter,60)
  assert.equal(model.loadSettings('demo').warnAfter,999)
  assert.ok(model.STEPS.warnAfter.includes(30)&&model.STEPS.errAfter.includes(60))
  const e={assigneeId:null}
  assert.equal(model.rightsFor(e,{id:'jury',username:'jury',role:'manager'},null,true).act,true)
  assert.equal(model.rightsFor({...e,assigneeId:'admin'},{id:'jury',username:'jury',role:'manager'},null,true).act,true)
  assert.equal(model.rightsFor(e,{id:'jury',username:'jury',role:'manager'},null,false).act,false)
  assert.equal(model.rightsFor(e,{id:'viewer',username:'viewer',role:'viewer'},null,true).act,false)
})

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
  const authMock=dataUrl("export const API_BASE_URL='';export const API_PREFIX='/api/v1';export const getStoredToken=()=> 'token';export const getAuthHeaders=()=>({Authorization:'Bearer token'});export const setStoredToken=()=>{};")
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

test('saved recording streams its URL, follows filming time and restores cameras on exit', async context => {
  const saved = Object.fromEntries(['document','window','HTMLImageElement','HTMLVideoElement','Image'].map(k=>[k,globalThis[k]]))
  context.after(()=>Object.assign(globalThis,saved))
  class ImageMock { removeAttribute() {} remove() {} }
  class VideoMock {
    currentTime=0; duration=120; paused=true
    play() { this.paused=false; return Promise.resolve() }
    pause() { this.paused=true }
    removeAttribute() {} remove() {} load() {}
  }
  globalThis.HTMLImageElement=ImageMock
  globalThis.HTMLVideoElement=VideoMock
  globalThis.window={setTimeout:()=>1}
  globalThis.document={createElement:tag=>tag==='video'?new VideoMock():tag==='img'?new ImageMock():{}}
  globalThis.Image=ImageMock
  const {Engine}=await import(await moduleUrl('../src/sverka/engine.ts',{'./api':dataUrl('export const noop=()=>{};'),'./lib/machinery':machineryUrl,'../domain/constructionObservations':semanticsUrl}))
  const engine=new Engine()
  const cameras=[{id:'camera',name:'Camera',stream_url:'http://camera.local/image'}]
  engine.setCameras(cameras)
  const start=Date.parse('2026-10-19T10:19:26+03:00')
  engine.startRecordingUrl('/media/videos/camera2.mp4','Camera 2',start)
  assert.equal(engine.mode,'recording')
  assert.deepEqual([...engine.rts.keys()],['recording'])
  assert.equal(engine.recording.el.src,'/media/videos/camera2.mp4')
  assert.equal(engine.recording.el.crossOrigin,'anonymous')
  engine.recording.el.currentTime=30
  assert.equal(engine.now(),start+30_000)
  engine.recording.el.onloadeddata()
  assert.equal(engine.recording.duration,120_000)
  assert.equal(engine.recording.el.paused,false)
  const firstElement=engine.recording.el
  engine.startRecordingUrl('/media/videos/camera3.mp4','Camera 3',start)
  assert.notEqual(engine.recording.el,firstElement)
  assert.equal(firstElement.paused,true)
  assert.equal(engine.snapshot().sources[0].url,'/media/videos/camera3.mp4')
  const secondElement=engine.recording.el
  engine.startRecordingUrl('/media/videos/camera3.mp4','Camera 3',start)
  assert.notEqual(engine.element('recording'),secondElement,'restarting the same URL creates a new media element for the view to adopt')
  engine.stopRecording()
  assert.equal(engine.mode,'live')
  assert.equal(engine.recording,null)
  assert.deepEqual([...engine.rts.keys()],['camera'])
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
  const verdict=(o,e)=>model.verdictOf({ev:e,obs:o,prof:profile,events:[],episodes:new Map(),hasPlan:true,s:model.DEFAULTS})
  assert.equal(verdict(obs,ev).tone,'none')
  assert.match(verdict(obs,ev).sub,/недостаточно/)
  const empty={...obs,seenWithin:()=>[]}
  const emptyVerdict=verdict(empty,model.evaluate(empty,{id:'stage'},profile,model.DEFAULTS))
  assert.equal(emptyVerdict.title,'Распознавание техники работает')
  assert.doesNotMatch(emptyVerdict.sub,/замечены:|замечена.*:\s*\./)
  assert.equal(verdict({...obs,complianceEnabled:true,evaluableClasses:['loader']},enabled).tone,'none')
  const fullySeen={...obs,complianceEnabled:true,evaluableClasses:machinery.CODES,seenWithin:()=>[{src:'camera',c:.8}]}
  assert.equal(verdict(fullySeen,model.evaluate(fullySeen,{id:'stage'},profile,model.DEFAULTS)).tone,'ok')
  const recording={...empty,mode:'recording',complianceEnabled:true,evaluableClasses:machinery.CODES}
  const recordingEv=model.evaluate(recording,{id:'stage'},profile,model.DEFAULTS)
  assert.ok(recordingEv.slots.every(slot=>slot.state==='unknown'),'a single video cannot establish site-wide absence')
  const outOfStage={rules:{...rules,excavator:{...rules.excavator,lvl:'no'}}}
  assert.deepEqual(model.evaluate({...recording,seenWithin:obs.seenWithin},{id:'stage'},outOfStage,model.DEFAULTS).oop,[])
})

test('recording equipment incidents belong to the server and private demo identity controls are locked', async () => {
  const source=await readFile(new URL('../src/sverka/SverkaApp.tsx',import.meta.url),'utf8')
  const file=ts.createSourceFile('SverkaApp.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  let equipmentEffect
  const visit=node=>{
    if(ts.isCallExpression(node)&&node.expression.getText(file)==='useEffect'&&node.arguments[0]?.getText(file).includes('const make ='))equipmentEffect=node.arguments[0]
    ts.forEachChild(node,visit)
  }
  visit(file)
  const guard=equipmentEffect.body.statements.find(ts.isIfStatement)
  assert.match(guard.expression.getText(file),/obs\.mode === 'recording'/)
  assert.ok(ts.isReturnStatement(guard.thenStatement))
  assert.match(source,/title: 'Серверная проверка записи'/)
  assert.match(source,/!active \|\| token !== loadToken\.current/)
  const settings=await readFile(new URL('../src/sverka/parts/Settings.tsx',import.meta.url),'utf8')
  assert.match(settings,/<fieldset disabled=\{metadataLocked\}/)
  assert.match(settings,/metadataLocked \? <p className="hint">Общий демонстрационный объект/)
})

test('verdict and saved recordings occupy one summary grid row before the monitor', async () => {
  const source=await readFile(new URL('../src/sverka/SverkaApp.tsx',import.meta.url),'utf8')
  const file=ts.createSourceFile('SverkaApp.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  const cls=node=>ts.isJsxElement(node)?node.openingElement.attributes.properties.find(a=>a.name?.text==='className')?.initializer?.text:undefined
  let app
  const visit=node=>{if(cls(node)==='app')app=node;ts.forEachChild(node,visit)}
  visit(file)
  const rows=app.children.filter(ts.isJsxElement)
  assert.deepEqual(rows.slice(0,3).map(cls),['bar','observation-summary','work'])
  const summary=rows[1].getText(file)
  assert.match(summary,/<Verdict\b/)
  assert.match(summary,/className="saved-recordings"/)
  assert.equal(rows.some(node=>cls(node)==='saved-recordings'),false)
})
