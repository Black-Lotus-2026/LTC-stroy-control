import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const dataUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
async function moduleUrl(path, replacements = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React } }).outputText
  for (const [from, to] of Object.entries(replacements)) code = code.replaceAll(`'${from}'`, `'${to}'`).replaceAll(`"${from}"`, `"${to}"`)
  return dataUrl(code)
}
const machinery = await moduleUrl('../src/sverka/lib/machinery.tsx')
const semantics = await moduleUrl('../src/domain/constructionObservations.ts')
const view = await moduleUrl('../src/sverka/lib/view.ts')
const loop = await moduleUrl('../src/sverka/lib/loop.ts')
const engineUrl = await moduleUrl('../src/sverka/engine.ts', { './api': dataUrl('export const viewImage=(...args)=>globalThis.__cameraIntegrityMock.viewImage(...args); export const detectFrame=(...args)=>globalThis.__cameraIntegrityMock.detectFrame(...args);'), './lib/machinery': machinery, '../domain/constructionObservations': semantics, './lib/view': view, './lib/loop': loop })
const { Engine } = await import(engineUrl)
function installDom(context) {
  const previous = Object.fromEntries(['document', 'window', 'HTMLImageElement', 'HTMLVideoElement', '__cameraIntegrityMock'].map(key => [key, globalThis[key]]))
  context.after(() => Object.assign(globalThis, previous))
  globalThis.window = { setTimeout: () => 1 }
  globalThis.HTMLImageElement = class {}
  globalThis.HTMLVideoElement = class {}
  globalThis.document = { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,thumbnail' }) }
}
const runtime = (id, extra = {}) => ({ view: { id, name: id, kind: 'camera', status: 'live', n: 1, dets: [], snapshot: `data:${id}`, ...extra }, el: null, inFlight: false })

test('read-only capture preserves the picture and revocation rejects deferred inference work', async context => {
  installDom(context)
  const callbacks = []
  let requests = 0
  let settle
  globalThis.document.createElement = () => ({
    getContext: () => ({ drawImage() {}, getImageData: () => ({ data: Uint8ClampedArray.from([12, 24, 36, 255]) }) }),
    toDataURL: () => 'data:image/jpeg;base64,authorized-preview',
    toBlob: callback => callbacks.push(callback),
  })
  globalThis.__cameraIntegrityMock = {
    detectFrame: () => { requests++; return new Promise((resolve, reject) => { settle = { resolve, reject } }) },
  }
  const engine = new Engine()
  // Camera-integrity algorithms have their own tests above. This test exercises
  // the real capture/async inference path with an explicitly readable picture.
  engine.watchLoop = engine.judgeFrame = engine.showView = () => {}
  const rt = runtime('readable-camera')
  rt.el = new globalThis.HTMLImageElement()
  const frame = Object.assign(new globalThis.HTMLImageElement(), { naturalWidth: 160, naturalHeight: 90 })
  engine.rts.set(rt.view.id, rt)
  const assertNoInference = () => {
    assert.deepEqual(rt.view.dets, [])
    assert.equal(engine.dets.size, 0)
    assert.deepEqual(engine.cov, [])
    assert.equal(engine.frames, 0)
    assert.equal(engine.complianceEnabled, false)
  }

  engine.inferenceEnabled = false
  engine.capture(rt, frame)
  assert.equal(rt.view.snapshot, 'data:image/jpeg;base64,authorized-preview')
  assert.equal(rt.el.src, rt.view.snapshot, 'read-only permission must retain the authorized camera picture')
  assert.equal(requests, 0)
  assert.equal(callbacks.length, 0, 'read-only previews must not encode an inference upload')
  assertNoInference()

  engine.inferenceEnabled = true
  engine.capture(rt, frame)
  assert.equal(callbacks.length, 1)
  engine.inferenceEnabled = false
  callbacks.shift()(new Blob(['frame']))
  assert.equal(requests, 0, 'revocation before image encoding finishes must block the request')
  assert.equal(rt.inFlight, false)
  assertNoInference()

  engine.inferenceEnabled = true
  engine.capture(rt, frame)
  callbacks.shift()(new Blob(['frame']))
  assert.equal(requests, 1)
  engine.inferenceEnabled = false
  settle.resolve({ model_ready: true, compliance_enabled: true, evaluable_classes: ['excavator'], detections: [{ raw_label: 'excavator', canonical_code: 'MACHINERY_EXCAVATOR', confidence: .99, x1: 0, y1: 0, x2: 1, y2: 1 }] })
  await new Promise(resolve => setImmediate(resolve))
  assertNoInference()
  assert.equal(engine.model, 'unknown', 'an old inference response cannot change the read-only model state')

  engine.inferenceEnabled = true
  engine.capture(rt, frame)
  callbacks.shift()(new Blob(['frame']))
  engine.inferenceEnabled = false
  settle.reject(new Error('obsolete inference failure'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(engine.model, 'unknown', 'an old inference failure cannot replace the read-only preview with a model error')
  assertNoInference()
})

test('looped or displaced camera history cannot establish equipment presence, an episode or event evidence', context => {
  installDom(context)
  const engine = new Engine()
  engine.rts.set('healthy', runtime('healthy'))
  engine.rts.set('loop', runtime('loop', { loop: { looped: true } }))
  engine.rts.set('turned', runtime('turned', { view: { state: 'changed' } }))
  engine.dets.set('excavator', [{ src: 'healthy', at: 1000, c: .8 }, { src: 'loop', at: 2000, c: .99 }, { src: 'turned', at: 3000, c: .99 }])
  engine.dets.set('dump_truck', [{ src: 'loop', at: 2000, c: .99 }])
  engine.cov = [[1000, 3000]]
  const observation = engine.snapshot()
  assert.deepEqual(observation.seenWithin('excavator', 3500, 3000), [{ src: 'healthy', c: .8 }])
  assert.equal(observation.lastSeen('excavator', 3500), 1000)
  assert.equal(observation.episodeStart('excavator', 3500, 5000), 1000)
  assert.deepEqual(observation.presence('excavator'), [[1000, 1000]])
  assert.deepEqual(observation.seenWithin('dump_truck', 3500, 3000), [])
  assert.equal(observation.lastSeen('dump_truck', 3500), null)
  assert.deepEqual(engine.liveSnapshots().map(source => source.id), ['healthy'])
  engine.rts.delete('healthy')
  assert.deepEqual(engine.snapshot().coverage(), [])
})

test('integrity blocking and recovery reset qualified equipment coverage while preserving loop and reference detectors', context => {
  installDom(context)
  const engine = new Engine()
  const rt = runtime('camera', { view: { state: 'ok', refUrl: '/reference' } })
  engine.rts.set('camera', rt)
  const reference = { url: '/reference', ref: {}, moveUntil: Date.now() + 60_000 }
  engine.viewRefs.set('camera', reference)
  engine.viewTracks.set('camera', { state: 'ok', url: '/reference' })
  const detector = { push: () => ({ looped: true, period: 40_000 }) }
  engine.loops.set('camera', detector)
  const seed = () => { engine.cov = [[1000, 5000]]; engine.dets.set('excavator', [{ src: 'camera', at: 5000, c: .9 }]) }
  seed()
  engine.showView(rt)
  assert.equal(rt.view.view.state, 'move')
  assert.deepEqual(engine.cov, [])
  assert.equal(engine.dets.size, 0)
  assert.equal(engine.loops.get('camera'), detector)
  assert.equal(engine.viewRefs.get('camera'), reference)
  reference.moveUntil = Date.now() - 1
  seed()
  engine.showView(rt)
  assert.equal(rt.view.view.state, 'ok')
  assert.deepEqual(engine.cov, [])
  seed()
  engine.watchLoop(rt, {}, new Uint8ClampedArray([1, 2, 3, 255]), 6000)
  assert.equal(rt.view.loop.looped, true)
  assert.deepEqual(engine.cov, [])
  detector.push = () => ({ looped: false })
  seed()
  engine.watchLoop(rt, {}, new Uint8ClampedArray([1, 2, 3, 255]), 7000)
  assert.equal(rt.view.loop, undefined)
  assert.deepEqual(engine.cov, [])
})

test('reference polling retries a transient failure and closes image bitmaps even after the reference changes', async context => {
  installDom(context)
  const engine = new Engine()
  engine.featuresOf = () => ({ verified: true })
  let calls = 0
  let closed = 0
  globalThis.__cameraIntegrityMock = { viewImage: async () => { calls++; if (calls === 1) throw new Error('temporary outage'); return { width: 1, height: 1, close: () => closed++ } } }
  const state = { camera_id: 'camera', reference: { url: '/same-reference' } }
  engine.setViews([state])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(engine.viewRefs.get('camera').failed, true)
  engine.setViews([state])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 2)
  assert.deepEqual(engine.viewRefs.get('camera').ref, { verified: true })
  assert.equal(closed, 1)
  let resolveBitmap
  globalThis.__cameraIntegrityMock.viewImage = () => new Promise(resolve => { resolveBitmap = resolve })
  engine.setViews([{ ...state, reference: { url: '/pending-reference' } }])
  engine.setViews([])
  resolveBitmap({ width: 1, height: 1, close: () => closed++ })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(closed, 2)
  assert.equal(engine.viewRefs.size, 0)
})

test('protected camera pictures use header authorization; external or malformed asset links cannot receive credentials', async context => {
  const previous = globalThis.fetch
  context.after(() => { globalThis.fetch = previous })
  const credentials = dataUrl('export const API_PREFIX="/api/v1"; export const API_BASE_URL=""; export const getStoredToken=()=>"camera-secret"; export const getAuthHeaders=()=>({Authorization:"Bearer camera-secret"}); export const setStoredToken=()=>{}')
  const api = await import(await moduleUrl('../src/sverka/api.ts', { '../api/stroyControlApi': credentials }))
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('reference-picture') }
  const asset = '/api/v1/projects/object/cameras/camera/view/assets/' + 'a'.repeat(64)
  assert.equal(await (await api.viewAsset(asset)).text(), 'reference-picture')
  assert.equal(calls[0].url, asset)
  assert.equal(calls[0].init.headers.Authorization, 'Bearer camera-secret')
  await api.viewAsset('/media/legacy-reference.jpg')
  assert.deepEqual(calls[1].init.headers, { Authorization: 'Bearer camera-secret' })
  for (const unsafe of ['https://outside.example' + asset, asset + '?token=x', '/api/v1/projects/object/cameras/camera/view/assets/../private', '/api/v1/projects/object/cameras/camera/view/assets/..']) await assert.rejects(api.viewAsset(unsafe), /недопустима/)
  assert.equal(calls.length, 2)
})

test('saved camera transport authenticates camera identity and closes MJPEG after one bounded complete JPEG', async context => {
  const previousFetch = globalThis.fetch, previousImage = globalThis.Image
  context.after(() => { globalThis.fetch = previousFetch; if (previousImage === undefined) delete globalThis.Image; else globalThis.Image = previousImage })
  const credentials = dataUrl('export const API_PREFIX="/api/v1"; export const API_BASE_URL=""; export const getStoredToken=()=>"camera-secret"; export const getAuthHeaders=()=>({Authorization:"Bearer camera-secret","X-Project-Assignment":"assignment"}); export const setStoredToken=()=>{}')
  const api = await import(await moduleUrl('../src/sverka/api.ts', { '../api/stroyControlApi': credentials }))
  globalThis.Image = class { set src(value) { this.url = value; queueMicrotask(() => this.onload?.()) } }
  let closed = false; const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    const stream = new ReadableStream({ start(controller) { controller.enqueue(Uint8Array.from([1, 2, 255])); controller.enqueue(Uint8Array.from([216, 8, 9, 255, 217])); }, cancel() { closed = true } })
    return new Response(stream, { headers: { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' } })
  }
  const image = await api.grabFrame('persisted-camera')
  assert.match(image.url, /^blob:/)
  assert.equal(closed, true)
  assert.equal(calls[0].url, '/api/v1/videos/proxy-stream?camera_id=persisted-camera')
  assert.equal(calls[0].init.headers.Authorization, 'Bearer camera-secret')
  assert.equal(calls[0].init.headers['X-Project-Assignment'], 'assignment')
  assert.equal(calls[0].url.includes('url='), false)
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ status: 'online', message: 'Кадр получен' }) }
  assert.equal((await api.probeCamera('persisted-camera')).ok, true)
  assert.equal(calls[1].url, '/api/v1/videos/check-stream?camera_id=persisted-camera')
})
