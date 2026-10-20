import { expect, test, type Page, type Route } from '@playwright/test'
import type { ContextDTO, CustomerIncidentDTO, IncidentDetailDTO, ParticipantOptionsDTO } from '../../src/api/generated/customerControl'

type Site = 'a' | 'b'
const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const ids = { a: { project: uuid(1), assignment: uuid(11), event: uuid(21), camera: uuid(31), stage: uuid(41), area: uuid(51) }, b: { project: uuid(2), assignment: uuid(12), event: uuid(22), camera: uuid(32), stage: uuid(42), area: uuid(52) } }
// Global viewer accounts acquire project powers only through explicit server contexts.
const user = { id: uuid(101), username: 'tester', role: 'viewer' }
const sites: Site[] = ['a', 'b']
const projects = sites.map(site => ({ id: ids[site].project, name: `Объект ${site.toUpperCase()}`, code: site, owner_username: user.username }))
const contexts: ContextDTO[] = sites.map((site, index) => ({
  organization_id: uuid(201), membership_id: uuid(202), participation_id: uuid(203 + index),
  assignment_id: ids[site].assignment, project_id: ids[site].project,
  organization_name: 'Тестовый заказчик', project_name: `Объект ${site.toUpperCase()}`,
  role: 'customer_manager', side: 'customer', scope: { kind: 'project' },
  authorization_version: 1, is_demo: false, lifecycle: 'active',
  effective_permissions: ['project.read', 'camera.read', 'camera.configure', 'video.read', 'video.upload', 'video.analyze', 'incident.read', 'incident.confirm', 'incident.assign', 'incident.deadline', 'document.read', 'document.upload', 'document.analyze', 'requirement.edit', 'control.submit', 'control.approve', 'control.publish', 'control.retire', 'assignment.manage', 'report.read', 'report.create', 'evidence.read'],
}))
const siteFor = (projectId: string | null): Site => projectId === ids.b.project ? 'b' : 'a'
const incident = (site: Site) => ({
  id: ids[site].event, project_id: ids[site].project, code: `INC-${site}`, title: `Отклонение ${site.toUpperCase()}`,
  severity: 'ERROR', discrepancy_type: 'MISSING_MANDATORY', machinery_type: 'Экскаватор',
  status: 'pending', created_at: new Date().toISOString(),
})
const customerIncident = (site: Site): CustomerIncidentDTO => ({
  id: ids[site].event, project_id: ids[site].project, code: `INC-${site}`, title: `Отклонение ${site.toUpperCase()}`,
  case_kind: 'construction', status: 'pending', row_version: 1, area_id: ids[site].area,
  responsible_participation_id: null, assignee_assignment_id: null, origin_participation_id: null,
  detected_at: new Date().toISOString(), first_seen_at: new Date().toISOString(),
  reaction_due_at: null, remediation_due_at: null, review_due_at: null, resolution_origin: null,
  verification_status: 'not_requested', view: 'customer', basis: null,
  allowed_actions: ['incident.confirm', 'incident.assign', 'incident.deadline'],
})
const participants = (site: Site): ParticipantOptionsDTO => ({
  participations: [{ id: uuid(site === 'a' ? 301 : 302), name: 'Тестовый подрядчик' }], assignments: [],
  areas: [{ id: ids[site].area, name: 'Тестовая область' }],
})
const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, json: body })

