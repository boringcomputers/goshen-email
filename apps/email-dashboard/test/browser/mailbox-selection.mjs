import assert from 'node:assert/strict'
import { test } from 'node:test'

// Run against dashboard-fixture.ts in account mode. No production URLs are accepted.
const base = process.env.DASHBOARD_TEST_URL ?? 'http://127.0.0.1:3168'
const control = process.env.DASHBOARD_TEST_CONTROL_URL ?? 'http://127.0.0.1:3169'
for (const value of [base, control]) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
}
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')

test('setup follows mailbox selection before message loading and after failures', { timeout: 60_000 }, async (t) => {
  const browser = await chromium.launch({
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    args: ['--no-sandbox'],
  })
  let release = () => {}, signalRequest
  t.after(async () => {
    release()
    try { await fetch(control + '/routing', { method: 'POST', body: JSON.stringify({ available: true }) }) }
    finally { await browser.close() }
  })
  const context = await browser.newContext(), page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const api = (operation, input) => context.request.post(base + '/api/rpc/' + operation, { headers: { origin: base }, data: input })
  const routeSetup = (available) => context.request.post(control + '/routing', { data: { available } })
  const suffix = crypto.randomUUID().slice(0, 8), email = `switch-${suffix}@example.net`
  const a = `research-${suffix}@example.com`, b = `support-${suffix}@example.com`, c = `new-${suffix}@example.com`
  assert.equal((await context.request.post(base + '/api/auth/email-otp/send-verification-otp', {
    headers: { origin: base }, data: { email, type: 'sign-in' },
  })).status(), 200)
  const messages = await (await context.request.get(control + '/sends')).json()
  const otp = messages.filter(message => message.to.includes(email)).at(-1).text.match(/\b\d{6}\b/)[0]
  assert.equal((await context.request.post(base + '/api/auth/sign-in/email-otp', {
    headers: { origin: base }, data: { email, otp, name: 'Mailbox regression' },
  })).status(), 200)
  await routeSetup(false)
  for (const inbox of [a, b]) assert.equal((await api('createInbox', { username: inbox.split('@')[0] })).status(), 503)
  await page.goto(base + '/app')
  await page.locator('#setup-address').filter({ hasText: a }).waitFor()
  const pending = new Promise(resolve => { release = resolve })
  const requested = new Promise(resolve => { signalRequest = resolve })
  await page.route('**/api/rpc/listThreads', async route => {
    if (route.request().postDataJSON().inboxId === b) { signalRequest(); await pending }
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Fixture message loading failure' }) })
  })
  await page.locator('#inboxes').selectOption(b)
  await requested
  assert.equal(await page.locator('#setup-address').textContent(), b, 'Guide changes while message request is still pending')
  release()
  await page.locator('#notice').filter({ hasText: 'Fixture message loading failure' }).waitFor()
  assert.equal(await page.locator('#setup-address').textContent(), b)
  assert.equal(await page.locator('#inboxes').getAttribute('title'), b)
  const retry = page.waitForRequest('**/api/rpc/finishInboxSetup')
  await page.locator('#setup-retry').click()
  assert.equal((await retry).postDataJSON().inboxId, b, 'Delivery retry targets the displayed inbox')
  await page.waitForFunction(() => !document.querySelector('#setup-retry').disabled)
  assert.equal(await page.locator('#setup-address').textContent(), b)

  // Initial inventory and later creation/deletion refreshes must also update the guide.
  await page.reload()
  await page.locator('#setup-address').filter({ hasText: a }).waitFor()
  assert.equal(await page.locator('#setup').isVisible(), true)
  await routeSetup(true)
  await page.locator('#new-inbox').click()
  await page.locator('#inbox-form [name=username]').fill(c.split('@')[0])
  await page.locator('#inbox-form button[type=submit]').click()
  await page.locator('#inbox-error').filter({ hasText: 'Fixture message loading failure' }).waitFor()
  assert.equal(await page.locator('#setup-address').textContent(), c, 'Creation refresh updates setup despite failed message reads')
  await page.getByRole('button', { name: 'Close new inbox', exact: true }).click()
  page.once('dialog', dialog => dialog.accept())
  await page.locator('#delete-inbox').click()
  await page.locator('#setup-address').filter({ hasText: a }).waitFor()
  assert.equal(await page.locator('#inboxes').inputValue(), a)
  assert.deepEqual(errors, [])
})
