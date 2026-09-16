import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountDashboardHandler } from '../src/account-handler.mjs'

const origin = 'https://dashboard.example.com'
const calls = []
let result
const handle = accountDashboardHandler({ publicUrl: origin, workerUrl: 'https://mail.example.com', proxySecret: 'fixture-proxy-secret-'.repeat(3),
  asset: async (name) => name, request: async (url, init) => { calls.push({ url, init }); return result } })
const request = (path, body, headers = {}) => handle(new Request(origin + path, {
  method: body === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
}), { clientIdentity: () => '192.0.2.9' })

test('serves the account pages and assets with the existing CSP', async () => {
  for (const path of ['/sign-in', '/sign-up', '/forgot-password', '/reset-password', '/verify-email']) {
    const response = await request(path)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'auth.html')
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  }
})
test('replaces spoofed credentials and IP headers and keeps all session cookies', async () => {
  result = Response.json({ status: true }, { headers: [['set-cookie', 'one=1; HttpOnly'], ['set-cookie', 'two=2; HttpOnly']] })
  const response = await request('/api/auth/sign-in/email', { email: 'a@example.net' }, { authorization: 'forged', 'x-bezalel-client-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.1', cookie: 'session=real' })
  const sent = calls.at(-1)
  assert.equal(sent.init.headers.get('x-bezalel-client-ip'), '192.0.2.9')
  assert.equal(sent.init.headers.get('x-forwarded-for'), null)
  assert.equal(sent.init.headers.get('authorization'), 'Bearer ' + 'fixture-proxy-secret-'.repeat(3))
  assert.equal(sent.init.headers.get('cookie'), 'session=real')
  assert.deepEqual(response.headers.getSetCookie(), ['one=1; HttpOnly', 'two=2; HttpOnly'])
})
test('rejects cross-origin mutations and private operations outside the allowlist', async () => {
  const count = calls.length
  assert.equal((await request('/api/auth/sign-up/email', {}, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await request('/api/logout', {}, { origin: '' })).status, 403)
  assert.equal((await request('/api/rpc/anything', {})).status, 404)
  assert.equal((await request('/api/rpc/session', {})).status, 404)
  assert.equal(calls.length, count)
})
test('shows anonymous sessions, forwards verification redirects, and returns sign-out navigation', async () => {
  result = Response.json({ error: { message: 'Sign in' } }, { status: 401 })
  assert.deepEqual(await (await request('/api/session')).json(), { authenticated: false, authMode: 'account' })
  result = new Response(null, { status: 302, headers: { location: origin + '/reset-password?token=fixture', 'set-cookie': 'one=1' } })
  const redirect = await request('/api/auth/reset-password/fixture?callbackURL=' + encodeURIComponent(origin + '/reset-password'))
  assert.equal(redirect.status, 302)
  assert.equal(redirect.headers.get('location'), origin + '/reset-password?token=fixture')
  result = Response.json({ success: true }, { headers: { 'set-cookie': 'one=; Max-Age=0' } })
  const logout = await request('/api/logout', {})
  assert.deepEqual(await logout.json(), { authenticated: false, logoutUrl: '/sign-in' })
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/)
})