async function mockApi(page: Page) {
  await page.addInitScript(() => localStorage.setItem('stroy_control_token', 'browser-test'))
  await page.route('**/api/v1/**', route => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace('/api/v1', '')
    if (path === '/auth/me') return json(route, user)
    if (path === '/auth/login') return json(route, { user, access_token: 'browser-test' })
    if (path === '/auth/contexts') return json(route, contexts)
    if (path === '/projects') return json(route, projects)
    const projectMatch = path.match(/^\/customer-control\/projects\/([^/]+)\/(incidents|participants)$/)
    if (projectMatch) return json(route, projectMatch[2] === 'incidents' ? [customerIncident(siteFor(projectMatch[1]))] : participants(siteFor(projectMatch[1])))
    if (/^\/customer-control\/incidents\/[^/]+$/.test(path)) {
      const site: Site = path.endsWith(ids.b.event) ? 'b' : 'a'
      const detail: IncidentDetailDTO = { incident: customerIncident(site), evidence: [], submissions: [], disputes: [], history: [] }
      return json(route, detail)
    }
    if (path === '/incidents') return json(route, [incident(siteFor(url.searchParams.get('project_id')))])
    if (path === '/incidents/config') return json(route, { violation_evaluation_window_seconds: 30 })
    if (path === '/videos/detector-status') return json(route, { ready: false })
    if (path.endsWith('/configuration')) return json(route, { can_manage: true, cameras: [{ id: ids.a.camera, name: 'Камера a' }], responsibles: [user] })
    if (path === '/safety/catalog') return json(route, { documents: [], requirements: [], sanctions: [] })
    if (path.endsWith('/alert-settings')) return json(route, { project_id: ids.a.project, owner_username: user.username, alert_error_deadline_minutes: 30, alert_warning_deadline_minutes: 60 })
    if (path.endsWith('/inaction-cost')) return json(route, { detail: 'Нет исходных данных для расчёта' }, 422)
    if (path.endsWith('/probabilities')) return json(route, { stage_id: path.split('/')[3], probabilities: [] })
    if (path === '/schedule/stages') {
      const site = siteFor(url.searchParams.get('project_id'))
      return json(route, [{ id: ids[site].stage, project_id: ids[site].project, name: 'Подготовка', planned_start: '2020-01-01', planned_end: '2020-01-02', order_index: 1 }])
    }
    if (/^\/projects\/[^/]+\/cameras$/.test(path)) {
      const site = siteFor(path.split('/')[2])
      return json(route, [{ id: ids[site].camera, name: `Камера ${site}`, stream_url: 'rtsp://test.invalid/live' }])
    }
    if (path.endsWith('/weather')) return json(route, { detail: 'Unavailable' }, 404)
    return json(route, [])
  })
}

async function enter(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Перейти к решениям', exact: true }).click()
  await expect(page.locator('.ctx').first()).toContainText('Объект A')
  await expect(page.locator('.q-list')).toContainText('Отклонение A')
  await expect(page.locator('.intro')).toHaveCount(0)
}

test('late case response cannot replace events of the newly selected context', async ({ page }) => {
  await mockApi(page)
  await enter(page)
  let release!: () => Promise<void>
  const pending = new Promise<void>(resolve => {
    void page.route(`**/api/v1/customer-control/projects/${ids.a.project}/incidents?**`, async route => {
      release = async () => {
        // Scope changes abort the old request. A browser may discard fulfillment;
        // either outcome must leave the newly selected context untouched.
        try { await json(route, [customerIncident('a')]) } catch (error) {
          if (!(error instanceof Error) || !/closed|canceled|cancelled|aborted/i.test(error.message)) throw error
        }
      }
      resolve()
    })
  })
  await pending // the compact canonical queue refreshes every 30 seconds
  await page.locator('.ctx').first().click()
  await page.getByRole('menuitemradio', { name: /Объект B/ }).click()
  await expect(page.locator('.q-list')).toContainText('Отклонение B')
  await release()
  // Wait for React to consume the late response.
  await page.waitForTimeout(250)
  await expect(page.locator('.q-list')).toContainText('Отклонение B')
  await expect(page.locator('.q-list')).not.toContainText('Отклонение A')
})

