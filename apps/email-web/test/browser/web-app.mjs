import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { test } from 'node:test'

// Runs against apps/email/test/dashboard-fixture.ts (FIXTURE_AUTH_MODE=account FIXTURE_TRIAGE=true FIXTURE_BILLING=true)
// and this app's `vite preview` with DASHBOARD_URL pointing at that fixture. Both stay on loopback.
const app = process.env.EMAIL_WEB_TEST_URL ?? 'http://127.0.0.1:5290'
const dashboard = process.env.DASHBOARD_TEST_URL ?? 'http://127.0.0.1:3194'
const control = process.env.DASHBOARD_TEST_CONTROL_URL ?? 'http://127.0.0.1:3195'
for (const value of [app, dashboard, control]) { const url = new URL(value); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1') }
const evidence = process.env.DASHBOARD_EVIDENCE_DIR
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')

async function rpc(request, operation, data = {}) {
  const response = await request.post(`${dashboard}/api/rpc/${operation}`, { headers: { origin: dashboard }, data })
  const body = await response.json()
  assert.ok(response.ok(), `${operation}: ${body.error}`)
  return body.result
}
const receive = async (request, data) => assert.ok((await request.post(control + '/receive', { data })).ok())
const sends = async request => (await request.get(control + '/sends')).json()
const latestCode = async (request, email) => (await sends(request)).filter(message => message.to.includes(email)).at(-1).text.match(/\b\d{6}\b/)[0]

test('the Pluto-design web app runs the dashboard flows against the fixture', { timeout: 180_000 }, async t => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] })
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  if (evidence) await mkdir(evidence, { recursive: true })
  const shot = async name => { if (evidence) await page.screenshot({ path: `${evidence}/${name}.png` }) }

  await page.goto(app + '/inboxes')
  await page.waitForURL(/\/sign-in/)
  await page.getByLabel('Email address').fill('owner@example.net')
  await page.getByRole('button', { name: 'Email me a code' }).click()
  await page.getByLabel('Six-digit code').fill(await latestCode(context.request, 'owner@example.net'))
  await page.getByRole('button', { name: 'Verify code and sign in' }).click()
  await page.waitForURL(/\/setup$/)
  await page.getByLabel('Email username').waitFor()
  await shot('setup')

  // The browser session doubles as the seeding session; the requests carry the same cookie.
  await rpc(context.request, 'updateSettings', { organizationName: 'Boring Computers', displayName: 'Michael Shimeles' })
  const research = await rpc(context.request, 'createInbox', { username: 'research', displayName: 'Research assistant' })
  await rpc(context.request, 'createInbox', { username: 'support', displayName: 'Support desk' })
  await receive(context.request, { inboxId: research.inboxId, from: 'Jamie Rivera <jamie@example.net>', subject: 'Quarterly research brief', text: 'Could you summarize the three biggest findings by Friday?' })
  await receive(context.request, { inboxId: research.inboxId, from: 'Priya Natarajan <priya@example.net>', subject: 'Invoice #4821 is overdue', text: 'Please arrange payment this week.' })
  await receive(context.request, { inboxId: research.inboxId, from: 'Prize Desk <winner@example.net>', subject: 'You have won a prize', text: 'Click here.', quarantine: true })

  await page.goto(app + '/inboxes')
  await page.locator(`tr[data-inbox-id="${research.inboxId}"]`).waitFor()
  assert.equal(await page.getByTestId('inbox-count').textContent(), '2 inboxes')
  await page.getByLabel('Search inboxes').fill('support')
  assert.equal(await page.getByTestId('inbox-count').textContent(), '1 inbox of 2')
  await page.getByLabel('Search inboxes').fill('')
  await shot('inboxes')

  await page.locator(`tr[data-inbox-id="${research.inboxId}"] a`).click()
  await page.locator('[data-thread-id]', { hasText: 'Quarterly research brief' }).click()
  await page.getByRole('heading', { name: 'Quarterly research brief' }).waitFor()
  await shot('mail-thread')
  const before = (await sends(context.request)).length
  await page.getByLabel(/Reply to/).fill('The summary will be ready Thursday.')
  await page.getByRole('button', { name: 'Send reply' }).click()
  await page.getByText('Reply accepted for sending').waitFor()
  const reply = (await sends(context.request)).slice(before).find(message => message.text?.includes('ready Thursday'))
  assert.deepEqual(reply?.to, ['jamie@example.net'])

  await page.getByRole('button', { name: 'Compose' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('To', { exact: true }).fill('sam@example.net')
  await dialog.getByLabel('Subject', { exact: true }).fill('Tuesday works')
  await dialog.getByLabel('Message', { exact: true }).fill('Noon on Tuesday works for me.')
  await dialog.locator('input[type=file]').setInputFiles({ name: 'agenda.txt', mimeType: 'text/plain', buffer: Buffer.from('1. Lunch\n') })
  await dialog.getByText('agenda.txt').waitFor()
  await page.getByRole('button', { name: 'Send message' }).click()
  await page.getByText('Message accepted for sending').waitFor()
  const composed = (await sends(context.request)).find(message => message.subject === 'Tuesday works')
  assert.deepEqual(composed?.to, ['sam@example.net'])
  assert.ok(JSON.stringify(composed).includes('agenda.txt'), 'The attachment reaches the transport')

  await page.locator('[data-folder="quarantined"]').click()
  await page.locator('[data-thread-id]', { hasText: 'You have won a prize' }).click()
  await page.getByText('This message is quarantined').waitFor()
  assert.deepEqual((await page.getByRole('button', { name: /^Move to/ }).allTextContents()).map(text => text.trim()), ['Move to trash'],
    'Quarantine offers release, not a label move to the inbox')
  await page.getByRole('button', { name: 'Release message' }).click()
  await page.getByText('Message released').waitFor()

  await page.locator('[data-folder="inbox"]').click()
  await page.getByLabel('Search mail').fill('invoice')
  await page.getByLabel('Search mail').press('Enter')
  await page.locator('[data-thread-id]', { hasText: 'Invoice #4821 is overdue' }).waitFor()
  assert.equal(await page.locator('[data-thread-id]').count(), 1)

  await page.goto(app + '/settings')
  await page.getByLabel('Organization name').fill('Boring Computers Lab')
  await page.getByRole('button', { name: 'Save changes' }).first().click()
  await page.getByText('Organization name saved.').waitFor()
  await page.reload()
  await page.getByLabel('Organization name').waitFor()
  assert.equal(await page.getByLabel('Organization name').inputValue(), 'Boring Computers Lab')

  await page.getByLabel('Select theme').click()
  await page.getByRole('menuitem', { name: 'Porcelain' }).click()
  await page.reload()
  await page.getByLabel('Organization name').waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('light')), true)
  await page.getByLabel('Select theme').click()
  await page.getByRole('menuitem', { name: 'Obsidian' }).click()

  const foreign = await context.request.post(app + '/api/rpc/listInboxes', { headers: { origin: 'https://evil.example.com' }, data: {} })
  assert.equal(foreign.status(), 403, 'The dev proxy never vouches for another origin')

  await page.getByLabel('Account menu').click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await page.waitForURL(/\/sign-in$/)
  await page.goto(app + '/billing')
  await page.waitForURL(/\/sign-in\?next=%2Fbilling$/)

  const next = await browser.newContext({ viewport: { width: 1440, height: 900 } }), fresh = await next.newPage()
  t.after(() => next.close())
  fresh.on('pageerror', error => errors.push(error.message))
  assert.equal((await next.request.post(dashboard + '/api/auth/email-otp/send-verification-otp', { headers: { origin: dashboard }, data: { email: 'noor@example.net', type: 'sign-in' } })).status(), 200)
  assert.equal((await next.request.post(dashboard + '/api/auth/sign-in/email-otp', { headers: { origin: dashboard }, data: { email: 'noor@example.net', otp: await latestCode(next.request, 'noor@example.net'), name: 'Noor Haddad' } })).status(), 200)
  await fresh.goto(app + '/billing')
  await fresh.getByTestId('plan-name').waitFor()
  assert.equal(await fresh.getByTestId('plan-name').textContent(), 'Free')
  await fresh.getByRole('button', { name: /Upgrade to/ }).first().waitFor()
  await fresh.goto(app + '/inboxes')
  await fresh.getByText('Create your first inbox').waitFor()
  assert.equal(await fresh.locator('tr[data-inbox-id]').count(), 0, 'Another account never sees the first account’s inboxes')

  assert.deepEqual(errors, [])
})
