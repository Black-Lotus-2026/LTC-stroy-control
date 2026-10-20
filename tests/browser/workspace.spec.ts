import { expect, test, type Page, type Route } from '@playwright/test'

const user = { id: 'admin', username: 'tester', role: 'admin' }
const projects = ['a', 'b'].map(id => ({ id, name: `Объект ${id.toUpperCase()}`, code: id, owner_username: user.username }))
const incident = (id: string) => ({
  id: `event-${id}`, project_id: id, code: `INC-${id}`, title: `Отклонение ${id.toUpperCase()}`,
  severity: 'ERROR', discrepancy_type: 'MISSING_MANDATORY', machinery_type: 'Экскаватор',
  status: 'pending', created_at: new Date().toISOString(),
})
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body })

async function mockApi(page: Page) {
  await page.addInitScript(() => localStorage.setItem('stroy_control_token', 'browser-test'))
  await page.route('**/api/v1/**', route => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace('/api/v1', '')
    if (path === '/auth/me') return json(route, user)
    if (path === '/projects') return json(route, projects)
    if (path === '/incidents') return json(route, [incident(url.searchParams.get('project_id')!)])
    if (path === '/incidents/config') return json(route, { violation_evaluation_window_seconds: 30 })
    if (path === '/videos/detector-status') return json(route, { ready: false })
    if (path === '/schedule/stages') {
      const id = url.searchParams.get('project_id')
      return json(route, [{ id: `stage-${id}`, project_id: id, name: 'Подготовка', planned_start: '2020-01-01', planned_end: '2020-01-02', order_index: 1 }])
    }
    if (/\/projects\/[ab]\/cameras$/.test(path)) {
      const id = path.split('/')[2]
      return json(route, [{ id: `camera-${id}`, name: `Камера ${id}`, stream_url: 'rtsp://test.invalid/live' }])
    }
    if (path.endsWith('/weather')) return json(route, { detail: 'Unavailable' }, 404)
    return json(route, [])
  })
}

async function enter(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Начать работу', exact: true }).click()
  await expect(page.locator('.ctx').first()).toContainText('Объект A')
  await expect(page.locator('.q-list')).toContainText('Отклонение A')
}

test('late journal response cannot replace events of the newly selected project', async ({ page }) => {
  await mockApi(page)
  await enter(page)
  let release!: () => Promise<void>
  const pending = new Promise<void>(resolve => {
    page.route('**/api/v1/incidents?project_id=a&*', async route => {
      release = () => json(route, [incident('a')])
      resolve()
    })
  })
  await pending // the next background refresh, every 15 seconds
  await page.locator('.ctx').first().click()
  await page.getByRole('menuitemradio', { name: /Объект B/ }).click()
  await expect(page.locator('.q-list')).toContainText('Отклонение B')
  const response = page.waitForResponse(url => url.url().includes('/incidents?project_id=a'))
  await release()
  await response
  // Wait for React to consume the late response.
  await page.waitForTimeout(250)
  await expect(page.locator('.q-list')).toContainText('Отклонение B')
  await expect(page.locator('.q-list')).not.toContainText('Отклонение A')
})

test('failed project list is retryable and does not offer to create an empty workspace', async ({ page }) => {
  await mockApi(page)
  await page.route('**/api/v1/projects', route => json(route, { detail: 'Список временно недоступен' }, 503))
  await page.goto('/')
  await page.getByRole('button', { name: 'Начать работу', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Список временно недоступен')
  await expect(page.getByRole('heading', { name: 'Подготовим контроль за четыре шага' })).toHaveCount(0)
  await page.unroute('**/api/v1/projects')
  await page.getByRole('button', { name: 'Повторить загрузку' }).click()
  await expect(page.locator('.q-list')).toContainText('Отклонение A')
})

test('failed project data remains an error until a successful retry', async ({ page }) => {
  await mockApi(page)
  await page.route('**/api/v1/projects/a/cameras', route => json(route, { detail: 'Камеры временно недоступны' }, 503))
  await page.goto('/')
  await page.getByRole('button', { name: 'Начать работу', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Камеры временно недоступны')
  await page.unroute('**/api/v1/projects/a/cameras')
  await page.getByRole('button', { name: 'Повторить загрузку' }).click()
  await expect(page.locator('.q-list')).toContainText('Отклонение A')
})

test('logout removes the engine media pool and allows signing in again', async ({ page }) => {
  await mockApi(page)
  await enter(page)
  const pools = page.locator('body > div[aria-hidden="true"]')
  await expect(pools).toHaveCount(1)
  await page.getByRole('button', { name: 'Пользователь tester' }).click()
  await page.getByRole('menuitem', { name: 'Выйти', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible()
  await expect(pools).toHaveCount(0)
})
