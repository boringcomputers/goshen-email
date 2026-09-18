import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unstable_dev } from 'wrangler'

const password = 'workers-test-password-'.repeat(3)
const origin = 'https://dashboard.example'

test('Cloudflare account mode separates native reads from standalone mail and blocks other identities', { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'email-dashboard-native-'))
  const config = join(directory, 'wrangler.json')
  await writeFile(config, JSON.stringify({ name: 'email-dashboard-native-test', main: resolve('test/fixtures/worker.mjs'),
    compatibility_date: '2026-09-06', compatibility_flags: ['nodejs_compat'],
    vars: { DASHBOARD_AUTH_MODE: 'account', DASHBOARD_PUBLIC_URL: origin, MAIL_WORKER_URL: 'https://standalone.example.com',
      AUTH_PROXY_SECRET: 'fixture-proxy-'.repeat(4), NATIVE_MAIL_WORKER_URL: 'https://bezalel-email.michaelwasihun96.workers.dev',
      NATIVE_MAIL_API_TOKEN: 'fixture-native-'.repeat(4), NATIVE_MAIL_ADMIN_EMAILS: 'owner@example.net' },
  }))
  const worker = await unstable_dev(resolve('test/fixtures/worker.mjs'), { config, local: true, ip: '127.0.0.1', port: 0, inspectorPort: 0,
    logLevel: 'error', experimental: { disableExperimentalWarning: true, disableDevRegistry: true } })
  t.after(async () => { await worker.stop(); await rm(directory, { recursive: true, force: true }) })
  const request = (path, cookie = 'fixture=owner') => worker.fetch(origin + path, { method: path === '/api/session' ? 'GET' : 'POST',
    headers: { cookie, 'content-type': 'application/json' }, ...(path === '/api/session' ? {} : { body: '{}' }) })
  assert.equal((await (await request('/api/session')).json()).nativeMailEnabled, true)
  assert.equal((await (await request('/api/session', 'fixture=customer')).json()).nativeMailEnabled, false)
  assert.equal((await request('/api/native-rpc/listInboxes', 'fixture=customer')).status, 403)
  assert.equal((await request('/api/native-rpc/listInboxes', 'forged')).status, 401)
  assert.equal((await request('/api/native-rpc/send')).status, 404)
  assert.deepEqual((await (await request('/api/native-rpc/listInboxes')).json()).result.inboxes, [{ inboxId: 'native@goshenemail.com' }])
  assert.deepEqual((await (await request('/api/rpc/listInboxes')).json()).result.inboxes, [{ inboxId: 'standalone@example.com' }])
})

