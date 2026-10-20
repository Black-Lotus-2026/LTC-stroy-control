import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const dataUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
async function moduleUrl(path, replacements = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  let code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React } }).outputText
  for (const [from, to] of Object.entries(replacements)) code = code.replaceAll(`'${from}'`, `'${to}'`)
  return dataUrl(code)
}
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

test('engine drops stale camera/status responses and releases their resources', async context => {
  const saved = Object.fromEntries(['document', 'window', 'HTMLImageElement', 'HTMLVideoElement'].map(k => [k, globalThis[k]]))
  context.after(() => { Object.assign(globalThis, saved); delete globalThis.__engineApi })
  globalThis.document = { createElement: () => ({}) }
  globalThis.window = { setTimeout }
  globalThis.HTMLImageElement = class {}
  globalThis.HTMLVideoElement = class {}
  const frame = deferred()
  const status = deferred()
  const reference = deferred()
  globalThis.__engineApi = { grabFrame: () => frame.promise, detectorStatus: () => status.promise, viewImage: () => reference.promise }
  const mock = dataUrl('export const grabFrame=(...a)=>globalThis.__engineApi.grabFrame(...a); export const detectorStatus=()=>globalThis.__engineApi.detectorStatus(); export const viewImage=(...a)=>globalThis.__engineApi.viewImage(...a);')
  const { Engine } = await import(await moduleUrl('../src/sverka/engine.ts', {
    './api': mock,
    '../domain/constructionObservations': await moduleUrl('../src/domain/constructionObservations.ts'),
    './lib/machinery': await moduleUrl('../src/sverka/lib/machinery.tsx'),
    './lib/view': await moduleUrl('../src/sverka/lib/view.ts'),
    './lib/loop': await moduleUrl('../src/sverka/lib/loop.ts'),
  }))
  const engine = new Engine()
  const rt = { view: { id: 'camera', url: 'http://camera', status: 'live' }, el: null, inFlight: false }
  engine.rts.set('camera', rt)
  let captured = 0, released = false, closed = false
  engine.capture = () => { captured++ }
  const pulling = engine.pullFrame(rt)
  const polling = engine.pollStatus()
  const loading = engine.loadRef('camera', '/old-reference')
  engine.reset()
  engine.rts.set('camera', { ...rt })
  frame.resolve({ removeAttribute: name => { released = name === 'src' } })
  status.resolve({ ready: true, compliance_enabled: true, evaluable_classes: ['excavator'] })
  reference.resolve({ close: () => { closed = true } })
  await Promise.all([pulling, polling, loading])
  assert.equal(captured, 0, 'frames requested before reset must never enter the new observation session')
  assert.equal(released, true, 'discarding a frame must still close its stream')
  assert.equal(closed, true, 'obsolete reference bitmaps must be released')
  assert.equal(engine.model, 'unknown', 'a previous status response must not revive a reset engine')
  assert.equal(engine.complianceEnabled, false)
  let poolRemoved = false
  engine.pool = { remove: () => { poolRemoved = true } }
  engine.dispose()
  assert.equal(poolRemoved, true)
  assert.equal(engine.emitPending, 0)
})
