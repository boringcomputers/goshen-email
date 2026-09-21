import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir } from 'node:fs/promises'

// Run the fixture with FIXTURE_AUTH_MODE=account FIXTURE_BILLING=true FIXTURE_TRIAGE=true FIXTURE_PORT=3196.
const base = process.env.DASHBOARD_TEST_URL ?? 'http://127.0.0.1:3196'
const control = process.env.DASHBOARD_TEST_CONTROL_URL ?? 'http://127.0.0.1:3197'
for (const value of [base, control]) { const url = new URL(value); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1') }
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const evidence = process.env.DASHBOARD_EVIDENCE_DIR

test('the plan page shows usage, blocks past the allowance, upgrades through checkout, and exempts administrators', { timeout: 120_000 }, async t => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] })
  t.after(() => browser.close())
  if (evidence) await mkdir(evidence, { recursive: true })
  const errors = []
  const signIn = async (client, email, name) => {
    assert.equal((await client.request.post(base + '/api/auth/email-otp/send-verification-otp', { headers: { origin: base }, data: { email, type: 'sign-in' } })).status(), 200)
    const sends = await (await client.request.get(control + '/sends')).json()
    const otp = sends.filter(message => message.to.includes(email)).at(-1).text.match(/\b\d{6}\b/)[0]
    assert.equal((await client.request.post(base + '/api/auth/sign-in/email-otp', { headers: { origin: base }, data: { email, otp, name } })).status(), 200)
  }
  const rpc = async (context, operation, data = {}) => {
    const response = await context.request.post(base + '/api/rpc/' + operation, { headers: { origin: base }, data })
    return { status: response.status(), body: await response.json() }
  }

  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } }), page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  const email = `plans-${crypto.randomUUID().slice(0, 8)}@example.net`
  await signIn(context, email, 'Dana Reyes')
  const session = (await context.request.get(base + '/api/session')).json()
  const customerId = (await session).customer.id
  // Two inboxes, three sends, and one analysed message give the page something to show.
  const first = (await rpc(context, 'createInbox', { username: `research-${customerId.slice(0, 6)}` })).body.result
  await rpc(context, 'createInbox', { username: `support-${customerId.slice(0, 6)}` })
  for (const key of ['a', 'b', 'c']) assert.equal((await rpc(context, 'send', { inboxId: first.inboxId, to: ['buyer@example.net'], subject: 'Quote', text: 'Here is the quote.', idempotencyKey: key })).status, 200)
  assert.equal((await context.request.post(control + '/receive', { data: { inboxId: first.inboxId, subject: 'Duplicate charge on invoice 42' } })).status(), 200)

  await page.goto(base + '/app#/billing')
  await page.locator('#billing-plan-name').waitFor()
  assert.equal(await page.locator('#billing').getAttribute('aria-current'), 'page')
  assert.equal(await page.locator('#page-title').textContent(), 'Plan and usage')
  assert.equal(await page.locator('#billing-plan-name').textContent(), 'Free')
  assert.equal(await page.locator('#billing-plan-badge').textContent(), 'Active')
  const meters = page.locator('#billing-meters .billing-meter')
  assert.equal(await meters.count(), 3)
  assert.equal(await meters.nth(0).locator('.billing-meter-amount').textContent(), '2 of 5')
  assert.equal(await meters.nth(1).locator('.billing-meter-amount').textContent(), '3 of 1,000')
  assert.equal(await meters.nth(2).locator('.billing-meter-amount').textContent(), '1 of 500')
  assert.equal(await page.locator('#billing-meters progress').first().getAttribute('value'), '2')
  const cards = page.locator('.billing-plan-card')
  assert.equal(await cards.count(), 3)
  assert.equal(await cards.nth(0).getAttribute('data-current'), '')
  assert.equal(await cards.nth(0).locator('button').isDisabled(), true)
  assert.equal(await cards.nth(1).locator('button').textContent(), 'Upgrade to Developer')
  assert.equal(await cards.nth(1).locator('.billing-price strong').textContent(), '$20')
  assert.equal(await cards.nth(2).locator('.billing-price strong').textContent(), '$99')
  assert.ok((await cards.nth(2).textContent()).includes('100,000 sends a month'))
  if (evidence) await page.screenshot({ path: evidence + '/billing-desktop.png', fullPage: true })

  // Spending the send allowance shows on the page and the API says why the next send failed.
  assert.equal((await context.request.post(control + '/billing', { data: { customerId, feature: 'sends', granted: 3 } })).status(), 200)
  await page.locator('#billing-refresh').click()
  await page.getByText('Allowance spent.').waitFor()
  assert.equal(await meters.nth(1).locator('.billing-meter-amount').textContent(), '3 of 3')
  assert.equal(await page.locator('#billing-meters progress').nth(1).getAttribute('data-level'), 'spent')
  const denied = await rpc(context, 'send', { inboxId: first.inboxId, to: ['buyer@example.net'], subject: 'Quote', text: 'Here is the quote.', idempotencyKey: 'd' })
  assert.equal(denied.status, 402)
  assert.match(denied.body.error, /monthly send limit/)
  if (evidence) await page.screenshot({ path: evidence + '/billing-spent.png', fullPage: true })

  // Upgrading hands the browser to the hosted checkout page.
  await page.route('https://checkout.stripe.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Fixture checkout</title><h1>Fixture checkout</h1>' }))
  await cards.nth(1).locator('button').click()
  await page.waitForURL('https://checkout.stripe.test/developer')
  const checkouts = (await (await context.request.post(control + '/billing', { data: {} })).json()).checkouts
  assert.deepEqual(checkouts.at(-1), { customerId, planId: 'developer' })
  await page.goBack()
  await page.locator('#billing-plan-name').waitFor()

  // Refreshing while a checkout request is still in flight must not leave the buttons disabled.
  let releaseCheckout
  const held = new Promise(resolve => { releaseCheckout = resolve })
  await page.route('**/api/rpc/startCheckout', async route => { await held; await route.continue() })
  await cards.nth(2).locator('button').click()
  assert.equal(await cards.nth(2).locator('button').textContent(), 'Opening checkout…')
  assert.equal(await cards.nth(1).locator('button').isDisabled(), true)
  await page.locator('#billing-refresh').click()
  await page.locator('#billing-plan-name').waitFor()
  assert.equal(await page.locator('.billing-plan-card').nth(1).locator('button').isDisabled(), false, 'A reload re-enables the plan buttons')
  assert.equal(await page.locator('.billing-plan-card').nth(2).locator('button').textContent(), 'Upgrade to Team')
  releaseCheckout()
  await page.unroute('**/api/rpc/startCheckout')
  await page.waitForTimeout(200)
  assert.equal(page.url(), base + '/app#/billing', 'A stale checkout answer does not navigate')

  // Manage billing opens the hosted portal.
  await page.route('https://billing.stripe.test/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Fixture portal</title>' }))
  await page.locator('#billing-portal').click()
  await page.waitForURL(`https://billing.stripe.test/session/${customerId}`)
  await page.goBack()
  await page.locator('#billing-plan-name').waitFor()

  // A billing outage is reported and retried, not swallowed.
  assert.equal((await context.request.post(control + '/billing', { data: { down: true } })).status(), 200)
  await page.locator('#billing-refresh').click()
  await page.getByText('Billing is temporarily unavailable. Retry shortly.', { exact: true }).waitFor()
  assert.equal((await context.request.post(control + '/billing', { data: { down: false } })).status(), 200)
  await page.getByRole('button', { name: 'Try again', exact: true }).click()
  await page.locator('#billing-plan-name').waitFor()
  assert.equal(await page.locator('#billing-error').textContent(), '')

  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1200 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No overflow at ${width}`)
  }
  if (evidence) { await page.setViewportSize({ width: 390, height: 2400 }); await page.screenshot({ path: evidence + '/billing-mobile.png', fullPage: true }) }

  // A pricing link followed while signed out comes back to the plans after sign-in.
  const visitor = await browser.newContext({ viewport: { width: 1440, height: 1200 } }), visitorPage = await visitor.newPage()
  visitorPage.on('pageerror', error => errors.push(error.message))
  await visitorPage.goto(base + '/')
  await visitorPage.getByRole('link', { name: 'Start on Developer' }).click()
  await visitorPage.waitForURL(base + '/sign-in#/billing')
  const visitorEmail = `visitor-${crypto.randomUUID().slice(0, 8)}@example.net`
  await visitorPage.locator('#email').fill(visitorEmail)
  await visitorPage.locator('input[name=method][value=code]').check()
  await visitorPage.locator('#submit').click()
  await visitorPage.locator('#code').waitFor()
  const codes = await (await visitor.request.get(control + '/sends')).json()
  await visitorPage.locator('#code').fill(codes.filter(message => message.to.includes(visitorEmail)).at(-1).text.match(/\b\d{6}\b/)[0])
  await visitorPage.locator('#submit').click()
  await visitorPage.waitForURL(base + '/app#/billing')
  await visitorPage.locator('#billing-plan-name').waitFor()
  assert.equal(await visitorPage.locator('#page-title').textContent(), 'Plan and usage')
  // An already signed-in visitor opening the sign-in page with a route also lands on it.
  await visitorPage.goto(base + '/sign-in#/billing')
  await visitorPage.waitForURL(base + '/app#/billing')
  // A fragment that is not a dashboard route is dropped.
  await visitorPage.goto(base + '/sign-in#//evil.example/phish')
  await visitorPage.waitForURL(base + '/app')
  await visitor.close()

  // Administrators see that they are not billed and get no upgrade buttons.
  const owner = await browser.newContext({ viewport: { width: 1440, height: 1200 } }), ownerPage = await owner.newPage()
  ownerPage.on('pageerror', error => errors.push(error.message))
  await signIn(owner, 'owner@example.net', 'Michael Shimeles')
  await ownerPage.goto(base + '/app#/billing')
  await ownerPage.locator('#billing-plan-name').waitFor()
  assert.equal(await ownerPage.locator('#billing-plan-name').textContent(), 'Administrator')
  assert.equal(await ownerPage.locator('#billing-plans').isVisible(), false)
  assert.equal(await ownerPage.locator('#billing-portal').isVisible(), false)
  assert.equal((await rpc(owner, 'startCheckout', { planId: 'developer' })).status, 403)
  await owner.close()
  assert.deepEqual(errors, [])
})
