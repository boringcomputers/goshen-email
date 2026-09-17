import { PostgresDialect } from "kysely"
import { Pool } from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { PGlite } from "@electric-sql/pglite"
import { KyselyPGlite } from "kysely-pglite"
import { createAccountAuth, handleAccountRequest, collectAccountGarbage, type AccountAuth } from "../src/account-auth.js"
import { fixture } from "./support.js"

const config = { publicUrl: "https://accounts.example.com", secret: "test-account-secret-".repeat(3), proxySecret: "test-proxy-secret-".repeat(3), from: "accounts@example.com", adminEmails: ["owner@example.net"] }

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
  const signup = (email = 'a@example.net', extra = {}, instance = auth) => request('/api/auth/sign-in/magic-link', { email, name: 'A Person', ...extra }, '', {}, instance)
  const verifyLink = (url = emailUrl(), email?: string) => {
    const fragment = new URLSearchParams(url.hash.slice(1))
    return request('/api/auth/magic-link/verify', { token: fragment.get('token'), email: email ?? fragment.get('email') })
  }
  const verified = async (email = 'a@example.net') => {
    const response = await signup(email)
    expect(response.status, await response.clone().text()).toBe(200)
    const verification = await verifyLink()
    expect(verification.status, await verification.clone().text()).toBe(200)
    return cookies(verification)
  }
  const sendCode = (email = 'a@example.net') => request('/api/auth/email-otp/send-verification-otp', { email, type: 'sign-in' })
  const code = () => f.send.mock.calls.at(-1)![0].text!.match(/\b\d{6}\b/)![0]
  const useCode = (otp = code(), email = 'a@example.net') => request('/api/auth/sign-in/email-otp', { email, otp, name: 'Code Person' })
  it('requires a single-use email link, hashes its token, and creates a customer without a password', async () => {
    const response = await signup('a@example.net', { role: 'admin', emailVerified: true })
    expect(response.status).toBe(200)
    expect(await response.json()).not.toHaveProperty('token')
    expect((await rpc('session', '')).status).toBe(401)
    expect(await f.db.query('select * from mail.auth_users')).toHaveLength(0)
    const url = emailUrl(), token = new URLSearchParams(url.hash.slice(1)).get('token')!
    expect(url.pathname).toBe('/magic-link')
    const [stored] = await f.db.query<{ identifier: string }>('select identifier from mail.auth_verifications')
    expect(stored!.identifier).not.toContain(token)
    expect((await verifyLink(url, 'victim@example.net')).status).toBe(401)
    expect((await request('/api/auth/magic-link/verify?token=' + token)).status).toBe(404)
    const response2 = await verifyLink(url)
    const cookie = cookies(response2)
    expect(cookie).toContain('__Secure-bezalel.session_token=')
    expect(response2.headers.get('set-cookie')).toContain('HttpOnly')
    expect(response2.headers.get('set-cookie')).toContain('Secure')
    expect(await (await rpc('session', cookie)).json()).toMatchObject({ result: { customer: { email: 'a@example.net', role: 'customer', inboxLimit: null } } })
    expect(await f.db.query('select * from mail.auth_accounts')).toHaveLength(0)
    expect((await rpc('session', cookie + 'forged')).status).toBe(401)
    const replay = await verifyLink(url)
    expect(replay.status).toBe(401)
    expect(cookies(replay)).not.toContain('session_token=')
  })
  it('allows only one concurrent redemption of a magic link', async () => {
    await signup()
    const url = emailUrl()
    const results = await Promise.all([verifyLink(url), verifyLink(url)])
    expect(results.map((result) => result.status).sort()).toEqual([200, 401])
    expect(results.filter((result) => cookies(result).includes('session_token='))).toHaveLength(1)
    expect(await f.db.query('select * from mail.auth_sessions')).toHaveLength(1)
  })
  it('signs up with a six-digit code and never returns a session token in JSON', async () => {
    expect((await sendCode()).status).toBe(200)
    const otp = code()
    const [stored] = await f.db.query<{ value: string }>('select value from mail.auth_verifications')
    expect(stored!.value.startsWith(otp + ':')).toBe(false)
    const response = await useCode(otp)
    expect(response.status, await response.clone().text()).toBe(200)
    const body = await response.json()
    expect(body).not.toHaveProperty('token'); expect(body).not.toHaveProperty('user')
    expect(await (await rpc('session', cookies(response))).json()).toMatchObject({ result: { customer: { displayName: 'Code Person', role: 'customer' } } })
    expect((await useCode(otp)).status).toBe(400)
    expect(await f.db.query('select * from mail.auth_accounts')).toHaveLength(0)
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
    await sendCode()
    const login = await useCode()
    expect(login.status).toBe(200)
    expect(await login.json()).not.toHaveProperty('token')
    expect((await rpc('session', cookies(login))).status).toBe(200)
    await f.db.query('update mail.auth_sessions set "expiresAt" = now() - interval \'1 second\'')
    expect((await rpc('session', cookies(login))).status).toBe(401)
  })
  it('persists workspace and profile settings across sign-in without changing other accounts', async () => {
    const a = await verified(), b = await verified('b@example.net')
    const original = await (await rpc('getSettings', a)).json() as any
    expect(original.result.customer.organizationName).toBe('Your workspace')
    const updated = await rpc('updateSettings', a, { organizationName: "  O'Reilly & Partners  ", displayName: '  Alex Rivera  ' })
    expect(updated.status, await updated.clone().text()).toBe(200)
    expect(await updated.json()).toMatchObject({ result: { customer: { id: original.result.customer.id,
      email: 'a@example.net', organizationName: "O'Reilly & Partners", displayName: 'Alex Rivera', role: 'customer', inboxLimit: null } } })
    expect(await f.db.query('select name from mail.auth_users where email = $1', ['a@example.net'])).toEqual([{ name: 'Alex Rivera' }])
    expect(await (await rpc('getSettings', b)).json()).toMatchObject({ result: { customer: { organizationName: 'Your workspace', displayName: 'A Person' } } })
    expect((await rpc('updateSettings', a, { organizationName: 'Renamed workspace' })).status).toBe(200)
    expect((await request('/api/auth/sign-out', {}, a)).status).toBe(200)
    await sendCode()
    const login = await useCode()
    expect(login.status).toBe(200)
    const fresh = createAccountAuth(config, dialect, f.service)
    expect(await (await request('/account-rpc/session', {}, cookies(login), {}, fresh)).json())
      .toMatchObject({ result: { customer: { organizationName: 'Renamed workspace', displayName: 'Alex Rivera' } } })
  })
  it('rejects anonymous, cross-origin, invalid, and disabled account settings updates', async () => {
    expect((await rpc('getSettings', '')).status).toBe(401)
    expect((await rpc('updateSettings', '', { organizationName: 'Anonymous' })).status).toBe(401)
    const a = await verified(), owner = await verified('owner@example.net')
    const { result: { customer } } = await (await rpc('getSettings', a)).json() as any
    for (const input of [{}, { organizationName: '' }, { organizationName: '   ' }, { organizationName: 'x'.repeat(101) },
      { organizationName: '\u0000' }, { organizationName: null }, { displayName: '\n' }, { displayName: 'x'.repeat(201) },
      { organizationName: 'Forged', customerId: customer.id }, { organizationName: 'Forged', role: 'admin' },
      { email: 'owner@example.net' }, { inboxLimit: 100 }])
      expect((await rpc('updateSettings', a, input)).status).toBe(400)
    expect((await request('/account-rpc/updateSettings', { organizationName: 'Cross-origin' }, a, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await rpc('updateSettings', owner, { organizationName: 'Owner workspace' })).status).toBe(200)
    expect(await (await rpc('getSettings', a)).json()).toMatchObject({ result: { customer: { organizationName: 'Your workspace', displayName: 'A Person' } } })
    expect((await rpc('setCustomerAccess', owner, { customerId: customer.id, enabled: false })).status).toBe(200)
    expect((await rpc('getSettings', a)).status).toBe(403)
    expect((await rpc('updateSettings', a, { organizationName: 'Disabled' })).status).toBe(403)
  })
  it('rolls back settings when the authentication profile update fails', async () => {
    const cookie = await verified()
    await f.db.query("alter table mail.auth_users add constraint fixture_name_check check (name <> 'Rejected name')")
    try {
      expect((await rpc('updateSettings', cookie, { organizationName: 'Must not persist', displayName: 'Rejected name' })).status).toBe(500)
      expect(await (await rpc('getSettings', cookie)).json()).toMatchObject({ result: { customer: { organizationName: 'Your workspace', displayName: 'A Person' } } })
    } finally { await f.db.query('alter table mail.auth_users drop constraint fixture_name_check') }
  })
  it('locks out incorrect codes, binds them to an email, and expires old codes after resend', async () => {
    await sendCode(); const first = code()
    expect((await useCode(first, 'other@example.net')).status).toBe(400)
    await sendCode(); const second = code()
    const wrong = second === '000000' ? '111111' : '000000'
    if (first !== second) expect((await useCode(first)).status).toBe(400)
    for (let attempt = first === second ? 0 : 1; attempt < 5; attempt++) expect((await useCode(wrong)).status).toBe(400)
    expect((await useCode(second)).status).toBe(403)
    expect(await f.db.query('select * from mail.auth_sessions')).toHaveLength(0)
  })
  it('rejects direct API requests, cross-origin mutations, unsafe callbacks, and every password endpoint', async () => {
    expect((await request('/api/auth/sign-in/magic-link', {}, '', { authorization: '' })).status).toBe(401)
    expect((await request('/api/auth/sign-in/magic-link', {}, '', { origin: 'https://evil.example' })).status).toBe(403)
    for (const key of ['callbackURL', 'newUserCallbackURL', 'errorCallbackURL'])
      expect((await signup('a@example.net', { [key]: 'https://evil.example' })).status).toBe(403)
    expect((await request('/api/auth/get-session')).status).toBe(404)
    for (const endpoint of ['sign-up/email', 'sign-in/email', 'request-password-reset', 'reset-password', 'delete-user', 'email-otp/verify-email'])
      expect((await request('/api/auth/' + endpoint, {})).status).toBe(404)
    expect((await request('/api/auth/email-otp/send-verification-otp', { email: 'a@example.net', type: 'forget-password' })).status).toBe(400)
    expect(f.send).not.toHaveBeenCalled()
  })
  it('rejects expired links and codes and removes only expired account records', async () => {
    await verified()
    await signup(); const url = emailUrl()
    await sendCode(); const otp = code()
    await f.db.query('update mail.auth_verifications set "expiresAt" = now() - interval \'1 second\'')
    expect((await verifyLink(url)).status).toBe(401)
    expect((await useCode(otp)).status).toBe(400)
    await collectAccountGarbage(f.service)
    expect(await f.db.query('select * from mail.auth_verifications')).toHaveLength(0)
    expect(await f.db.query('select * from mail.auth_users')).toHaveLength(1)
  })
  it('enforces durable email-send throttling across instances', async () => {
    for (let i = 0; i < 3; i++) expect((await signup()).status).toBe(200)
    const fresh = createAccountAuth(config, dialect, f.service)
    expect((await signup('b@example.net', {}, fresh)).status).toBe(429)
    expect(f.send).toHaveBeenCalledTimes(3)
  })
})
