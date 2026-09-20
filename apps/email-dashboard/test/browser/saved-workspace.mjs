import assert from 'node:assert/strict'
import { test } from 'node:test'

// dashboard-fixture.ts uses a local database and provider doubles for OTP and inbox routing.
// This file signs in twice; the fixture allows three code sign-ins per run, so it runs on its own fixture.
const base = process.env.DASHBOARD_TEST_URL ?? 'http://127.0.0.1:3280'
const control = process.env.DASHBOARD_TEST_CONTROL_URL ?? 'http://127.0.0.1:3281'
for (const value of [base, control]) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
}
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')

async function signIn(context, name, organization) {
  const suffix = crypto.randomUUID().slice(0, 8), email = `saved-${suffix}@example.net`
  const post = (path, data) => context.request.post(base + path, { headers: { origin: base }, data })
  assert.equal((await post('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })).status(), 200)
  const sends = await (await context.request.get(control + '/sends')).json()
  const otp = sends.filter(message => message.to.includes(email)).at(-1).text.match(/\b\d{6}\b/)[0]
  assert.equal((await post('/api/auth/sign-in/email-otp', { email, otp, name })).status(), 200)
  assert.equal((await post('/api/rpc/updateSettings', { organizationName: organization })).status(), 200)
  const inbox = await post('/api/rpc/createInbox', { username: `saved-${suffix}`, displayName: name })
  assert.equal(inbox.status(), 200)
  return { email, inboxId: (await inbox.json()).result.inboxId }
}
const ready = page => page.waitForFunction(() => {
  const app = document.querySelector('#app')
  return app && !app.hidden && !app.inert && app.getAttribute('aria-busy') === 'false'
})
const savedWorkspace = page => page.evaluate(() => JSON.parse(localStorage.getItem('bezalel.dashboard.snapshot')))

test('the saved workspace is replaced for another account and cleared on sign-out or an ended session', { timeout: 120_000 }, async t => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] })
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const first = await signIn(context, 'First owner', 'First Labs')
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(base + '/app#/inboxes')
  await ready(page)
  assert.equal(await page.locator('#workspace-breadcrumb').textContent(), 'First Labs')
  assert.equal((await savedWorkspace(page)).session.customer.email, first.email)

  // Another account signing in on this browser ends up with its own workspace, and nothing of the first remains saved.
  await context.clearCookies()
  const second = await signIn(context, 'Second owner', 'Second Labs')
  await page.reload()
  await ready(page)
  assert.equal(await page.locator('#workspace-breadcrumb').textContent(), 'Second Labs')
  assert.equal(await page.locator('#account-name').textContent(), 'Second owner')
  assert.equal(await page.locator('#inbox-rows tr').count(), 1)
  assert.equal(await page.locator('#inbox-rows strong').textContent(), 'Second owner')
  const saved = await savedWorkspace(page)
  assert.equal(saved.session.customer.email, second.email)
  assert.equal(JSON.stringify(saved).includes(first.inboxId), false)
  assert.equal(JSON.stringify(saved).includes('First'), false)

  // A session that ended elsewhere clears the saved workspace before redirecting.
  await page.route('**/api/session', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authenticated: false, authMode: 'account' }) }))
  await page.reload()
  await page.waitForURL('**/sign-in')
  assert.equal(await savedWorkspace(page), null)
  await page.unroute('**/api/session')

  // Signing out clears it too.
  await page.goto(base + '/app#/inboxes')
  await ready(page)
  assert.equal((await savedWorkspace(page)).session.customer.email, second.email)
  await page.locator('#account-button').click()
  await page.locator('#logout').click()
  await page.waitForURL('**/sign-in')
  assert.equal(await savedWorkspace(page), null)
  assert.deepEqual(errors, [])
  await context.close()
})
