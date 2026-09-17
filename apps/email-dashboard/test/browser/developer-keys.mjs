import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
import { BezalelEmail } from '../../../../packages/email-sdk/dist/index.js'
const base = process.env.DASHBOARD_TEST_URL ?? 'http://127.0.0.1:3178'
const control = process.env.DASHBOARD_TEST_CONTROL_URL ?? 'http://127.0.0.1:3179'
for (const value of [base, control]) { const url = new URL(value); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1') }
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')
const artifacts = process.env.EVIDENCE_DIRECTORY

test('one account key manages grouped inboxes across SDK, CLI and Python and stops after revocation', { timeout: 120_000 }, async t => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] })
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } }), page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  const suffix = crypto.randomUUID().slice(0, 8), email = `developer-${suffix}@example.net`
  assert.equal((await context.request.post(base + '/api/auth/email-otp/send-verification-otp', { headers: { origin: base }, data: { email, type: 'sign-in' } })).status(), 200)
  const messages = await (await context.request.get(control + '/sends')).json()
  const otp = messages.filter(message => message.to.includes(email)).at(-1).text.match(/\b\d{6}\b/)[0]
  assert.equal((await context.request.post(base + '/api/auth/sign-in/email-otp', { headers: { origin: base }, data: { email, otp, name: 'Developer workspace' } })).status(), 200)
  await page.goto(base + '/app')
  await page.locator('#developers').click()
  await page.getByText('No account API keys yet.', { exact: true }).waitFor()
  await page.locator('#new-api-key').click()
  assert.equal(await page.locator('#developer-form input:checked').count(), 2)
  await page.locator('#developer-form [name=name]').fill('Research agent')
  for (const checkbox of await page.locator('#developer-form [name=scope]').all()) await checkbox.check()
  await page.locator('#developer-create').click()
  await page.waitForFunction(() => document.querySelector('#developer-token').value.startsWith('bze_'))
  const apiKey = await page.locator('#developer-token').inputValue()
  assert.equal(await page.locator('#developer-token').getAttribute('type'), 'password')
  const client = new BezalelEmail({ apiKey, baseUrl: control })
  const inbox = await client.inboxes.create({ username: `sdk-${suffix}`, group: 'research' })
  const payload = { inboxId: inbox.inboxId, to: ['receiver@example.net'], text: `Fixture developer message ${suffix}`, idempotencyKey: `browser-${suffix}` }
  const first = await client.messages.send(payload)
  const env = { ...process.env, BEZALEL_API_KEY: apiKey, BEZALEL_BASE_URL: control }
  const cli = await promisify(execFile)(process.execPath, [resolve('packages/email-cli/dist/main.js'), 'messages', 'send', '--json', JSON.stringify(payload)], { env })
  const replay = JSON.parse(cli.stdout)
  assert.equal(replay.messageId, first.messageId); assert.equal(replay.deduplicated, true)
  for (let i = 0; i < 50; i++) await client.inboxes.create({ username: `sdk-${suffix}-${i}`, group: 'research' })
  const python = await promisify(execFile)('python3', ['-c', [
    'import json, os', 'from bezalel_email import BezalelEmail',
    'client=BezalelEmail(os.environ["BEZALEL_API_KEY"], os.environ["BEZALEL_BASE_URL"])',
    `inbox=client.inboxes.create(username="python-${suffix}", group="research")`,
    'client.inboxes.update(inbox_id=inbox["inboxId"], group="support")',
    'print(json.dumps({"inboxes": sum(len(page["inboxes"]) for page in client.pages("listInboxes")), "research": sum(len(page["inboxes"]) for page in client.pages("listInboxes", group="research", limit=7))}))',
  ].join('\n')], { env: { ...env, PYTHONPATH: resolve('packages/email-python') } })
  assert.deepEqual(JSON.parse(python.stdout), { inboxes: 52, research: 51 })
  const sends = await (await context.request.get(control + '/sends')).json()
  assert.equal(sends.filter(message => message.to.includes('receiver@example.net') && message.text === payload.text).length, 1)
  await page.getByRole('button', { name: 'Close API key creation', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('#developer-token').value === '')
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('#inboxes option').length === 52)
  assert.match(await page.locator('#account').textContent(), /No inbox limit/)
  assert.match(await page.locator('#inboxes option').last().textContent(), /\[support\] python-/)
  await page.locator('#developers').click()
  await page.getByRole('button', { name: 'Revoke Research agent' }).waitFor()
  assert.equal(await page.locator('#developer-created').isVisible(), false)
  const listing = await context.request.post(base + '/api/rpc/listApiKeys', { headers: { origin: base }, data: {} })
  assert.ok(!(await listing.text()).includes(apiKey))
  if (artifacts) { await mkdir(artifacts, { recursive: true }); await page.screenshot({ path: resolve(artifacts, 'developers-desktop.png') }) }
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    assert.equal(await page.locator('#api-keys-page').evaluate(element => element.scrollWidth > element.clientWidth), false)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  if (artifacts) await page.screenshot({ path: resolve(artifacts, 'developers-mobile.png') })
  await page.getByRole('button', { name: 'Revoke Research agent' }).scrollIntoViewIfNeeded()
  page.once('dialog', dialog => dialog.accept())
  await page.getByRole('button', { name: 'Revoke Research agent' }).click()
  await page.getByText('API key revoked', { exact: true }).waitFor()
  await assert.rejects(client.inboxes.list(), error => error.status === 401)
  assert.deepEqual(errors, [])
  if (artifacts) await writeFile(resolve(artifacts, 'browser-report.json'), JSON.stringify({ environment: 'Local PGlite fixture',
    providerOperations: 'Domain verification, routing, sending, and object storage are test doubles; no live delivery.',
    checks: ['passwordless fixture sign-in', 'key creation and single reveal', '52 inboxes with one key via TypeScript and Python', 'Python groups, moves, and paginates inboxes', 'dashboard loads both pages and shows groups', 'SDK send retried by CLI delivers once', 'masked key', 'close clears secret', 'listing excludes token', 'revocation denies subsequent use', 'no horizontal overflow at 320/390/768/1440'],
    passed: true, errors, deliveryAttempts: 1, inboxes: 52 }, null, 2))
})
