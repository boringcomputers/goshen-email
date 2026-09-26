import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assets, dashboardHandler } from '../src/handler.mjs'
import { accessDashboardHandler } from '../src/access-handler.mjs'
import { accountDashboardHandler } from '../src/account-handler.mjs'

const origin = 'https://dashboard.example'
const fontPath = '/fonts/InterVariable.woff2'
const fontPaths = [fontPath, '/fonts/GeistVariable.woff2', '/fonts/GeistMonoVariable.woff2']
const password = 'cache-test-dashboard-password-'.repeat(2)
const configurations = [
  { name: 'password', create: (asset) => dashboardHandler({ publicUrl: origin, password, asset }),
    authPath: '/api/login', authBody: { password } },
  { name: 'Access', create: (asset) => accessDashboardHandler({ publicUrl: origin, asset,
    client: { execute: async () => ({ customer: { email: 'owner@example.net' } }) } }),
    authPath: '/api/logout', authBody: {} },
  { name: 'account', create: (asset) => accountDashboardHandler({ publicUrl: origin, asset,
    workerUrl: 'https://mail.example', proxySecret: 'cache-test-proxy-secret-'.repeat(2),
    request: async () => Response.json({ result: { customer: { email: 'owner@example.net' } } },
      { headers: { 'set-cookie': 'session=private; HttpOnly' } }) }),
    authPath: '/api/auth/sign-in/magic-link', authBody: { email: 'owner@example.net' },
    pages: ['/sign-in', '/sign-up', '/magic-link', '/auth.css', '/auth.js'] },
]

function request(handle, path, { body, base = origin } = {}) {
  return handle(new Request(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', cookie: 'session=private',
      'cf-access-jwt-assertion': 'fixture-identity', authorization: 'Bearer private' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { clientIdentity: () => '192.0.2.1' })
}

for (const configuration of configurations) {
  test(`${configuration.name} caches only the public fonts and keeps private responses out of caches`, async () => {
    const handle = configuration.create(async (file) => file)
    for (const path of fontPaths) {
      const font = await request(handle, path)
      assert.equal(font.status, 200, path)
      assert.equal(font.headers.get('cache-control'), 'public, max-age=3600', path)
      assert.equal(font.headers.get('content-type'), 'font/woff2')
      assert.equal(font.headers.get('x-content-type-options'), 'nosniff')
      assert.match(font.headers.get('content-security-policy'), /font-src 'self';/)
      assert.equal(font.headers.get('set-cookie'), null)
      assert.equal(font.headers.get('authorization'), null)
      assert.equal(await font.text(), path.slice(1))
    }

    const privatePaths = [...assets.keys(), ...(configuration.pages ?? []), '/api/session', '/healthz']
    for (const path of privatePaths.filter((path) => !fontPaths.includes(path))) {
      const response = await request(handle, path)
      assert.equal(response.status, 200, path)
      assert.equal(response.headers.get('cache-control'), 'no-store', path)
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/, path)
    }
    const auth = await request(handle, configuration.authPath, { body: configuration.authBody })
    assert.equal(auth.status, 200)
    assert.equal(auth.headers.get('cache-control'), 'no-store')
    if (configuration.name !== 'Access') assert.match(auth.headers.get('set-cookie'), /HttpOnly/)
  })

  test(`${configuration.name} never caches font failures or rejected requests`, async () => {
    const handle = configuration.create(async () => { throw new Error('asset unavailable') })
    const missing = await request(handle, fontPath)
    assert.ok(missing.status >= 500)
    assert.equal(missing.headers.get('cache-control'), 'no-store')
    assert.match(missing.headers.get('content-type'), /^application\/json/)
    const invalidHost = await request(handle, fontPath, { base: 'https://attacker.example' })
    assert.equal(invalidHost.status, 403)
    assert.equal(invalidHost.headers.get('cache-control'), 'no-store')
    const unknown = await request(handle, '/api/private.woff2')
    assert.equal(unknown.status, 404)
    assert.equal(unknown.headers.get('cache-control'), 'no-store')
    const mutation = await request(handle, fontPath, { body: {} })
    assert.ok(mutation.status >= 400)
    assert.equal(mutation.headers.get('cache-control'), 'no-store')
  })
}
