import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accessDashboardHandler } from '../src/access-handler.mjs'
import { customerMailClient } from '../src/service.mjs'

const origin = 'https://dashboard.example'
test('Access dashboard forwards only the identity assertion and rejects password, cookie, host and CSRF bypasses', async () => {
  const calls = []
  const client = customerMailClient({ workerUrl: 'https://mail.example', request: async (url, init) => {
    calls.push({ url: String(url), ...init })
    return Response.json({ result: { customer: { email: 'a@example.net', role: 'customer' }, defaultDomain: 'agents.example.com' } })
  } })
  const handle = accessDashboardHandler({ client, publicUrl: origin, asset: () => 'dashboard' })
  const request = (path, input, headers = {}, base = origin) => handle(new Request(base + path, {
    method: input === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', ...headers },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  }))
  assert.deepEqual(await (await request('/api/session')).json(), { authenticated: false, authMode: 'access' })
  assert.equal((await request('/api/rpc/listInboxes', {}, { cookie: '__Host-mail-session=old-owner-cookie' })).status, 401)
  assert.equal((await request('/api/rpc/listInboxes', {}, { 'cf-access-authenticated-user-email': 'owner@example.net' })).status, 401)
  assert.equal((await request('/api/login', { password: 'old-password' })).status, 401)
  const assertion = { 'cf-access-jwt-assertion': 'signed.identity.assertion' }
  const session = await request('/api/session', undefined, assertion)
  assert.equal(session.status, 200)
  assert.equal((await session.json()).customer.email, 'a@example.net')
  assert.equal(calls[0].headers.authorization, 'Bearer signed.identity.assertion')
  assert.equal(calls[0].url, 'https://mail.example/dashboard-rpc/session')
  assert.equal((await request('/api/rpc/listInboxes', {}, assertion)).status, 200)
  assert.equal((await request('/api/rpc/listInboxes', {}, { ...assertion, origin: 'https://attacker.example' })).status, 403)
  assert.equal((await request('/api/rpc/listInboxes', {}, assertion, 'https://attacker.example')).status, 403)
  assert.equal((await request('/api/rpc/listInboxes', {}, { ...assertion, 'content-type': 'text/plain' })).status, 415)
  assert.equal((await request('/api/rpc/provision', {}, assertion)).status, 404)
  assert.equal((await request('/api/login', {}, assertion)).status, 404)
  assert.equal((await request('/api/rpc/listInboxes', { body: 'x'.repeat(5 * 1024 * 1024) }, assertion)).status, 413)
  assert.equal(calls.length, 2)
  assert.deepEqual(await (await request('/api/logout', {}, assertion)).json(), { logoutUrl: '/cdn-cgi/access/logout' })
  const page = await request('/')
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  assert.equal(page.headers.get('cache-control'), 'no-store')
  assert.equal((await request('/.env')).status, 404)
})

test('Access errors never fall back to a platform credential', async () => {
  let requests = 0
  const client = customerMailClient({ workerUrl: 'https://mail.example', apiToken: 'unused-platform-secret', request: async () => {
    requests++
    return Response.json({ error: { message: 'Your sign-in expired or could not be verified' } }, { status: 401 })
  } })
  await assert.rejects(client.execute('listInboxes', {}, ''), { status: 401 })
  await assert.rejects(client.execute('listInboxes', {}, 'bad token'), { status: 401 })
  await assert.rejects(client.execute('listInboxes', {}, 'forged'), { status: 401 })
  assert.equal(requests, 1)
})
