import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { BezalelEmail } from '../../../../packages/email-sdk/dist/index.js'

const base = process.env.DASHBOARD_TEST_URL ?? 'http://127.0.0.1:3188'
const control = process.env.DASHBOARD_TEST_CONTROL_URL ?? 'http://127.0.0.1:3189'
for (const value of [base, control]) { const url = new URL(value); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1') }
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const artifacts = process.env.EVIDENCE_DIRECTORY

test('triage filters, uncertainty, reply freshness and Python reads use the same stored results', { timeout: 120_000 }, async t => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] })
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  const suffix = crypto.randomUUID().slice(0, 8), email = `triage-${suffix}@example.net`
  assert.equal((await context.request.post(base + '/api/auth/email-otp/send-verification-otp', { headers: { origin: base }, data: { email, type: 'sign-in' } })).status(), 200)
  const sent = await (await context.request.get(control + '/sends')).json()
  const otp = sent.filter(message => message.to.includes(email)).at(-1).text.match(/\b\d{6}\b/)[0]
  assert.equal((await context.request.post(base + '/api/auth/sign-in/email-otp', { headers: { origin: base }, data: { email, otp, name: 'Michael' } })).status(), 200)
  await page.goto(base + '/app')
  await page.locator('#developers').click()
  await page.locator('#new-api-key').click()
  await page.locator('#developer-form [name=name]').fill('Triage test')
  for (const checkbox of await page.locator('#developer-form [name=scope]').all()) await checkbox.check()
  await page.locator('#developer-create').click()
  await page.waitForFunction(() => document.querySelector('#developer-token').value.startsWith('bze_'))
  const apiKey = await page.locator('#developer-token').inputValue()
  const client = new BezalelEmail({ apiKey, baseUrl: control })
  const inbox = await client.inboxes.create({ username: `triage-${suffix}`, group: 'support' })
  const messages = [
    { subject: 'Duplicate charge on our September invoice', text: 'Hi Michael, I noticed two charges for our September subscription. Could you check the invoice and refund the duplicate? Thanks, Jamie.' },
    { subject: 'Production outage: our team cannot send mail', text: 'Our entire support team is blocked by an outage right now. Please help us restore service.' },
    { subject: 'Your weekly newsletter', text: 'A few things we shipped this week. No action needed. Enjoy your weekend.' },
    { subject: 'Ambiguous invoice follow-up', text: 'Just following up on that invoice conversation. Thanks.' },
    { subject: 'Pending analysis', text: 'Please check my account when you have a moment.' },
    { subject: 'Unavailable analysis', text: 'This message remains readable while analysis is unavailable.' },
  ]
  const received = []
  for (const message of [...messages].reverse()) {
    const response = await context.request.post(control + '/receive', { data: { inboxId: inbox.inboxId, ...message } })
    assert.equal(response.status(), 200); received.unshift(await response.json())
  }
  assert.equal((await context.request.post(control + '/receive', { data: { inboxId: inbox.inboxId, subject: 'Quarantined message', quarantine: true } })).status(), 200)
  await page.getByRole('button', { name: 'Close API key creation', exact: true }).click()
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('#inboxes option').length === 1)
  await page.goto(base + '/app#/inboxes/' + encodeURIComponent(inbox.inboxId))
  if (await page.locator('#setup').isVisible()) await page.locator('#setup-dismiss').click()
  await page.waitForFunction(() => document.querySelectorAll('#threads .thread').length === 6)
  assert.equal(await page.getByText('Analysis pending', { exact: true }).count(), 1)
  assert.equal(await page.getByText('Analysis unavailable', { exact: true }).count(), 1)
  assert.equal(await page.getByText('Reply unclear', { exact: true }).count(), 1)
  await page.locator('#toggle-triage').click()
  await page.locator('#triage-category').selectOption('support')
  await page.waitForFunction(() => document.querySelectorAll('#threads .thread').length === 1)
  await page.locator('#triage-needs-reply').selectOption('yes')
  await page.locator('#triage-urgency').selectOption('critical')
  await page.getByRole('button', { name: /Production outage/ }).waitFor()
  await page.locator('#clear-triage').click()
  await page.waitForFunction(() => document.querySelectorAll('#threads .thread').length === 6)
  await page.getByRole('button', { name: /Duplicate charge/ }).click()
  await page.locator('.triage-details summary').click()
  await page.getByText('Reply needed: 98% probability.', { exact: true }).waitFor()
  if (artifacts) { await mkdir(artifacts, { recursive: true }); await page.screenshot({ path: resolve(artifacts, 'triage-desktop.png') }) }
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `overflow at ${width}`)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Back to conversations', exact: true }).click()
  if (artifacts) await page.screenshot({ path: resolve(artifacts, 'triage-mobile.png') })
  await page.locator('#triage-needs-reply').selectOption('uncertain')
  await page.waitForFunction(() => document.querySelectorAll('#threads .thread').length === 1)
  await page.getByRole('button', { name: /Ambiguous invoice/ }).waitFor()
  await page.locator('#query').fill('invoice')
  await page.locator('#search-form').evaluate(form => form.requestSubmit())
  await page.getByRole('button', { name: /Ambiguous invoice/ }).waitFor()
  await page.locator('#clear-triage').click()
  await page.locator('#query').fill('')
  await page.locator('#search-form').evaluate(form => form.requestSubmit())
  await page.locator('#triage-category').selectOption('billing')
  await page.locator('#triage-needs-reply').selectOption('yes')
  await page.waitForFunction(() => document.querySelectorAll('#threads .thread').length === 1)
  const python = await promisify(execFile)('python3', ['-c', [
    'import json, os', 'from bezalel_email import BezalelEmail',
    'client=BezalelEmail(os.environ["BEZALEL_API_KEY"], os.environ["BEZALEL_BASE_URL"])',
    `print(json.dumps(client.messages.list(inbox_id="${inbox.inboxId}", category="billing", needs_reply="yes", urgency="normal")))`,
  ].join('\n')], { env: { ...process.env, PYTHONPATH: resolve('packages/email-python'), BEZALEL_API_KEY: apiKey, BEZALEL_BASE_URL: control } })
  const results = JSON.parse(python.stdout)
  assert.equal(results.messages.length, 1)
  assert.equal(results.messages[0].messageId, received[0].messageId)
  assert.equal(results.messages[0].triage.needsReply.probability, 0.98)
  await client.messages.reply({ inboxId: inbox.inboxId, messageId: received[0].messageId, text: 'We are checking the duplicate charge.', idempotencyKey: crypto.randomUUID() })
  await page.locator('#refresh').click()
  await page.getByText('No matching messages', { exact: true }).waitFor()
  assert.equal((await client.messages.get({ inboxId: inbox.inboxId, messageId: received[0].messageId })).triage.needsReply.value, true)
  assert.deepEqual(errors, [])
  if (artifacts) await writeFile(resolve(artifacts, 'browser-report.json'), JSON.stringify({ passed: true, errors,
    environment: 'Isolated local PGlite dashboard fixture',
    providerOperations: 'Jev analysis, verification, routing, sending, and object storage are test doubles. No live inference or mail delivery.',
    checks: ['passwordless fixture sign-in', 'account API key', 'stored triage badges', 'combined filters', 'clear filters', 'uncertainty', 'pending and failed analysis', 'probability details', 'search filters', 'Python filters and metadata', 'reply clears thread triage', 'no horizontal overflow at 320/390/768/1440'],
  }, null, 2))
})
