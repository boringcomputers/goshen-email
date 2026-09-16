import { SignJWT } from "jose"
import { PostgresDialect } from "kysely"
import { Pool } from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { KyselyPGlite } from "kysely-pglite"
import { createAccountAuth, handleAccountRequest, collectAccountGarbage, type AccountAuth } from "../src/account-auth.js"
import { fixture } from "./support.js"

const config = { publicUrl: "https://accounts.example.com", secret: "test-account-secret-".repeat(3), proxySecret: "test-proxy-secret-".repeat(3), from: "accounts@example.com", adminEmails: ["owner@example.net"] }
const password = "test-account-password-123"

describe("Public accounts", () => {
  let f: Awaited<ReturnType<typeof fixture>>, auth: AccountAuth, dialect: KyselyPGlite['dialect']
  let pool: Pool | undefined
  beforeAll(async () => {
    f = await fixture()
    dialect = f.connectionString ? new PostgresDialect({ pool: pool = new Pool({ connectionString: f.connectionString }) }) : new KyselyPGlite(f.pg as PGlite).dialect
    auth = createAccountAuth(config, dialect, f.service)
  })
  afterAll(async () => { await pool?.end(); await f.pg.close() })
  beforeEach(async () => {
    await f.pg.exec('truncate mail.auth_users, mail.auth_verifications, mail.auth_rate_limits, mail.customers, mail.inboxes, mail.domains cascade')
    f.send.mockClear()
  })
  const request = (path: string, data?: unknown, cookie = '', headers = {}, instance = auth) => handleAccountRequest(new Request(`https://mail.example.com${path}`, {
    method: data === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${config.proxySecret}`, origin: config.publicUrl, 'content-type': 'application/json', 'x-bezalel-client-ip': '192.0.2.1', cookie, ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }), f.service, config, instance)
  const rpc = (operation: string, cookie: string, data = {}) => request(`/account-rpc/${operation}`, data, cookie)
  const cookies = (response: Response) => response.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
  const emailUrl = () => new URL(f.send.mock.calls.at(-1)![0].text!.match(/https:\/\/\S+/)![0])
  const signup = (email = 'a@example.net', extra = {}) => request('/api/auth/sign-up/email', { email, password, name: 'A Person', callbackURL: `${config.publicUrl}/verify-email?verified=1`, ...extra })
  const verified = async (email = 'a@example.net') => {
    const response = await signup(email)
    expect(response.status, await response.clone().text()).toBe(200)
    const url = emailUrl()
    const verification = await request(url.pathname + url.search)
    expect(verification.status, await verification.clone().text()).toBe(302)
    return cookies(verification)
  }
  it('requires verification, uses secure cookies, and creates a public customer with no elevated role', async () => {
    const response = await signup('a@example.net', { role: 'admin', emailVerified: true })
    expect(response.status).toBe(200)
    expect(await response.json()).not.toHaveProperty('token')
    expect((await rpc('session', '')).status).toBe(401)
    expect((await request('/api/auth/sign-in/email', { email: 'a@example.net', password })).status).toBe(403)
    const url = emailUrl()
    const verified = await request(url.pathname + url.search)
    const cookie = cookies(verified)
    expect(cookie).toContain('__Secure-bezalel.session_token=')
    expect(verified.headers.get('set-cookie')).toContain('HttpOnly')
    expect(verified.headers.get('set-cookie')).toContain('Secure')
    const session = await rpc('session', cookie)
    expect(await session.json()).toMatchObject({ result: { customer: { email: 'a@example.net', role: 'customer', inboxLimit: 5 } } })
    const [stored] = await f.db.query<{ password: string }>('select password from mail.auth_accounts')
    expect(stored!.password).not.toContain(password)
    expect((await rpc('session', cookie + 'forged')).status).toBe(401)
  })
  it('isolates inboxes, derives administrators from verified email, and honors disabled customers', async () => {
    const a = await verified(), b = await verified('b@example.net'), owner = await verified('owner@example.net')
    const created = await rpc('createInbox', a, { username: 'first' })
    expect(created.status, await created.clone().text()).toBe(200)
    expect(await (await rpc('listInboxes', b)).json()).toMatchObject({ result: { inboxes: [] } })
    for (const operation of ['listMessages', 'send', 'deleteInbox', 'getCredentials', 'rotateCredentials'])
      expect((await rpc(operation, b, { inboxId: 'first@example.com' })).status).toBe(404)
    expect((await rpc('createInbox', b, { username: 'first' })).status).toBe(409)
    expect((await rpc('listCustomers', b)).status).toBe(403)
    const aSession = await (await rpc('session', a)).json() as any
    expect((await rpc('setCustomerAccess', owner, { customerId: aSession.result.customer.id, enabled: false })).status).toBe(200)
    expect((await rpc('session', a)).status).toBe(403)
    expect((await rpc('listInboxes', a)).status).toBe(403)
  })
  it('persists sessions between auth instances and revokes them on sign-out', async () => {
    const cookie = await verified()
    const fresh = createAccountAuth(config, dialect, f.service)
    expect((await request('/account-rpc/session', {}, cookie, {}, fresh)).status).toBe(200)
    expect((await request('/api/auth/sign-out', {}, cookie)).status).toBe(200)
    expect((await request('/account-rpc/session', {}, cookie, {}, fresh)).status).toBe(401)
    const login = await request('/api/auth/sign-in/email', { email: 'a@example.net', password })
    expect(login.status).toBe(200)
    expect(await login.json()).not.toHaveProperty('token')
    expect((await rpc('session', cookies(login))).status).toBe(200)
    await f.db.query('update mail.auth_sessions set "expiresAt" = now() - interval \'1 second\'')
    expect((await rpc('session', cookies(login))).status).toBe(401)
  })
  it('resets passwords once, revokes existing sessions, and hides unknown account existence', async () => {
    const cookie = await verified()
    const body = { email: 'a@example.net', redirectTo: `${config.publicUrl}/reset-password` }
    const reset = await request('/api/auth/request-password-reset', body)
    expect(reset.status).toBe(200)
    const url = emailUrl()
    const redirect = await request(url.pathname + url.search)
    expect(redirect.status, await redirect.clone().text()).toBe(302)
    const token = new URL(redirect.headers.get('location')!).searchParams.get('token')
    const unknown = await request('/api/auth/request-password-reset', { ...body, email: 'unknown@example.net' })
    expect(await unknown.json()).toEqual(await reset.json())
    const change = { token, newPassword: 'changed-password-123456' }
    expect((await request('/api/auth/reset-password', change)).status).toBe(200)
    expect((await rpc('session', cookie)).status).toBe(401)
    expect((await request('/api/auth/reset-password', change)).status).toBe(400)
    expect((await request('/api/auth/sign-in/email', { email: body.email, password })).status).toBe(401)
    expect((await request('/api/auth/sign-in/email', { email: body.email, password: change.newPassword })).status).toBe(200)
  })
  it('rejects direct API requests, cross-origin mutations, unsafe callbacks, and weak passwords', async () => {
    expect((await request('/api/auth/sign-up/email', {}, '', { authorization: '' })).status).toBe(401)
    expect((await request('/api/auth/sign-up/email', {}, '', { origin: 'https://evil.example' })).status).toBe(403)
    expect((await signup('a@example.net', { callbackURL: 'https://evil.example' })).status).toBe(403)
    expect((await signup('a@example.net', { password: 'short' })).status).toBe(400)
    expect((await request('/api/auth/get-session')).status).toBe(404)
    expect((await request('/api/auth/delete-user', {})).status).toBe(404)
    expect(f.send).not.toHaveBeenCalled()
  })
  it('rejects expired and reused email links and removes only expired account records', async () => {
    const cookie = await verified()
    const link = emailUrl()
    await request('/api/auth/sign-out', {}, cookie)
    const replay = await request(link.pathname + link.search)
    expect(cookies(replay)).not.toContain('session_token=')
    const expired = await new SignJWT({ email: 'a@example.net' }).setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime(1).sign(new TextEncoder().encode(config.secret))
    const invalid = await request(`/api/auth/verify-email?token=${expired}&callbackURL=${encodeURIComponent(config.publicUrl + '/verify-email')}`)
    expect(invalid.headers.get('location')).toContain('TOKEN_EXPIRED')
    await request('/api/auth/request-password-reset', { email: 'a@example.net', redirectTo: config.publicUrl + '/reset-password' })
    const reset = emailUrl()
    await f.db.query('update mail.auth_verifications set "expiresAt" = now() - interval \'1 second\'')
    const resetResponse = await request(reset.pathname + reset.search)
    expect(resetResponse.headers.get('location')).toContain('INVALID_TOKEN')
    await collectAccountGarbage(f.service)
    expect(await f.db.query('select * from mail.auth_verifications')).toHaveLength(0)
    expect(await f.db.query('select * from mail.auth_users')).toHaveLength(1)
    expect((await request('/api/auth/sign-in/email', { email: 'a@example.net', password })).status).toBe(200)
  })
  it('enforces durable sign-in throttling across instances', async () => {
    for (let i = 0; i < 5; i++) expect((await request('/api/auth/sign-in/email', { email: 'missing@example.net', password })).status).toBe(401)
    const fresh = createAccountAuth(config, dialect, f.service)
    expect((await request('/api/auth/sign-in/email', { email: 'missing@example.net', password }, '', {}, fresh)).status).toBe(429)
  })
})
