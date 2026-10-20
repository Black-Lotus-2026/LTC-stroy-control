import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/api/stroyControlApi.ts', import.meta.url), 'utf8')
let serial = 0
async function clientFor(envUrl, pageUrl) {
  if (pageUrl === undefined) delete globalThis.window
  else globalThis.window = { location: new URL(pageUrl) }
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText.replaceAll('import.meta.env', JSON.stringify({ VITE_API_URL: envUrl }))
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#origin-${++serial}`)
}

function restoreWindow(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else delete globalThis.window })
}

test('same-origin uses the actual browser origin including HTTPS, non-default ports and localhost identity', async t => {
  restoreWindow(t)
  for (const page of ['https://stroycontrol.pro/dashboard?project=1', 'https://stroycontrol.pro:8443/ui/', 'http://localhost:5193/']) {
    const client = await clientFor('same-origin', page)
    assert.equal(client.API_BASE_URL, new URL(page).origin)
    assert.equal(client.API_PREFIX, `${new URL(page).origin}/api/v1`)
  }
})

test('same-origin auth transport targets the reverse-proxied API rather than a literal relative sentinel', async t => {
  restoreWindow(t)
  const previous = globalThis.fetch; t.after(() => { globalThis.fetch = previous })
  const calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ access_token: 'isolated-test-token', token_type: 'bearer' }) }
  const client = await clientFor('same-origin', 'https://stroycontrol.pro/login')
  await client.loginUser({ username: 'isolated-qa', password: 'synthetic-test-only' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://stroycontrol.pro/api/v1/auth/login')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { username: 'isolated-qa', password: 'synthetic-test-only' })
})

test('explicit API origins and the existing development fallback retain their behavior', async t => {
  restoreWindow(t)
  assert.equal((await clientFor('http://localhost:8991', 'https://frontend.example/')).API_BASE_URL, 'http://127.0.0.1:8991')
  assert.equal((await clientFor('https://api.example:9443', 'https://frontend.example/')).API_BASE_URL, 'https://api.example:9443')
  assert.equal((await clientFor(undefined, 'http://localhost:5193/')).API_BASE_URL, 'http://127.0.0.1:8000')
  assert.equal((await clientFor(undefined, undefined)).API_BASE_URL, 'http://127.0.0.1:8000')
  assert.equal((await clientFor('same-origin', undefined)).API_PREFIX, '/api/v1')
})
