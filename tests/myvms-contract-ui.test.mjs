import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

async function moduleUrl(path, imports = {}) {
  let source = ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText
  for (const [name, replacement] of Object.entries(imports)) source = source.replaceAll(`'${name}'`, JSON.stringify(replacement)).replaceAll(`"${name}"`, JSON.stringify(replacement))
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}
const generated = await moduleUrl('../src/api/generated/customerControl.ts')
const transport = `data:text/javascript,export const req=(...args)=>globalThis.__myvmsContractRequest(...args)`
const origin = `data:text/javascript,export const API_BASE_URL='https://application.invalid'`
const client = await import(await moduleUrl('../src/sverka/liveDemoApi.ts', {
  './api': transport, '../api/stroyControlApi': origin, '../api/generated/customerControl': generated,
}))
const signal = new AbortController().signal
const project = '00000000-0000-0000-0000-000000000001'

test('live client uses the generated Pydantic decoder for each response', async () => {
  for (const [call, response] of [
    [() => client.liveConfig(project, signal), { enabled: true, cameras: [{ channel: -1, name: 'invalid' }], analysis_interval_ms: 2000 }],
    [() => client.analyzeLive(project, 1, signal), { channel: 1, captured_at: '2026-10-20T10:00:00Z', frame: 'data:image/jpeg;base64,/9j/2Q==', analysis: {}, analysis_error: null, inference_ms: 1 }],
    [() => client.liveSession(project, 1, signal), { media_url: 'https://foreign.invalid/stream', expires_in: 300 }],
  ]) {
    globalThis.__myvmsContractRequest = async () => response
    await assert.rejects(call, /Неверный ответ API/)
  }
})

test('a valid unavailable inference remains unknown and session URL stays scoped', async () => {
  const observation = { channel: 1, captured_at: '2026-10-20T10:00:00Z', frame: 'data:image/jpeg;base64,/9j/2Q==', analysis: null, analysis_error: 'YOLO unavailable', inference_ms: 1 }
  globalThis.__myvmsContractRequest = async () => observation
  assert.deepEqual(await client.analyzeLive(project, 1, signal), observation)
  const media = `/api/v1/live-demo/1/stream?project_id=${project}`
  globalThis.__myvmsContractRequest = async () => ({ media_url: media, expires_in: 300 })
  assert.equal(await client.liveSession(project, 1, signal), `https://application.invalid${media}`)
})
