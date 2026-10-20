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
    if (path === '/auth/login') return json(route, { user, access_token: 'browser-test' })
    if (path === '/projects') return json(route, projects)
    if (path === '/incidents') return json(route, [incident(url.searchParams.get('project_id')!)])
    if (path === '/incidents/config') return json(route, { violation_evaluation_window_seconds: 30 })
    if (path === '/videos/detector-status') return json(route, { ready: false })
    if (path.endsWith('/configuration')) return json(route, { can_manage: true, cameras: [{ id: 'camera-a', name: 'Камера a' }], responsibles: [user] })
    if (path === '/safety/catalog') return json(route, { documents: [], requirements: [], sanctions: [] })
    if (path.endsWith('/alert-settings')) return json(route, { project_id: 'a', owner_username: user.username, alert_error_deadline_minutes: 30, alert_warning_deadline_minutes: 60 })
    if (path.endsWith('/inaction-cost')) return json(route, { detail: 'Нет исходных данных для расчёта' }, 422)
    if (path.endsWith('/probabilities')) return json(route, { stage_id: path.split('/')[3], probabilities: [] })
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
  await expect(page.locator('.intro')).toHaveCount(0)
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
  await page.getByLabel('Логин', { exact: true }).fill('tester')
  await page.getByLabel('Пароль', { exact: true }).fill('test-password')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('button', { name: 'Начать работу', exact: true }).click()
  await expect(page.locator('.q-list')).toContainText('Отклонение A')
  await expect(pools).toHaveCount(1)
})

test('session server failures are visible without discarding the stored token', async ({ page }) => {
  await mockApi(page)
  await page.route('**/api/v1/auth/me', route => json(route, { detail: 'Сервис авторизации временно недоступен' }, 503))
  await page.goto('/')
  await expect(page.getByText('Сервис авторизации временно недоступен', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('stroy_control_token'))).toBe('browser-test')
  await page.getByLabel('Логин', { exact: true }).fill('tester')
  await page.getByLabel('Пароль', { exact: true }).fill('test-password')
  await page.getByRole('button', { name: 'Войти', exact: true }).click()
  await page.getByRole('button', { name: 'Начать работу', exact: true }).click()
  await page.getByRole('button', { name: 'Пользователь tester' }).click()
  await page.getByRole('menuitem', { name: 'Выйти', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible()
  await expect(page.getByText('Сервис авторизации временно недоступен', { exact: true })).toHaveCount(0)
})

test('expired authentication clears the invalid token', async ({ page }) => {
  await mockApi(page)
  await page.route('**/api/v1/auth/me', route => json(route, { detail: 'Сессия истекла' }, 401))
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('stroy_control_token'))).toBe(null)
})

