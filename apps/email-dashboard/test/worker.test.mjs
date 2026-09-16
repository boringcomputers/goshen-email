import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { unstable_dev } from 'wrangler'

const password = 'workers-test-password-'.repeat(3)
const origin = 'https://dashboard.example'

test('Cloudflare persists sessions, throttles and logout across process restarts', { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'email-dashboard-test-'))
  const config = join(directory, 'wrangler.json')
  await writeFile(config, JSON.stringify({
    name: 'email-dashboard-runtime-test', main: resolve('test/fixtures/worker.mjs'),
    compatibility_date: '2026-09-06', compatibility_flags: ['nodejs_compat'],
    assets: { directory: resolve('public'), binding: 'ASSETS', run_worker_first: true },
    durable_objects: { bindings: [{ name: 'DASHBOARD', class_name: 'Dashboard' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Dashboard'] }],
    vars: { DASHBOARD_PASSWORD: password, DASHBOARD_PUBLIC_URL: origin,
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
  assert.match(await page.text(), /Bezalel Email/)
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
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