test('Cloudflare persists sessions, throttles and logout across process restarts', { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'email-dashboard-test-'))
  const config = join(directory, 'wrangler.json')
  await writeFile(config, JSON.stringify({
    name: 'email-dashboard-runtime-test', main: resolve('test/fixtures/worker.mjs'),
    compatibility_date: '2026-09-06', compatibility_flags: ['nodejs_compat'],
    assets: { directory: resolve('public'), binding: 'ASSETS', run_worker_first: true, html_handling: 'none' },
    durable_objects: { bindings: [{ name: 'DASHBOARD', class_name: 'Dashboard' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Dashboard'] }],
    vars: { DASHBOARD_AUTH_MODE: 'password', DASHBOARD_PASSWORD: password, DASHBOARD_PUBLIC_URL: origin,
      MAIL_WORKER_URL: 'https://mail.example', MAIL_API_TOKEN: 'test-token-'.repeat(5) },
  }))
  let worker
  const start = async (vars = {}) => {
    worker = await unstable_dev(resolve('test/fixtures/worker.mjs'), {
      config, local: true, ip: '127.0.0.1', port: 0, inspectorPort: 0, logLevel: 'error',
      persist: true, persistTo: join(directory, 'storage'), vars,
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
    })
  }
  t.after(async () => { await worker?.stop(); await rm(directory, { recursive: true, force: true }) })
  const request = (path, body, headers = {}) => worker.fetch(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', 'cf-connecting-ip': '192.0.2.1', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  await start()
  const page = await request('/')
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<title>Bezalel Email \| Inboxes for people and agents<\/title>/)
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
  for (const path of ['/app', '/app/']) {
    const app = await request(path)
    assert.equal(app.status, 200)
    assert.match(await app.text(), /Bezalel Email/)
  }
  assert.equal((await request('/dashboard.html')).status, 404)
  assert.equal((await request('/.env')).status, 404)
  assert.equal((await request('/api/rpc/listInboxes', {})).status, 401)
  const login = await request('/api/login', { password })
  assert.equal(login.status, 200)
  assert.match(login.headers.get('set-cookie'), /__Host-mail-session=.*HttpOnly; SameSite=Strict;.*Secure/)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  for (let n = 0; n < 5; n++) assert.equal((await request('/api/login', { password: 'wrong' })).status, 401)
  await worker.stop(); await start()
  assert.deepEqual(await (await request('/api/session', undefined, { cookie })).json(), { authenticated: true })
  assert.equal((await request('/api/login', { password })).status, 429)
  assert.equal((await request('/api/rpc/listInboxes', {}, { cookie, 'x-test-origin': 'https://attacker.example' })).status, 403)
  assert.equal((await request('/api/logout', {}, { cookie })).status, 200)
  await worker.stop(); await start()
  assert.deepEqual(await (await request('/api/session', undefined, { cookie })).json(), { authenticated: false })
  const next = await request('/api/login', { password }, { 'x-test-ip': '192.0.2.2' })
  const nextCookie = next.headers.get('set-cookie').split(';')[0]
  await worker.stop(); await start({ DASHBOARD_PASSWORD: password + 'rotated' })
  assert.deepEqual(await (await request('/api/session', undefined, { cookie: nextCookie })).json(), { authenticated: false })
  assert.equal((await request('/api/login', { password })).status, 401)
})


test('Cloudflare customer mode forwards Access assertions without password secrets or owner sessions', { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'email-dashboard-access-'))
  const config = join(directory, 'wrangler.json')
  await writeFile(config, JSON.stringify({
    name: 'email-dashboard-access-test', main: resolve('test/fixtures/worker.mjs'),
    compatibility_date: '2026-09-06', compatibility_flags: ['nodejs_compat'],
    assets: { directory: resolve('public'), binding: 'ASSETS', run_worker_first: true, html_handling: 'none' },
    durable_objects: { bindings: [{ name: 'DASHBOARD', class_name: 'Dashboard' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Dashboard'] }],
    vars: { DASHBOARD_AUTH_MODE: 'access', DASHBOARD_PUBLIC_URL: origin, MAIL_WORKER_URL: 'https://mail.example' },
  }))
  const worker = await unstable_dev(resolve('test/fixtures/worker.mjs'), {
    config, local: true, ip: '127.0.0.1', port: 0, inspectorPort: 0, logLevel: 'error',
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
  })
  t.after(async () => { await worker.stop(); await rm(directory, { recursive: true, force: true }) })
  const homepage = await worker.fetch(origin)
  assert.equal(homepage.status, 200)
  assert.match(await homepage.text(), /<title>Bezalel Email \| Inboxes for people and agents<\/title>/)
  for (const path of ['/app', '/app/']) {
    const app = await worker.fetch(origin + path)
    assert.equal(app.status, 200)
    assert.match(await app.text(), /Bezalel Email/)
  }
  const css = await worker.fetch(origin + '/landing.css')
  assert.equal(css.status, 200)
  assert.match(css.headers.get('content-type'), /text\/css/)
  const headerCss = await worker.fetch(origin + '/site-header.css')
  assert.equal(headerCss.status, 200)
  assert.match(headerCss.headers.get('content-type'), /text\/css/)
  assert.equal(await headerCss.text(), await readFile(resolve('public/site-header.css'), 'utf8'))
  const boot = await worker.fetch(origin + '/dashboard-boot.js')
  assert.equal(boot.status, 200)
  assert.match(boot.headers.get('content-type'), /text\/javascript/)
  assert.equal(await boot.text(), await readFile(resolve('public/dashboard-boot.js'), 'utf8'))
  for (const name of ['imessage', 'whatsapp', 'telegram', 'slack', 'teams', 'email']) {
    const icon = await worker.fetch(origin + `/images/${name}.png`)
    assert.equal(icon.status, 200)
    assert.equal(icon.headers.get('content-type'), 'image/png')
    assert.equal(Buffer.from(await icon.arrayBuffer()).subarray(1, 4).toString(), 'PNG')
  }
  const tokens = await worker.fetch(origin + '/tokens.css')
  assert.equal(tokens.status, 200)
  assert.match(await tokens.text(), /--color-sand-50: #F3F2EF/)
  const font = await worker.fetch(origin + '/fonts/InterVariable.woff2')
  assert.equal(font.status, 200)
  assert.equal(font.headers.get('content-type'), 'font/woff2')
  assert.equal(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString(), 'wOF2')
  assert.match(font.headers.get('content-security-policy'), /font-src 'self';/)
  const identity = { 'cf-access-jwt-assertion': 'fixture-access-assertion' }
  const session = await worker.fetch(origin + '/api/session', { headers: identity })
  assert.equal(session.status, 200)
  assert.equal((await session.json()).customer.email, 'customer@example.net')
  assert.equal((await worker.fetch(origin + '/api/session', { headers: { 'cf-access-jwt-assertion': 'forged' } })).status, 401)
  const inboxes = await worker.fetch(origin + '/api/rpc/listInboxes', { method: 'POST',
    headers: { ...identity, origin, 'content-type': 'application/json' }, body: '{}' })
  assert.equal(inboxes.status, 200)
  assert.deepEqual((await inboxes.json()).result.inboxes, [{ inboxId: 'customer@example.com' }])
})
