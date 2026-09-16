import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { dashboardServer } from '../src/server.mjs'
import { mailClient } from '../src/service.mjs'

const password = 'dashboard-test-password-'.repeat(3)
const publicUrl = 'http://127.0.0.1:3031'
async function fixture(t, options = {}) {
  const calls = []
  let time = Date.now()
  const server = dashboardServer({ password, publicUrl, now: () => time, ...options,
    client: { execute: async (...args) => { calls.push(args); return { inboxes: [] } } },
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }))
  const url = `http://127.0.0.1:${server.address().port}`
  const request = (path, body, headers = {}, localAddress = '127.0.0.1') => new Promise((resolve, reject) => {
    const req = httpRequest(url + path, {
      localAddress,
      method: body === undefined ? 'GET' : 'POST',
      headers: { host: '127.0.0.1:3031', origin: publicUrl, 'content-type': 'application/json', ...headers },
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode,
        headers: Object.fromEntries(Object.entries(res.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])),
      })))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
  const login = async () => {
    const response = await request('/api/login', { password })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/)
    return response.headers.get('set-cookie').split(';')[0]
  }
  return { calls, request, login, advance: (ms) => { time += ms } }
}

test('sessions gate email, expire, and are revoked by logout', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.request('/api/rpc/listInboxes', {})).status, 401)
  const cookie = await f.login()
  assert.equal((await f.request('/api/rpc/listInboxes', {}, { cookie })).status, 200)
  assert.deepEqual(f.calls, [['listInboxes', {}]])
  assert.equal((await f.request('/api/logout', {}, { cookie })).status, 200)
  assert.equal((await f.request('/api/rpc/listInboxes', {}, { cookie })).status, 401)
  const next = await f.login()
  f.advance(8 * 60 * 60 * 1000)
  assert.equal((await f.request('/api/rpc/listInboxes', {}, { cookie: next })).status, 401)
})
test('rejects forged sessions, cross-origin requests, and host rebinding before dispatch', async (t) => {
  const f = await fixture(t), cookie = await f.login()
  assert.equal((await f.request('/api/rpc/send', {}, { cookie: cookie + 'forged' })).status, 401)
  assert.equal((await f.request('/api/rpc/send', {}, { cookie, origin: 'https://attacker.example' })).status, 403)
  assert.equal((await f.request('/api/rpc/send', {}, { cookie, host: 'attacker.example' })).status, 403)
  assert.equal((await f.request('/api/rpc/send', {}, { cookie, host: '[' })).status, 403)
  assert.equal((await f.request('/api/rpc/send', {}, { cookie, 'content-type': 'text/plain' })).status, 415)
  assert.equal((await f.request('/api/rpc/ensureWebhook', {}, { cookie })).status, 404)
  assert.equal((await f.request('/api/clients/provision', {}, { cookie })).status, 404)
  assert.deepEqual(f.calls, [])
})
test('bounds password attempts and requires a strong configuration', async (t) => {
  const f = await fixture(t)
  for (let index = 0; index < 5; index++) assert.equal((await f.request('/api/login', { password: 'wrong' })).status, 401)
  assert.equal((await f.request('/api/login', { password })).status, 429)
  f.advance(60_000)
  await f.login()
  assert.throws(() => dashboardServer({ password: 'weak', publicUrl }), /32 characters/)
  assert.throws(() => dashboardServer({ password, publicUrl: 'http://public.example' }), /HTTPS/)
})
test('an existing session can renew when all session slots are occupied', async (t) => {
  const f = await fixture(t)
  const first = await f.login()
  for (let index = 1; index < 100; index++) await f.login()
  assert.equal((await f.request('/api/login', { password })).status, 429)
  const renewed = await f.request('/api/login', { password }, { cookie: first })
  assert.equal(renewed.status, 200)
  const cookie = renewed.headers.get('set-cookie').split(';')[0]
  assert.notEqual(cookie, first)
  assert.deepEqual(await (await f.request('/api/session', undefined, { cookie: first })).json(), { authenticated: false })
  assert.deepEqual(await (await f.request('/api/session', undefined, { cookie })).json(), { authenticated: true })
})
test('failed logins do not lock out another connection and forwarded headers cannot bypass the throttle', async (t) => {
  const f = await fixture(t)
  for (let index = 0; index < 5; index++) {
    assert.equal((await f.request('/api/login', { password: 'wrong' }, { 'x-real-ip': `192.0.2.${index + 1}` }, '127.0.0.2')).status, 401)
  }
  assert.equal((await f.request('/api/login', { password }, { 'x-real-ip': '192.0.2.99' }, '127.0.0.2')).status, 429)
  assert.equal((await f.request('/api/login', { password }, {}, '127.0.0.3')).status, 200)
})
test('only a configured proxy can supply independent client identities', async (t) => {
  const f = await fixture(t, { trustedProxyIps: ['127.0.0.1'] })
  assert.equal((await f.request('/api/login', { password })).status, 400)
  assert.equal((await f.request('/api/login', { password }, { 'x-real-ip': 'not-an-ip' })).status, 400)
  for (let index = 0; index < 5; index++) assert.equal((await f.request('/api/login', { password: 'wrong' }, { 'x-real-ip': '192.0.2.1' })).status, 401)
  assert.equal((await f.request('/api/login', { password }, { 'x-real-ip': '192.0.2.1' })).status, 429)
  assert.equal((await f.request('/api/login', { password }, { 'x-real-ip': '192.0.2.2' })).status, 200)
  f.advance(60_000)
  assert.equal((await f.request('/api/login', { password }, { 'x-real-ip': '192.0.2.1' })).status, 200)
})
test('concurrent attempts share the same per-client budget', async (t) => {
  const f = await fixture(t)
  const responses = await Promise.all(Array.from({ length: 12 }, () => f.request('/api/login', { password: 'wrong' }, {}, '127.0.0.2')))
  assert.equal(responses.filter((response) => response.status === 401).length, 5)
  assert.equal(responses.filter((response) => response.status === 429).length, 7)
  assert.equal((await f.request('/api/login', { password }, {}, '127.0.0.3')).status, 200)
})
test('serves only fixed assets with an inert HTML policy and no configuration secrets', async (t) => {
  const f = await fixture(t)
  const page = await f.request('/')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  const body = await page.text()
  assert.match(body, /<title>Bezalel Email \| Inboxes for people and agents<\/title>/)
  for (const path of ['/app', '/app/']) {
    const app = await f.request(path)
    assert.equal(app.status, 200)
    const html = await app.text()
    assert.match(html, /Bezalel Email/)
    assert.equal(html.includes(password), false)
  }
  assert.equal((await f.request('/dashboard.html')).status, 404)
  assert.equal(body.includes(password), false)
  assert.equal((await f.request('/.env')).status, 404)
  assert.equal((await f.request('/src/server.mjs')).status, 404)
})
test('the mail client fixes the upstream origin, keeps credentials server-side, and binds the reviewer', async () => {
  const calls = []
  const client = mailClient({ workerUrl: 'https://worker.example', apiToken: 'a'.repeat(32), request: async (...args) => {
    calls.push(args); return Response.json({ result: { released: true } })
  } })
  assert.deepEqual(await client.execute('releaseQuarantine', { messageId: '1', reviewedBy: 'forged' }), { released: true })
  assert.equal(calls[0][0].href, 'https://worker.example/rpc/releaseQuarantine')
  assert.equal(calls[0][1].redirect, 'manual')
  assert.equal(JSON.parse(calls[0][1].body).reviewedBy, 'standalone-dashboard-owner')
  assert.equal(calls[0][1].headers.authorization, `Bearer ${'a'.repeat(32)}`)
  await assert.rejects(client.execute('../clients/provision', {}), /Unknown/)
  assert.throws(() => mailClient({ workerUrl: 'http://worker.example', apiToken: 'a'.repeat(32) }), /HTTPS/)
})
test('upstream connection failures do not expose credentials or private network errors', async () => {
  const client = mailClient({ workerUrl: 'https://worker.example', apiToken: 'private-token-'.repeat(4), request: async () => {
    throw new Error('private-token and database details')
  } })
  await assert.rejects(client.execute('send', {}), (error) => error.status === 502 && !error.message.includes('private-token'))
})

test('design tokens and Inter are served locally under a self-only font policy', async (t) => {
  const f = await fixture(t)
  const css = await f.request('/tokens.css')
  assert.equal(css.status, 200)
  assert.match(css.headers.get('content-type'), /^text\/css/)
  assert.match(await css.text(), /--font-sans: Inter/)
  const font = await f.request('/fonts/InterVariable.woff2')
  assert.equal(font.status, 200)
  assert.equal(font.headers.get('content-type'), 'font/woff2')
  assert.equal(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString(), 'wOF2')
  assert.match(font.headers.get('content-security-policy'), /font-src 'self';/)
  assert.equal((await f.request('/fonts/../../.env')).status, 404)
})
