import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GoshenEmailClient, GoshenEmailError, prepareRequest } from '../dist/index.js'
const apiKey = 'bze_test-secret'
test('encodes identifiers and repeated query arrays without logging credentials', () => {
  const request = prepareRequest('getMessage', { inboxId: 'me@example.com', messageId: '<a/b@example.net>', includeHtml: true })
  assert.ok(request.url.endsWith('/me%40example.com/messages/%3Ca%2Fb%40example.net%3E?includeHtml=true'))
  assert.equal(request.method, 'GET')
  assert.ok(!('body' in request))
  assert.ok(prepareRequest('listMessages', { inboxId: 'me@example.com', labels: ['received', 'unread'], limit: 10 }).url.includes('labels=received&labels=unread'))
})
test('rejects unsafe base origins and platform credentials', () => {
  for (const baseUrl of ['http://example.com', 'https://a:b@example.com', 'https://example.com/path', 'https://example.com?key=x'])
    assert.throws(() => new GoshenEmailClient({ apiKey, baseUrl }))
  assert.throws(() => new GoshenEmailClient({ apiKey: 'platform-secret' }))
})
test('never follows redirects or automatically retries sends after uncertain failures', async () => {
  let calls = 0
  const client = new GoshenEmailClient({ apiKey, fetch: async (_url, options) => { calls++; assert.equal(options.redirect, 'manual'); throw new Error('network failed with ' + apiKey) } })
  await assert.rejects(client.messages.send({ inboxId: 'me@example.com', to: ['you@example.net'], text: 'hello', idempotencyKey: 'stable-key' }), error => {
    assert.equal(error.code, 'network_error'); assert.equal(error.transient, true); assert.ok(!String(error).includes(apiKey)); return true
  })
  assert.equal(calls, 1)
})
test('preserves structured API errors and redacts keys from error messages', async () => {
  const client = new GoshenEmailClient({ apiKey, fetch: async () => Response.json({ error: { message: apiKey, code: 'insufficient_scope', transient: false } }, { status: 403 }) })
  await assert.rejects(client.inboxes.list(), error => error instanceof GoshenEmailError && error.status === 403 && error.message === '[redacted]')
})
test('pagination rejects a repeated cursor instead of looping forever', async () => {
  const client = new GoshenEmailClient({ apiKey, fetch: async () => Response.json({ messages: [], nextPageToken: 'same' }) })
  let pages = 0
  await assert.rejects(async () => { for await (const page of client.pages('listMessages', { inboxId: 'me@example.com' })) pages++ }, /repeated/)
  assert.equal(pages, 2)
})
test('caller cancellation is non-retryable before dispatch and while a request is running', async () => {
  const controller = new AbortController()
  let calls = 0
  const client = new GoshenEmailClient({ apiKey, fetch: async (_url, { signal }) => {
    calls++
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } })
  const cancelled = error => error.code === 'request_cancelled' && error.transient === false && !error.message.includes('Retry')
  controller.abort()
  await assert.rejects(client.request('listInboxes', {}, { signal: controller.signal }), cancelled)
  assert.equal(calls, 0)
  const active = new AbortController(), request = client.request('listInboxes', {}, { signal: active.signal })
  active.abort()
  await assert.rejects(request, cancelled)
  assert.equal(calls, 1)
})
