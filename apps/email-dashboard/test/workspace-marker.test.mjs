import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dashboardHandler, workspaceCookie } from '../src/handler.mjs'
import { accessDashboardHandler } from '../src/access-handler.mjs'
import { accountDashboardHandler } from '../src/account-handler.mjs'

// The workspace marker tells dashboard-shell.js whether the saved workspace belongs to the live
// session. It must be readable by the page, unique per issue, and gone once the session ends.
const origin = 'https://dashboard.example'
const password = 'marker-test-dashboard-password-'.repeat(2)
const marker = response => response.headers.getSetCookie().find(cookie => /^(__Host-)?workspace=/.test(cookie))
const value = cookie => cookie.match(/workspace=([^;]*)/)[1]

function request(handle, path, { cookie = '', body, token } = {}) {
  return handle(new Request(origin + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', cookie, ...(token ? { 'cf-access-jwt-assertion': token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), { clientIdentity: () => '192.0.2.1' })
}

test('the marker cookie is readable by the page, secure on HTTPS, and empty when cleared', () => {
  assert.match(workspaceCookie(true, 60), /^__Host-workspace=[A-Za-z0-9_-]{16,}; Path=\/; SameSite=Strict; Max-Age=60; Secure$/)
  assert.match(workspaceCookie(false, 60), /^workspace=[A-Za-z0-9_-]{16,}; Path=\/; SameSite=Strict; Max-Age=60$/)
  assert.equal(workspaceCookie(true, 0), '__Host-workspace=; Path=/; SameSite=Strict; Max-Age=0; Secure')
  assert.notEqual(value(workspaceCookie(true, 60)), value(workspaceCookie(true, 60)))
  assert.doesNotMatch(workspaceCookie(true, 60), /HttpOnly/)
})

test('password mode issues the marker with a live session and clears it on anonymous reads and logout', async () => {
  const handle = dashboardHandler({ publicUrl: origin, password, asset: async file => file })
  const anonymous = await request(handle, '/api/session')
  assert.deepEqual(await anonymous.json(), { authenticated: false })
  assert.match(marker(anonymous), /^__Host-workspace=; .*Max-Age=0/)
  const login = await request(handle, '/api/login', { body: { password } })
  const cookie = login.headers.getSetCookie().find(item => item.startsWith('__Host-mail-session=')).split(';')[0]
  assert.equal(marker(login), undefined, 'Login itself issues no marker; the session read does')
  const session = await request(handle, '/api/session', { cookie })
  assert.deepEqual(await session.json(), { authenticated: true })
  assert.match(marker(session), /^__Host-workspace=[A-Za-z0-9_-]+; Path=\/; SameSite=Strict; Max-Age=28800; Secure$/)
  assert.notEqual(value(marker(session)), value(marker(await request(handle, '/api/session', { cookie }))), 'Each read issues a fresh marker')
  const logout = await request(handle, '/api/logout', { cookie, body: {} })
  assert.match(marker(logout), /Max-Age=0/)
  assert.ok(logout.headers.getSetCookie().some(item => item.startsWith('__Host-mail-session=;')), 'The session cookie is still cleared')
})

test('account mode issues the marker only for an authenticated session read and clears it on failure and sign-out', async () => {
  let result
  const handle = accountDashboardHandler({ publicUrl: origin, workerUrl: 'https://mail.example', proxySecret: 'marker-test-proxy-secret-'.repeat(2),
    asset: async file => file, request: async () => result })
  result = Response.json({ result: { customer: { id: 'c1', email: 'owner@example.net' } } }, { headers: { 'set-cookie': 'session=private; HttpOnly' } })
  const session = await request(handle, '/api/session', { cookie: 'session=private' })
  assert.equal((await session.json()).authenticated, true)
  assert.match(marker(session), /^__Host-workspace=[A-Za-z0-9_-]+; Path=\/; SameSite=Strict; Max-Age=604800; Secure$/)
  assert.ok(session.headers.getSetCookie().includes('session=private; HttpOnly'), 'Upstream session cookies still pass through')
  result = Response.json({ error: { message: 'Sign in' } }, { status: 401 })
  const ended = await request(handle, '/api/session')
  assert.deepEqual(await ended.json(), { authenticated: false, authMode: 'account' })
  assert.match(marker(ended), /Max-Age=0/)
  result = Response.json({ success: true }, { headers: { 'set-cookie': 'session=; Max-Age=0' } })
  const logout = await request(handle, '/api/logout', { cookie: 'session=private', body: {} })
  assert.match(marker(logout), /Max-Age=0/)
  const rpc = await request(handle, '/api/rpc/listInboxes', { cookie: 'session=private', body: {} })
  assert.equal(marker(rpc), undefined, 'Other operations issue no marker')
})

test('account mode clears the marker on every sign-in step so a stale marker cannot paint the previous account', async () => {
  let result
  const handle = accountDashboardHandler({ publicUrl: origin, workerUrl: 'https://mail.example', proxySecret: 'marker-test-proxy-secret-'.repeat(2),
    asset: async file => file, request: async () => result })
  // An expired session leaves the browser holding the old marker; each sign-in call clears it.
  const stale = '__Host-workspace=stale-marker-from-alice'
  result = Response.json({ success: true })
  const sent = await request(handle, '/api/auth/email-otp/send-verification-otp', { cookie: stale, body: { email: 'bob@example.net', type: 'sign-in' } })
  assert.equal(sent.status, 200)
  assert.match(marker(sent), /^__Host-workspace=; .*Max-Age=0/)
  result = Response.json({ status: true }, { headers: { 'set-cookie': 'session=bob; HttpOnly' } })
  const signedIn = await request(handle, '/api/auth/sign-in/email-otp', { cookie: stale, body: { email: 'bob@example.net', otp: '123456' } })
  assert.match(marker(signedIn), /Max-Age=0/)
  assert.ok(signedIn.headers.getSetCookie().includes('session=bob; HttpOnly'), 'The new session cookie still passes through')
  // The magic-link confirmation answers with a redirect; the marker is cleared on that response too.
  result = new Response(null, { status: 302, headers: { location: origin + '/app', 'set-cookie': 'session=bob; HttpOnly' } })
  const verified = await request(handle, '/api/auth/magic-link/verify', { cookie: stale, body: { token: 't', email: 'bob@example.net' } })
  assert.equal(verified.status, 302)
  assert.equal(verified.headers.get('location'), origin + '/app')
  assert.match(marker(verified), /Max-Age=0/)
  // The session read after sign-in issues Bob's marker, so the saved workspace binds to his account.
  result = Response.json({ result: { customer: { id: 'c2', email: 'bob@example.net' } } })
  const session = await request(handle, '/api/session', { cookie: 'session=bob' })
  assert.match(marker(session), /^__Host-workspace=[A-Za-z0-9_-]+; .*Max-Age=604800/)
  assert.notEqual(value(marker(session)), 'stale-marker-from-alice')
})

test('Access mode issues the marker with an assertion and clears it without one and on logout', async () => {
  const handle = accessDashboardHandler({ publicUrl: origin, asset: async file => file,
    client: { execute: async () => ({ customer: { id: 'c1', email: 'owner@example.net' } }) } })
  const anonymous = await request(handle, '/api/session')
  assert.deepEqual(await anonymous.json(), { authenticated: false, authMode: 'access' })
  assert.match(marker(anonymous), /Max-Age=0/)
  const session = await request(handle, '/api/session', { token: 'assertion' })
  assert.equal((await session.json()).authenticated, true)
  assert.match(marker(session), /^__Host-workspace=[A-Za-z0-9_-]+; Path=\/; SameSite=Strict; Max-Age=86400; Secure$/)
  const logout = await request(handle, '/api/logout', { token: 'assertion', body: {} })
  assert.match(marker(logout), /Max-Age=0/)
})
