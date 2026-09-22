import assert from 'node:assert/strict'
import { test } from 'node:test'

// dashboard-fixture.ts uses a local database and provider doubles for OTP and inbox routing.
// Run it with FIXTURE_AUTH_MODE=account; this file signs in once.
const base = process.env.DASHBOARD_TEST_URL ?? 'http://127.0.0.1:3194'
const control = process.env.DASHBOARD_TEST_CONTROL_URL ?? 'http://127.0.0.1:3195'
for (const value of [base, control]) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
}
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const evidence = process.env.DASHBOARD_EVIDENCE_DIR

async function signIn(context, name) {
  const email = `header-${crypto.randomUUID().slice(0, 8)}@example.net`
  const post = (path, data) => context.request.post(base + path, { headers: { origin: base }, data })
  assert.equal((await post('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })).status(), 200)
  const sends = await (await context.request.get(control + '/sends')).json()
  const otp = sends.filter(message => message.to.includes(email)).at(-1).text.match(/\b\d{6}\b/)[0]
  assert.equal((await post('/api/auth/sign-in/email-otp', { email, otp, name })).status(), 200)
  return email
}
const ready = page => page.waitForFunction(() => {
  const app = document.querySelector('#app')
  return app && !app.hidden && !app.inert && app.getAttribute('aria-busy') === 'false'
})
const headerActions = page => page.locator('.nav-actions').innerText()
const visible = (page, selector) => page.locator(selector).evaluate(element => element.checkVisibility())
const gotoWithSession = (page, url) => Promise.all([page.waitForResponse('**/api/session'), page.goto(url)])

test('the site header shows the signed-in account instead of Log in, and signs out from the landing page', { timeout: 120_000 }, async t => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] })
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await context.newPage(), errors = [], sessionRequests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/session') sessionRequests.push(page.url()) })

  // Signed out: the links stay and the page never asks the server about a session.
  await page.goto(base + '/')
  await page.waitForLoadState('networkidle')
  assert.equal(await headerActions(page), 'Log in\nGet started')
  assert.equal(await page.locator('#site-account-menu').count(), 0)
  assert.deepEqual(sessionRequests, [], 'an anonymous visit makes no session request')

  // Signed in: the account menu and a dashboard link replace both links, on the landing and docs pages.
  const email = await signIn(context, 'Ada Lovelace')
  await page.goto(base + '/app#/inboxes')
  await ready(page)
  for (const path of ['/', '/docs']) {
    await gotoWithSession(page, base + path)
    assert.equal(await headerActions(page), 'Open dashboard\nAL\nAda Lovelace', path)
    assert.equal(await visible(page, '.site-header-log-in'), false, `${path} hides Log in`)
    assert.equal(await visible(page, '.site-header-start-free:not(#site-dashboard-link)'), false, `${path} hides Get started`)
    assert.equal(await page.locator('#site-dashboard-link').getAttribute('href'), '/app')
  }

  // The saved account paints before the session request answers, so the header never flashes Log in.
  let release
  const pending = new Promise(resolve => { release = resolve })
  await page.route('**/api/session', async route => { await pending; await route.continue() })
  await page.goto(base + '/', { waitUntil: 'commit' })
  await page.waitForFunction(() => document.querySelector('#site-account-menu'))
  assert.equal(await page.locator('.site-account-name').textContent(), 'Ada Lovelace', 'painted from the saved workspace before the session answers')
  const answered = page.waitForResponse('**/api/session')
  release()
  await answered
  await page.unroute('**/api/session')

  // The menu opens with the account details and closes on Escape.
  await page.locator('#site-account-button').click()
  assert.equal(await page.locator('#site-account-menu').evaluate(menu => menu.open), true)
  assert.equal(await page.locator('.site-account-identity strong').textContent(), 'Ada Lovelace')
  assert.equal(await page.locator('.site-account-identity p').textContent(), email)
  assert.equal(await page.locator('#site-account-settings').getAttribute('href'), '/app#/settings')
  if (evidence) await page.screenshot({ path: `${evidence}/site-header-signed-in.png`, clip: { x: 0, y: 0, width: 1440, height: 320 } })
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('#site-account-menu').evaluate(menu => menu.open), false)

  // An ended session removes the menu once the server says so.
  await page.route('**/api/session', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authenticated: false, authMode: 'account' }) }))
  await page.reload()
  await page.waitForFunction(() => !document.querySelector('#site-account-menu'))
  assert.equal(await headerActions(page), 'Log in\nGet started')
  assert.equal(await page.evaluate(() => localStorage.getItem('bezalel.dashboard.snapshot')), null, 'the saved workspace is dropped with the session')
  await page.unroute('**/api/session')

  // A session request that fails or answers with something other than JSON clears the account too.
  for (const [label, answer] of [['aborted', route => route.abort()], ['malformed', route => route.fulfill({ contentType: 'application/json', body: 'not json' })]]) {
    await page.goto(base + '/app#/inboxes')
    await ready(page)
    assert.notEqual(await page.evaluate(() => localStorage.getItem('bezalel.dashboard.snapshot')), null)
    await page.route('**/api/session', answer)
    await page.goto(base + '/')
    await page.waitForFunction(() => !document.querySelector('#site-account-menu'))
    assert.equal(await headerActions(page), 'Log in\nGet started', `${label} session answer shows the links`)
    assert.equal(await page.evaluate(() => localStorage.getItem('bezalel.dashboard.snapshot')), null, `${label} session answer drops the saved workspace`)
    await page.unroute('**/api/session')
  }

  // Signing out from the header ends the session, clears the marker, and restores the links.
  await page.goto(base + '/app#/inboxes')
  await ready(page)
  await gotoWithSession(page, base + '/')
  await page.locator('#site-account-button').click()
  await page.locator('#site-logout').click()
  await page.waitForFunction(() => !document.querySelector('#site-account-menu'))
  assert.equal(await headerActions(page), 'Log in\nGet started')
  assert.equal((await context.cookies(base)).some(cookie => cookie.name === 'workspace'), false)
  assert.deepEqual(await (await context.request.get(base + '/api/session')).json(), { authenticated: false, authMode: 'account' })
  if (evidence) await page.screenshot({ path: `${evidence}/site-header-signed-out.png`, clip: { x: 0, y: 0, width: 1440, height: 320 } })
  assert.deepEqual(errors, [])
  await context.close()
})
