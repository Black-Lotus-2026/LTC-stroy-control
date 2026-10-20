import { expect, test, type Page } from '@playwright/test'

const projectId = '90000000-0000-4000-8000-000000000001'
const user = { id: '90000000-0000-4000-8000-000000000002', username: 'live-tester', role: 'viewer' }
const context = {
  project_id: projectId, project_name: 'Общий демо-объект', organization_id: null,
  membership_id: null, participation_id: null, assignment_id: null,
  organization_name: 'Демонстрация', role: 'project_viewer', side: 'customer',
  scope: { kind: 'project' }, authorization_version: 1, is_demo: true,
  lifecycle: 'active', effective_permissions: ['project.read', 'camera.read', 'video.read', 'incident.read'],
}
const frame = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#43584b"/></svg>')
const observation = (channel: number) => ({
  channel, captured_at: new Date().toISOString(), frame, inference_ms: 123,
  analysis_error: null,
  analysis: { model_ready: true, detector_status: 'ready', source: 'yolo', detections: [{ raw_label: 'excavator', canonical_code: 'MACHINERY_EXCAVATOR', label_ru: 'Экскаватор', confidence: 0.91, x1: 0.1, y1: 0.2, x2: 0.6, y2: 0.8 }] },
})

async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem('stroy_control_token', 'synthetic-browser-token'))
  await page.route('**/api/v1/**', route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '')
    const json = (body: unknown, status = 200) => route.fulfill({ json: body, status })
    if (path === '/auth/me') return json(user)
    if (path === '/auth/contexts') return json([context])
    if (path === '/projects') return json([{ id: projectId, code: 'MANAGEMENT-DEMO', name: 'Общий демо-объект', owner_username: null }])
    if (path === '/videos/detector-status') return json({ ready: false })
    if (path === '/live-demo/config') return json({ enabled: true, cameras: [{ channel: 1, name: 'Camera 2' }, { channel: 2, name: 'Camera 3' }], analysis_interval_ms: 2000 })
    if (/\/live-demo\/\d+\/analyze/.test(path)) return json(observation(Number(path.split('/')[2])))
    if (path.endsWith('/weather')) return json({ detail: 'Not configured' }, 404)
    return json([])
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Открыть демонстрацию', exact: true }).click()
  await page.getByRole('button', { name: 'Live-камеры MyVMS', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Прямой эфир со стройплощадки' })).toBeVisible()
}

test('live demo renders analyzed frame, pauses, switches cameras and closes polling', async ({ page }) => {
  let calls = 0
  await setup(page)
  page.on('request', request => { if (request.url().includes('/live-demo/') && request.url().includes('/analyze')) calls++ })
  await expect(page.locator('.myvms-box')).toContainText('Экскаватор · 91%')
  await expect(page.getByRole('complementary', { name: 'Результаты live-анализа' })).toContainText('Экскаватор')
  await page.getByRole('button', { name: 'Пауза анализа', exact: true }).click()
  await expect(page.locator('.myvms-box')).toHaveCount(0)
  await expect(page.locator('.myvms-frame-label')).toContainText('пауза')
  const stopped = calls
  await page.waitForTimeout(2300)
  expect(calls).toBe(stopped)
  await page.getByLabel('Live-камера MyVMS').selectOption('2')
  await expect(page.getByRole('img', { name: 'Кадр Camera 3 для анализа' })).toBeVisible()
  await expect(page.locator('.myvms-box')).toHaveCount(1)
  await page.getByRole('button', { name: 'Исторические источники', exact: true }).click()
  await expect(page.locator('.myvms-demo')).toHaveCount(0)
  const closed = calls
  await page.waitForTimeout(2300)
  expect(calls).toBe(closed)
})

test('upstream failure clears stale detections and does not report false zero', async ({ page }) => {
  await setup(page)
  await expect(page.locator('.myvms-box')).toHaveCount(1)
  await page.route('**/live-demo/1/analyze?**', route => route.fulfill({ status: 502, json: { detail: 'Камера сейчас недоступна' } }))
  await expect(page.getByRole('alert').filter({ hasText: 'Камера сейчас недоступна' })).toBeVisible()
  await expect(page.locator('.myvms-box')).toHaveCount(0)
  await expect(page.getByRole('complementary', { name: 'Результаты live-анализа' })).toContainText('Ожидаем успешный анализ')
})

test('camera switch ignores a late response from the previous camera', async ({ page }) => {
  await setup(page)
  await expect(page.locator('.myvms-box')).toHaveCount(1)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  await page.route('**/live-demo/1/analyze?**', async route => {
    await gate
    await route.fulfill({ json: { ...observation(1), frame: 'data:image/jpeg;base64,old-camera' } }).catch(() => undefined)
  })
  await page.waitForRequest('**/live-demo/1/analyze?**')
  await page.getByLabel('Live-камера MyVMS').selectOption('2')
  await expect(page.getByRole('img', { name: 'Кадр Camera 3 для анализа' })).toBeVisible()
  release()
  await expect(page.locator('.myvms-frame img')).not.toHaveAttribute('src', 'data:image/jpeg;base64,old-camera')
})
