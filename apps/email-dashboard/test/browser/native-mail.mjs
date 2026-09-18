import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile } from 'node:fs/promises'

const base = process.env.DASHBOARD_TEST_URL ?? 'http://127.0.0.1:3198'
const control = process.env.DASHBOARD_TEST_CONTROL_URL ?? 'http://127.0.0.1:3199'
for (const value of [base, control]) { const url = new URL(value); assert.equal(url.protocol, 'http:'); assert.equal(url.hostname, '127.0.0.1') }
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright')

test('the native admin view reads separate inboxes without changing mail or exposing access to customers', { timeout: 120_000 }, async t => {
  const browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ['--no-sandbox'] })
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } }), page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  const login = async (context, email) => {
    assert.equal((await context.request.post(base + '/api/auth/email-otp/send-verification-otp', { headers: { origin: base }, data: { email, type: 'sign-in' } })).status(), 200)
    const sends = await (await context.request.get(control + '/sends')).json()
    const otp = sends.filter(message => message.to.includes(email)).at(-1).text.match(/\b\d{6}\b/)[0]
    assert.equal((await context.request.post(base + '/api/auth/sign-in/email-otp', { headers: { origin: base }, data: { email, otp, name: 'Fixture owner' } })).status(), 200)
  }
  const api = (op, body = {}, ctx = context) => ctx.request.post(base + '/api/native-rpc/' + op, { headers: { origin: base }, data: body })
  const before = await (await context.request.get(control + '/native-state')).json()
  await login(context, 'owner@example.net')
  const ordinary = await context.request.post(base + '/api/rpc/listInboxes', { headers: { origin: base }, data: {} })
  assert.deepEqual((await ordinary.json()).result.inboxes, [], 'The standalone account does not adopt native inboxes')
  await page.goto(base + '/app#/native-mail')
  await page.waitForFunction(() => document.querySelector('#native-inbox-count').textContent === '2 inboxes')
  assert.equal(await page.locator('#native-mail').isVisible(), true)
  assert.equal(await page.locator('#native-mail-page').getByRole('button', { name: /Send|Reply|Delete|Create/ }).count(), 0)
  if (process.env.NATIVE_EVIDENCE_DIR) {
    await mkdir(process.env.NATIVE_EVIDENCE_DIR, { recursive: true })
    await page.screenshot({ path: process.env.NATIVE_EVIDENCE_DIR + '/after-inboxes.png' })
  }
  await page.locator('#native-inbox-search').fill('Research')
  assert.equal(await page.locator('#native-inbox-rows tr').count(), 1)
  await page.locator('#native-inbox-rows button').click()
  await page.locator('.native-thread').waitFor()
  await page.locator('.native-thread').click()
  await page.locator('#native-conversation').getByText('The supporting notes are attached for your review.', { exact: true }).waitFor()
  assert.equal(await page.locator('.native-message').count(), 2)
  assert.equal(await page.getByRole('button', { name: 'Download summary.txt' }).count(), 2)
  if (process.env.NATIVE_EVIDENCE_DIR) await page.screenshot({ path: process.env.NATIVE_EVIDENCE_DIR + '/after-conversation.png' })
  let attachmentRequests = 0
  await context.route('https://bezalel-email.michaelwasihun96.workers.dev/attachments/**', async route => {
    attachmentRequests++
    const url = new URL(route.request().url())
    const response = await context.request.get(control + '/native-attachment' + url.pathname + url.search)
    await route.fulfill({ response })
  })
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download summary.txt' }).first().click()
  const download = await downloaded
  assert.equal(download.suggestedFilename(), 'summary.txt')
  assert.match(await readFile(await download.path(), 'utf8'), /Synthetic attachment for dashboard verification\./)
  assert.equal(attachmentRequests, 1, 'The Download button opened the signed URL through local object storage')
  await page.route('**/api/native-rpc/getAttachment', route => route.fulfill({ json: { result: { downloadUrl: 'https://example.com/unsafe' } } }))
  await page.getByRole('button', { name: 'Download summary.txt' }).first().click()
  await page.getByText('Invalid attachment URL', { exact: true }).waitFor()
  assert.equal(attachmentRequests, 1, 'Unsafe URLs never reach link activation')
  await page.unroute('**/api/native-rpc/getAttachment')
  await page.locator('#native-message-query').fill('supporting notes')
  await page.locator('#native-message-search').getByRole('button', { name: 'Search', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.native-thread').length === 1)
  await page.locator('#native-folder').selectOption('sent')
  await page.getByText('No conversations found.', { exact: true }).waitFor()
  await page.locator('#native-folder').selectOption('all')
  await page.locator('.native-thread').waitFor()
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No horizontal overflow at ${width}`)
    assert.equal(await page.locator('.workspace-content').evaluate(element => element.scrollWidth > element.clientWidth), false)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.native-thread').click()
  await page.locator('#native-conversation').getByText('The supporting notes are attached for your review.', { exact: true }).waitFor()
  if (process.env.NATIVE_EVIDENCE_DIR) await page.screenshot({ path: process.env.NATIVE_EVIDENCE_DIR + '/after-mobile.png' })
  await page.locator('#native-back').click()
  await page.waitForFunction(() => document.querySelector('#native-inbox-count').textContent === '1 inbox')
  await page.locator('#native-inbox-search').fill('Support')
  await page.locator('#native-inbox-rows button').click()
  await page.locator('.native-thread').filter({ hasText: 'Support handoff' }).click()
  await page.locator('#native-conversation').getByText('A separate inbox keeps its own conversation history.', { exact: true }).waitFor()
  assert.equal(await page.locator('#native-conversation').getByText('The supporting notes are attached for your review.', { exact: true }).count(), 0)
  const largeThreads = (await (await api('listThreads', { inboxId: 'support@example.com', includeTrash: true })).json()).result.threads
  for (const subject of ['Long archive', 'Large body archive']) {
    const thread = largeThreads.find(item => item.subject === subject)
    assert.equal((await api('getThread', { inboxId: 'support@example.com', threadId: thread.threadId, includeBodies: true })).status(), 413,
      `${subject} exceeds the real service's bulk read limit`)
    await page.locator('.native-thread').filter({ hasText: subject }).click()
    await page.getByText('This conversation is large. Open individual messages below.', { exact: true }).waitFor()
    const pageLoaded = () => page.waitForFunction(() => {
      const more = [...document.querySelectorAll('#native-conversation button')].find(button => button.textContent === 'Load more messages')
      return !more || !more.disabled
    })
    await pageLoaded()
    if (subject === 'Long archive') {
      while (await page.getByRole('button', { name: 'Load more messages', exact: true }).count()) {
        await page.getByRole('button', { name: 'Load more messages', exact: true }).click()
        await pageLoaded()
      }
      assert.equal(await page.locator('.native-message').count(), 501)
      const oldest = page.locator('.native-message').filter({ hasText: 'Archive entry 0 body.' })
      await oldest.getByRole('button', { name: 'Read message', exact: true }).click()
      await oldest.locator('.native-message-body').getByText('Archive entry 0 body.', { exact: true }).waitFor()
    } else {
      assert.equal(await page.locator('.native-message').count(), 9)
      const newest = page.locator('.native-message').first()
      await newest.getByRole('button', { name: 'Read message', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('.native-message-body')?.textContent.length > 1048576)
      assert.match(await newest.locator('.native-message-body').textContent(), /^Large body entry 8\./)
    }
    assert.equal(await page.getByText('Loading conversation…', { exact: true }).count(), 0)
    if (process.env.NATIVE_EVIDENCE_DIR) await page.screenshot({ path: process.env.NATIVE_EVIDENCE_DIR + '/' + subject.replaceAll(' ', '-') + '.png' })
  }
  assert.equal(await page.locator('.native-thread').filter({ hasText: 'Deleted note' }).count(), 0, 'All mail excludes trashed conversations')
  await page.locator('#native-folder').selectOption('trash')
  await page.locator('.native-thread').filter({ hasText: 'Deleted note' }).waitFor()
  assert.equal(await page.locator('.native-thread').count(), 1)
  await page.locator('.native-thread').click()
  await page.locator('#native-conversation').getByText('This note belongs only in Trash.', { exact: true }).waitFor()
  await page.route('**/api/native-rpc/getThread', route => route.fulfill({ status: 502, json: { error: 'Fixture read unavailable' } }))
  await page.locator('.native-thread').click()
  await page.getByText('Could not open this conversation. Select it to try again.', { exact: true }).waitFor()
  assert.equal(await page.getByText('Loading conversation…', { exact: true }).count(), 0)
  await page.unroute('**/api/native-rpc/getThread')
  await page.locator('.native-thread').click()
  await page.locator('#native-conversation').getByText('This note belongs only in Trash.', { exact: true }).waitFor()
  await page.reload()
  await page.waitForFunction(() => document.querySelector('#native-inbox-count').textContent === '2 inboxes')
  for (const operation of ['send', 'reply', 'deleteInbox', 'updateThreadLabels', 'getCredentials']) assert.equal((await api(operation)).status(), 404)
  const customer = await browser.newContext()
  await login(customer, `customer-${crypto.randomUUID().slice(0, 8)}@example.net`)
  assert.equal((await api('listInboxes', {}, customer)).status(), 403)
  const customerPage = await customer.newPage()
  await customerPage.goto(base + '/app#/native-mail')
  await customerPage.waitForURL('**/app#/inboxes')
  assert.equal(await customerPage.locator('#native-mail').isVisible(), false)
  assert.equal(await customerPage.locator('#native-inbox-rows tr').count(), 0)
  assert.equal((await context.request.post(base + '/api/logout', { headers: { origin: base }, data: {} })).status(), 200)
  assert.equal((await api('listInboxes')).status(), 401)
  assert.deepEqual(await (await context.request.get(control + '/native-state')).json(), before, 'Original native data and ownership remain byte-for-byte unchanged')
  assert.deepEqual(errors, [])
})