test('a superseded session check cannot hide an already authenticated screen', async ({ page }) => {
  await mockApi(page)
  let first: Route | undefined
  await page.route('**/api/v1/auth/me', route => {
    if (!first) { first = route; return }
    return json(route, user)
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Начать работу', exact: true })).toBeVisible()
  await json(first!, { detail: 'Запоздавшая ошибка сессии' }, 503)
  await page.waitForTimeout(250)
  await expect(page.getByRole('button', { name: 'Начать работу', exact: true })).toBeVisible()
})

test('legacy query entry can return to the new interface', async ({ page }) => {
  await mockApi(page)
  await page.goto('/?legacy=1')
  await page.getByRole('link', { name: 'Новый интерфейс →' }).click()
  await expect(page.getByRole('button', { name: 'Начать работу', exact: true })).toBeVisible()
  expect(new URL(page.url()).searchParams.has('legacy')).toBe(false)
})

for (const width of [1280, 390]) {
  test(`workspace, settings, plan and journal work at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewportSize({ width, height: 844 })
    await mockApi(page)
    await enter(page)
    await expect(page.locator('.frame:not(.empty)')).toHaveCSS('background-color', 'rgb(7, 8, 10)')
    await expect(page.locator('.f-state .msg strong')).toHaveCSS('color', 'rgb(242, 239, 233)')
    await page.screenshot({ path: testInfo.outputPath('workspace.png'), fullPage: true })
    await page.getByRole('button', { name: 'Настройки контроля', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: 'Настройки контроля', exact: true })
    await expect(sheet).toBeVisible()
    for (const name of ['Источники', 'Безопасность', 'Фото', 'Смена', 'Задачи', 'Объект', 'Контроль']) {
      await sheet.getByRole('tab', { name, exact: true }).click()
      await expect(sheet.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
    }
    await page.screenshot({ path: testInfo.outputPath('settings.png'), fullPage: true })
    await sheet.getByRole('button', { name: 'Закрыть', exact: true }).click()
    await expect(sheet).toHaveCount(0)
    await page.getByRole('button', { name: 'Развернуть план работ', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Свернуть план работ', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Журнал', exact: true }).click()
    const journal = page.locator('.journal')
    await expect(journal).toBeVisible()
    await journal.getByRole('textbox', { name: 'Поиск по журналу' }).fill('Нет такого события')
    await expect(journal.locator('.j-row')).toHaveCount(0)
    await journal.getByRole('button', { name: 'Закрыть журнал' }).click()
    await expect(journal).toHaveCount(0)
    expect(errors).toEqual([])
  })
}

test('mobile header keeps object name, clock and actions in separate areas', async ({ page }, testInfo) => {
  await mockApi(page)
  await page.route('**/api/v1/alerts?*', route => json(route, [{ id: 'alert', title: 'Задача', kind: 'assigned', project_id: 'a', incident_id: 'event-a' }]))
  await enter(page)
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    const bounds = await page.locator('.app > .bar').evaluate(bar => {
      const rect = (el: Element) => {
        const r = el.getBoundingClientRect()
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }
      }
      return {
        name: rect(bar.querySelector('.ctx span')!),
        context: rect(bar.querySelector('.ctx')!),
        brand: rect(bar.querySelector('.brand')!),
        controls: [...bar.children].filter(el => el.getBoundingClientRect().width > 0).map(rect),
      }
    })
    expect(bounds.name.right).toBeLessThanOrEqual(bounds.context.right)
    expect(bounds.brand.width).toBe(32)
    for (const [i, a] of bounds.controls.entries()) {
      expect(a.left).toBeGreaterThanOrEqual(0)
      expect(a.right).toBeLessThanOrEqual(width)
      for (const b of bounds.controls.slice(i + 1)) {
        expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true)
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`header-${width}.png`) })
  }
})

test('photo analysis reports an API failure, retries and filters detections', async ({ page }) => {
  await mockApi(page)
  await page.route('**/api/v1/videos/detect-photo', route => json(route, { detail: 'Распознавание временно недоступно' }, 503))
  await enter(page)
  await page.getByRole('button', { name: 'Настройки контроля', exact: true }).click()
  await page.getByRole('tab', { name: 'Фото', exact: true }).click()
  const photo = page.getByRole('region', { name: 'Проверка фотографии' })
  await photo.locator('input[type=file]').setInputFiles('docs/ui-concept/assets/cam1.webp')
  await photo.getByRole('button', { name: 'Распознать фото' }).click()
  await expect(photo.getByRole('alert')).toContainText('Распознавание временно недоступно')
  await page.route('**/api/v1/videos/detect-photo', route => json(route, {
    model_ready: true, source: 'yolo', detections: [{ raw_label: 'excavator', label_ru: 'Экскаватор', confidence: .75, x1: .1, y1: .2, x2: .4, y2: .6 }],
  }))
  await photo.getByRole('button', { name: 'Распознать фото' }).click()
  await expect(photo.getByRole('status')).toContainText('рамок выше порога: 1 из 1')
  await photo.getByRole('slider', { name: 'Порог уверенности на фото' }).press('End')
  await expect(photo.getByRole('status')).toContainText('рамок выше порога: 0 из 1')
})

test('failed incident decisions show the server error and keep the event pending', async ({ page }) => {
  await mockApi(page)
  await page.route('**/api/v1/incidents/event-a/status', route => json(route, { detail: 'Не удалось сохранить решение' }, 503))
  await enter(page)
  await page.locator('.q-card').first().click()
  const dialog = page.locator('.case')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: /^Подтвердить/ }).click()
  await expect(dialog.getByText(/Не удалось сохранить решение/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click()
  await expect(page.locator('.q-list')).toContainText('Отклонение A')
})