test('failed project list is retryable and does not offer to create an empty workspace', async ({ page }) => {
  await mockApi(page)
  await page.route('**/api/v1/projects', route => json(route, { detail: 'Список временно недоступен' }, 503))
  await page.goto('/')
  await page.getByRole('button', { name: 'Перейти к решениям', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Список временно недоступен')
  await expect(page.getByRole('heading', { name: 'Подготовим контроль за четыре шага' })).toHaveCount(0)
  await page.unroute('**/api/v1/projects')
  await page.getByRole('button', { name: 'Повторить загрузку' }).click()
  await expect(page.locator('.q-list')).toContainText('Отклонение A')
})

test('failed project data remains an error until a successful retry', async ({ page }) => {
  await mockApi(page)
  const camerasUrl = `**/api/v1/projects/${ids.a.project}/cameras`
  await page.route(camerasUrl, route => json(route, { detail: 'Камеры временно недоступны' }, 503))
  await page.goto('/')
  await page.getByRole('button', { name: 'Перейти к решениям', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Камеры временно недоступны')
  await page.unroute(camerasUrl)
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
  await page.getByRole('button', { name: 'Перейти к решениям', exact: true }).click()
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
  await page.getByRole('button', { name: 'Перейти к решениям', exact: true }).click()
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
  await expect(page.getByRole('button', { name: 'Перейти к решениям', exact: true })).toBeVisible()
  await json(first!, { detail: 'Запоздавшая ошибка сессии' }, 503)
  await page.waitForTimeout(250)
  await expect(page.getByRole('button', { name: 'Перейти к решениям', exact: true })).toBeVisible()
})

test('legacy query entry opens the standard interface without legacy controls', async ({ page }) => {
  await mockApi(page)
  await page.goto('/?legacy=1')
  await expect(page.getByRole('button', { name: 'Перейти к решениям', exact: true })).toBeVisible()
  expect(new URL(page.url()).searchParams.has('legacy')).toBe(false)
  await expect(page.getByRole('link', { name: 'Новый интерфейс →' })).toHaveCount(0)
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
    await page.getByRole('button', { name: 'Доступные источники', exact: true }).click()
    const sheet = page.getByRole('dialog', { name: 'Настройки контроля', exact: true })
    await expect(sheet).toBeVisible()
    for (const name of ['Источники', 'Безопасность', 'Фото']) {
      await sheet.getByRole('tab', { name, exact: true }).click()
      await expect(sheet.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true')
    }
    for (const name of ['Смена', 'Задачи', 'Объект', 'Контроль']) {
      await expect(sheet.getByRole('tab', { name, exact: true })).toHaveCount(0)
    }
    await page.screenshot({ path: testInfo.outputPath('settings.png'), fullPage: true })
    await sheet.getByRole('button', { name: 'Закрыть', exact: true }).click()
    await expect(sheet).toHaveCount(0)
    await page.getByRole('button', { name: 'Развернуть план работ', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Свернуть план работ', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Escape')
    await expect(page.locator('#planFull')).toHaveAttribute('aria-hidden', 'true')
    await page.getByRole('button', { name: 'Пользователь tester' }).click()
    await page.getByRole('menuitem', { name: /Журнал и акт/ }).click()
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
  await page.getByRole('button', { name: 'Доступные источники', exact: true }).click()
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
  await page.route(`**/api/v1/customer-control/incidents/${ids.a.event}/commands`, route => json(route, { detail: 'Не удалось сохранить решение' }, 503))
  await enter(page)
  await page.locator('.q-card').first().click()
  const dialog = page.locator('.customer-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByLabel('Ответственный подрядчик', { exact: true }).selectOption(uuid(301))
  await dialog.getByLabel('Область ответственности', { exact: true }).selectOption(ids.a.area)
  await dialog.getByLabel('Срок подачи исправления', { exact: true }).fill('2030-01-15T12:00')
  await dialog.getByLabel('Комментарий / описание исправления', { exact: true }).fill('Назначить устранение по подтверждённому основанию.')
  await dialog.getByRole('button', { name: 'Подтвердить и назначить', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('Не удалось сохранить решение')
  await expect(dialog.getByText('Обнаружено системой — требуется проверка', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: 'Закрыть дело', exact: true }).click()
  await expect(page.locator('.q-list')).toContainText('Отклонение A')
})
