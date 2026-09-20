import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir } from 'node:fs/promises'

const base = process.env.DASHBOARD_TEST_URL ?? 'http://127.0.0.1:3194'
const control = process.env.DASHBOARD_TEST_CONTROL_URL ?? 'http://127.0.0.1:3195'
for (const value of [base, control]) { const url = new URL(value); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1') }
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')

test('settings persist, isolate accounts, and preserve edits on failure with responsive navigation', { timeout: 120_000 }, async t => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] })
  let release = () => {}
  t.after(async () => { release(); await browser.close() })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } }), page = await context.newPage(), errors = []
  await context.addInitScript(() => {
    window.notificationAlerts = []
    window.notificationPermissionRequests = 0
    window.Notification = class {
      static permission = 'default'
      static async requestPermission() { window.notificationPermissionRequests++; this.permission = 'granted'; return this.permission }
      constructor(title, options) { this.title = title; this.options = options; window.notificationAlerts.push(this) }
      close() { this.onclose?.() }
    }
  })
  page.on('pageerror', error => errors.push(error.message))
  const signIn = async (client, email) => {
    assert.equal((await client.request.post(base + '/api/auth/email-otp/send-verification-otp', { headers: { origin: base }, data: { email, type: 'sign-in' } })).status(), 200)
    const sends = await (await client.request.get(control + '/sends')).json()
    const otp = sends.filter(message => message.to.includes(email)).at(-1).text.match(/\b\d{6}\b/)[0]
    assert.equal((await client.request.post(base + '/api/auth/sign-in/email-otp', { headers: { origin: base }, data: { email, otp, name: 'Michael Shimeles' } })).status(), 200)
  }
  await signIn(context, 'owner@example.net')
  await page.goto(base + '/app#/settings')
  const organization = page.locator('#organization-name'), profile = page.locator('#profile-name')
  await organization.waitFor()
  assert.equal(await organization.inputValue(), 'Your workspace')
  assert.equal(await page.locator('#settings').getAttribute('aria-current'), 'page')
  assert.equal(await page.locator('#settings-email').getAttribute('readonly'), '')
  assert.equal(await page.locator('#organization-form button').isDisabled(), true)

  await page.route('**/api/rpc/updateSettings', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Settings temporarily unavailable' }) }))
  await organization.fill('  Goshen Labs  ')
  await page.locator('#organization-form button').click()
  await page.getByText('Settings temporarily unavailable', { exact: true }).waitFor()
  assert.equal(await organization.inputValue(), '  Goshen Labs  ')
  assert.equal(await page.locator('#workspace-breadcrumb').textContent(), 'Your workspace')
  assert.ok(await page.locator('#workspace-breadcrumb').evaluate(element => element.getBoundingClientRect().width > 8), 'Organization name stays visible in the header')
  await page.unroute('**/api/rpc/updateSettings')
  await profile.fill('Michael S.')
  await page.locator('#organization-form button').click()
  await page.getByText('Organization name saved.', { exact: true }).waitFor()
  assert.equal(await organization.inputValue(), 'Goshen Labs')
  assert.equal(await profile.inputValue(), 'Michael S.', 'Saving the workspace preserves an unsaved profile edit')
  assert.equal(await page.locator('#workspace-breadcrumb').textContent(), 'Goshen Labs')
  assert.ok(await page.locator('#workspace-breadcrumb').evaluate(element => element.getBoundingClientRect().width > 8), 'Saved organization name stays visible in the header')
  await page.locator('#profile-form button').click()
  await page.getByText('Profile name saved.', { exact: true }).waitFor()
  assert.equal(await page.locator('#account-name').textContent(), 'Michael S.')
  assert.equal(await page.locator('#account-menu-name').textContent(), 'Michael S.')

  let requests = 0, requested
  const started = new Promise(resolve => { requested = resolve })
  const pending = new Promise(resolve => { release = resolve })
  await page.route('**/api/rpc/updateSettings', async route => { requests++; requested(); await pending; await route.continue() })
  await organization.fill('Boring Computers')
  await page.locator('#organization-form button').click()
  await started
  assert.equal(await page.locator('#organization-form button').isDisabled(), true)
  assert.equal(await profile.isDisabled(), true)
  await page.locator('#organization-form').evaluate(form => form.requestSubmit())
  assert.equal(requests, 1, 'A pending save cannot be submitted twice')
  await page.locator('[data-page=inboxes]').click()
  await page.locator('#settings').click()
  await page.locator('#settings-loading').waitFor()
  assert.equal(await organization.isVisible(), false)
  release()
  await organization.waitFor()
  assert.equal(await organization.inputValue(), 'Boring Computers', 'Reopening waits for the pending save before reading settings')
  await page.unroute('**/api/rpc/updateSettings')
  await page.reload()
  await organization.waitFor()
  assert.equal(await organization.inputValue(), 'Boring Computers')
  assert.equal(await profile.inputValue(), 'Michael S.')

  await page.route('**/api/rpc/getSettings', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Could not load settings' }) }))
  await page.reload()
  await page.getByText('Could not load settings', { exact: true }).waitFor()
  // The session already carries the settings, so a failed refresh keeps them on screen beside the error.
  assert.equal(await organization.isVisible(), true)
  assert.equal(await organization.inputValue(), 'Boring Computers')
  await page.unroute('**/api/rpc/getSettings')
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await organization.waitFor()
  assert.equal(await organization.inputValue(), 'Boring Computers')

  await page.route('**/api/rpc/getSettings', route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Unknown dashboard operation' }) }))
  await page.reload()
  await page.getByText('The email API is running an older version without workspace settings. Deploy the latest API Worker, then try again.', { exact: true }).waitFor()
  assert.equal(await page.getByText('Unknown dashboard operation').count(), 0)
  assert.equal(await organization.isVisible(), true)
  await page.unroute('**/api/rpc/getSettings')
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await organization.waitFor()
  assert.equal(await organization.inputValue(), 'Boring Computers')

  await page.route('**/api/rpc/getSettings', route => route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Customer not found' }) }))
  await page.reload()
  await page.getByText('Customer not found', { exact: true }).waitFor()
  assert.equal(await page.getByText('Deploy the latest API Worker').count(), 0, 'A generic 404 keeps its own message')
  assert.equal(await organization.isVisible(), true)
  await page.unroute('**/api/rpc/getSettings')
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await organization.waitFor()
  assert.equal(await organization.inputValue(), 'Boring Computers')

  assert.equal(await page.locator('#desktop-notifications').isChecked(), false)
  assert.equal(await page.locator('#email-notifications').isChecked(), false)
  assert.equal(await page.evaluate(() => window.notificationPermissionRequests), 0, 'No unsolicited permission prompt')
  await page.locator('#desktop-notifications').check()
  await page.locator('#email-notifications').check()
  const rpc = async (operation, data = {}) => {
    const response = await context.request.post(base + '/api/rpc/' + operation, { headers: { origin: base }, data })
    assert.equal(response.status(), 200)
    return (await response.json()).result
  }
  const { inboxId } = await rpc('createInbox', { username: 'notifications' })
  let notificationRequested
  const firstRequest = new Promise(resolve => { notificationRequested = resolve })
  const notificationGate = new Promise(resolve => { release = resolve })
  await page.route('**/api/rpc/getNotifications', async route => { notificationRequested(); await notificationGate; await route.continue() })
  const baseline = page.waitForResponse('**/api/rpc/getNotifications')
  await page.locator('#notifications-form button[type=submit]').click()
  await page.getByText('Notification preferences saved.', { exact: true }).waitFor()
  await firstRequest
  await page.locator('#allow-notifications').click()
  assert.equal(await page.evaluate(() => window.notificationPermissionRequests), 1)
  assert.equal((await context.request.post(control + '/receive', { data: { inboxId, subject: 'Private content stays private' } })).status(), 200)
  release(); await baseline
  await page.waitForFunction(() => window.notificationAlerts.length === 1)
  assert.equal(await page.evaluate(() => window.notificationAlerts[0].options.body), `New mail in ${inboxId}`, 'An arrival during the initial poll is displayed')
  await page.unroute('**/api/rpc/getNotifications')
  await page.clock.install()
  await page.clock.runFor(30_000)
  assert.equal(await page.evaluate(() => window.notificationAlerts.length), 1, 'The next poll does not repeat an alert')
  assert.equal((await context.request.post(control + '/notifications', { data: {} })).status(), 200)
  const delivered = await (await context.request.get(control + '/sends')).json()
  const mail = delivered.filter(message => message.subject === 'New mail in Bezalel Email')
  assert.equal(mail.length, 1)
  assert.deepEqual(mail[0].to, ['owner@example.net'])
  assert.equal(mail[0].text.includes('Private content'), false)
  await page.evaluate(() => window.notificationAlerts[0].onclick())
  await page.locator('#mail-page').waitFor()
  assert.equal(await page.locator('#mail-heading').textContent(), inboxId, 'An alert opens an inbox created outside this tab')
  await page.locator('#settings').click()
  await organization.waitFor()
  await page.evaluate(() => { Notification.permission = 'denied'; window.dispatchEvent(new Event('focus')) })
  await page.getByText('Notifications are blocked. Allow them in your browser’s site settings.', { exact: true }).waitFor()
  assert.equal(await page.locator('#allow-notifications').isVisible(), false)
  await page.reload()
  await organization.waitFor()
  assert.equal(await page.locator('#desktop-notifications').isChecked(), true)
  assert.equal(await page.locator('#email-notifications').isChecked(), true)
  assert.equal(await page.locator('#logout').isVisible(), false)
  await page.locator('#account-button').click()
  assert.equal(await page.locator('#account-menu-detail').textContent(), 'owner@example.net · Owner')
  await page.locator('#logout').click()
  await page.waitForURL('**/sign-in')
  await signIn(context, 'owner@example.net')
  await page.goto(base + '/app#/settings')
  await organization.waitFor()
  assert.equal(await organization.inputValue(), 'Boring Computers')
  assert.equal(await profile.inputValue(), 'Michael S.')
  const other = await browser.newContext()
  await signIn(other, 'other@example.net')
  const otherPage = await other.newPage()
  await otherPage.goto(base + '/app#/settings')
  await otherPage.locator('#organization-name').waitFor()
  assert.equal(await otherPage.locator('#organization-name').inputValue(), 'Your workspace')
  assert.equal(await otherPage.locator('#desktop-notifications').isChecked(), false)
  assert.equal(await otherPage.locator('#email-notifications').isChecked(), false)
  await other.close()

  const evidence = process.env.DASHBOARD_EVIDENCE_DIR
  if (evidence) { await mkdir(evidence, { recursive: true }); await page.setViewportSize({ width: 1440, height: 1500 }); await page.screenshot({ path: evidence + '/settings-desktop.png', fullPage: true }) }
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1100 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No overflow at ${width}`)
  }
  await page.setViewportSize({ width: 390, height: 1100 })
  await page.locator('#open-menu').click()
  await page.locator('[data-page=inboxes]').click()
  await page.locator('#open-menu').click()
  await page.locator('#settings').click()
  await organization.waitFor()
  assert.equal(await page.locator('#sidebar').evaluate(element => element.inert), true)
  if (evidence) { await page.setViewportSize({ width: 390, height: 1800 }); await page.screenshot({ path: evidence + '/settings-mobile.png', fullPage: true }) }
  assert.deepEqual(errors, [])
})
