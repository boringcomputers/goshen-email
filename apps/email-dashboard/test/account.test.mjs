import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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

function pageRequest(path, streamed = false) {
  const handler = accountDashboardHandler({ publicUrl: origin, workerUrl: 'https://mail.example.com', proxySecret: 'fixture-proxy-secret-'.repeat(3),
    asset: async (name) => {
      const body = await readFile(new URL(`../public/${name}`, import.meta.url))
      return streamed ? new Response(body).body : body
    },
    request: async () => { throw new Error('Rendering account pages must not call the account service') },
  })
  return handler(new Request(origin + path))
}
const tag = (html, id) => html.match(new RegExp(`<[^>]+\\bid="${id}"[^>]*>`))?.[0]

test('serves final sign-in and sign-up layouts before JavaScript runs for Node and Worker assets', async () => {
  for (const streamed of [false, true]) {
    for (const signup of [false, true]) {
      const response = await pageRequest(signup ? '/sign-up' : '/sign-in', streamed)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/)
      const html = await response.text()
      assert.doesNotMatch(html, /\{\{[a-z-]+\}\}/)
      assert.match(html, signup ? /<title>Sign up — Goshen Email<\/title>/ : /<title>Sign in — Goshen Email<\/title>/)
      assert.match(html, signup ? /<h1 id="title">Make room for your email\.<\/h1>/ : /<h1 id="title">Welcome back\.<\/h1>/)
      assert.match(html, signup ? /Create your account with a sign-in link or email code\./ : /A link or a code\. Your inbox is one email away\./)
      assert.equal(/\bhidden\b/.test(tag(html, 'name-field')), !signup)
      assert.equal(/\brequired\b/.test(tag(html, 'name')), signup)
      assert.doesNotMatch(tag(html, 'email-field'), /\bhidden\b/)
      assert.match(tag(html, 'email'), /\brequired\b/)
      assert.doesNotMatch(tag(html, 'method-field'), /\bhidden\b/)
      assert.doesNotMatch(tag(html, 'submit'), /\bdisabled\b/)
      assert.match(html, signup ? /Already have an account\? <a href="\/sign-in">Sign in<\/a>/ : /New to Goshen Email\? <a href="\/sign-up">Create an account<\/a>/)
    }
  }
})
test('serves the magic-link confirmation layout with client verification still required', async () => {
  const response = await pageRequest('/magic-link?token=do-not-reflect-this-token&email=private%40example.net', true)
  const html = await response.text()
  assert.match(html, /<h1 id="title">You’re one click away\.<\/h1>/)
  assert.match(tag(html, 'name-field'), /\bhidden\b/)
  assert.match(tag(html, 'email-field'), /\bhidden\b/)
  assert.doesNotMatch(tag(html, 'email'), /\brequired\b/)
  assert.match(tag(html, 'method-field'), /\bhidden\b/)
  assert.match(tag(html, 'submit'), /\bdisabled\b/)
  assert.match(html, /Continue to workspace <span/)
  assert.match(html, /<a href="\/sign-in">Request a new sign-in email<\/a>/)
  assert.doesNotMatch(html, /do-not-reflect-this-token|private@example\.net|\{\{[a-z-]+\}\}/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
})
test('renders known account errors initially without reflecting query values', async () => {
  const denied = await (await pageRequest('/sign-in?reason=access_denied&error=invalid')).text()
  assert.match(denied, /<p id="error" class="error" role="alert">Your account does not have access to this workspace\. Contact the owner\.<\/p>/)
  const invalid = await (await pageRequest('/sign-in?error=%3Cscript%3Euntrusted%3C%2Fscript%3E')).text()
  assert.match(invalid, /<p id="error" class="error" role="alert">This sign-in link is invalid, expired, or already used\. Request a new one below\.<\/p>/)
  assert.doesNotMatch(invalid, /untrusted/)
})
test('replaces spoofed credentials and IP headers and keeps all session cookies', async () => {
  result = Response.json({ status: true }, { headers: [['set-cookie', 'one=1; HttpOnly'], ['set-cookie', 'two=2; HttpOnly']] })
  const response = await request('/api/auth/sign-in/magic-link', { email: 'a@example.net' }, { authorization: 'forged', 'x-bezalel-client-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.1', cookie: 'session=real' })
  const sent = calls.at(-1)
  assert.equal(sent.init.headers.get('x-bezalel-client-ip'), '192.0.2.9')
  assert.equal(sent.init.headers.get('x-forwarded-for'), null)
  assert.equal(sent.init.headers.get('authorization'), 'Bearer ' + 'fixture-proxy-secret-'.repeat(3))
  assert.equal(sent.init.headers.get('cookie'), 'session=real')
  // Upstream session cookies pass through unchanged; the sign-in step also clears the workspace marker.
  assert.deepEqual(response.headers.getSetCookie(), ['one=1; HttpOnly', 'two=2; HttpOnly', '__Host-workspace=; Path=/; SameSite=Strict; Max-Age=0; Secure'])
})
test('rejects cross-origin mutations and private operations outside the allowlist', async () => {
  const count = calls.length
  assert.equal((await request('/api/auth/sign-in/magic-link', {}, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await request('/api/logout', {}, { origin: '' })).status, 403)
  assert.equal((await request('/api/rpc/updateSettings', { organizationName: 'Forged' }, { origin: 'https://evil.example' })).status, 403)
  assert.equal((await request('/api/rpc/anything', {})).status, 404)
  assert.equal((await request('/api/rpc/session', {})).status, 404)
  assert.equal(calls.length, count)
})
test('shows anonymous sessions, requires POST for link confirmation, and returns sign-out navigation', async () => {
  result = Response.json({ error: { message: 'Sign in' } }, { status: 401 })
  assert.deepEqual(await (await request('/api/session')).json(), { authenticated: false, authMode: 'account' })
  assert.equal((await request('/api/auth/magic-link/verify?token=fixture')).status, 404)
  result = Response.json({ success: true }, { headers: { 'set-cookie': 'one=; Max-Age=0' } })
  const logout = await request('/api/logout', {})
  assert.deepEqual(await logout.json(), { authenticated: false, logoutUrl: '/sign-in' })
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/)
})
