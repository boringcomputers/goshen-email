import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountDashboardHandler } from '../src/account-handler.mjs'
import { nativeMailClient, nativeReadOperations } from '../src/service.mjs'

const origin = 'https://dashboard.example.com', nativeUrl = 'https://bezalel-email.michaelwasihun96.workers.dev'
const token = 'fixture-native-token-'.repeat(3), proxy = 'fixture-proxy-token-'.repeat(3)
function fixture() {
  const accountCalls = [], nativeCalls = []
  let customer = { email: 'owner@example.net', role: 'admin' }, status = 200
  const client = nativeMailClient({ workerUrl: nativeUrl, apiToken: token, adminEmails: ' OWNER@example.net ',
    request: async (url, init) => {
      nativeCalls.push({ url, init })
      return Response.json({ result: { inboxes: [{ inboxId: 'existing@goshenemail.com' }] } })
    },
  })
  const handle = accountDashboardHandler({ publicUrl: origin, workerUrl: 'https://standalone.example.com', proxySecret: proxy,
    asset: async name => name, nativeMail: client,
    request: async (url, init) => {
      accountCalls.push({ url, init })
      return Response.json(status === 200 ? { result: { customer } } : { error: { message: 'Sign in' } },
        { status, headers: { 'set-cookie': 'refreshed=fixture; HttpOnly' } })
    },
  })
  return {
    accountCalls, nativeCalls, client,
    identity(value, code = 200) { customer = value; status = code },
    request(path, body, headers = {}) { return handle(new Request(origin + path, {
      method: body === undefined ? 'GET' : 'POST', headers: { origin, 'content-type': 'application/json', cookie: 'session=fixture', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { clientIdentity: () => '192.0.2.10' }) },
  }
}

test('verified allowlisted admin reads native mail through separate server credentials', async () => {
  const f = fixture()
  assert.equal((await (await f.request('/api/session')).json()).nativeMailEnabled, true)
  const response = await f.request('/api/native-rpc/listInboxes', {})
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('set-cookie'), /refreshed=fixture/)
  const text = await response.text()
  assert.match(text, /existing@goshenemail.com/)
  assert.ok(!text.includes(token) && !text.includes(proxy))
  assert.equal(f.accountCalls.at(-1).url.pathname, '/account-rpc/session')
  assert.equal(f.accountCalls.at(-1).init.headers.get('authorization'), `Bearer ${proxy}`)
  assert.equal(f.accountCalls.at(-1).init.headers.get('cookie'), 'session=fixture')
  assert.equal(f.nativeCalls[0].url.origin, nativeUrl)
  assert.equal(f.nativeCalls[0].url.pathname, '/rpc/listInboxes')
  assert.deepEqual(f.nativeCalls[0].init.headers, { authorization: `Bearer ${token}`, 'content-type': 'application/json' })
})

test('anonymous, customer, and other administrator identities cannot read native mail', async () => {
  for (const [identity, status, expected] of [
    [undefined, 401, 401], [{ email: 'customer@example.net', role: 'customer' }, 200, 403],
    [{ email: 'other-admin@example.net', role: 'admin' }, 200, 403], [{ email: 'owner@example.net', role: 'customer' }, 200, 403],
  ]) {
    const f = fixture(); f.identity(identity, status)
    const response = await f.request('/api/native-rpc/listInboxes', { customer: { email: 'owner@example.net', role: 'admin' } },
      { authorization: `Bearer ${token}`, 'x-bezalel-owner': 'owner@example.net', 'cf-access-authenticated-user-email': 'owner@example.net' })
    assert.equal(response.status, expected); assert.equal(f.nativeCalls.length, 0)
    assert.notEqual((await (await f.request('/api/session')).json()).nativeMailEnabled, true)
  }
})

test('each native read revalidates the account session and observes revocation', async () => {
  const f = fixture()
  assert.equal((await f.request('/api/native-rpc/listInboxes', {})).status, 200)
  f.identity(undefined, 403)
  assert.equal((await f.request('/api/native-rpc/listThreads', { inboxId: 'existing@goshenemail.com' })).status, 403)
  assert.equal(f.accountCalls.length, 2); assert.equal(f.nativeCalls.length, 1)
})

test('write operations, credential reads, and non-native routes never reach native mail', async () => {
  const f = fixture()
  for (const operation of ['send', 'reply', 'deleteInbox', 'createInbox', 'updateMessageLabels', 'updateThreadLabels', 'releaseQuarantine', 'getCredentials', 'rotateCredentials', 'ensureWebhook', 'listCustomers'])
    assert.equal((await f.request('/api/native-rpc/' + operation, {})).status, 404)
  assert.equal(f.nativeCalls.length, 0); assert.equal(f.accountCalls.length, 0)
  await assert.rejects(f.client.execute('send', {}), { status: 404 })
  assert.equal((await f.request('/api/rpc/listInboxes', {})).status, 200)
  assert.equal(f.accountCalls.at(-1).url.pathname, '/account-rpc/listInboxes'); assert.equal(f.nativeCalls.length, 0)
  await f.request('/api/native-rpc/../rpc/send', {})
  assert.equal(f.accountCalls.at(-1).url.pathname, '/account-rpc/send'); assert.equal(f.nativeCalls.length, 0)
})

test('CSRF, content type, request method, and malformed bodies fail before a native read', async () => {
  const f = fixture()
  assert.equal((await f.request('/api/native-rpc/listInboxes', {}, { origin: 'https://attacker.example' })).status, 403)
  assert.equal((await f.request('/api/native-rpc/listInboxes', {}, { 'content-type': 'text/plain' })).status, 415)
  assert.equal((await f.request('/api/native-rpc/listInboxes')).status, 404)
  for (const input of [null, [], 'not an object']) assert.equal((await f.request('/api/native-rpc/listInboxes', input)).status, 400)
  assert.equal(f.nativeCalls.length, 0)
})

test('native client is optional, rejects another destination, and permits only read operations', async () => {
  assert.equal(nativeMailClient({}), undefined)
  assert.throws(() => nativeMailClient({ workerUrl: 'https://attacker.example', apiToken: token, adminEmails: 'owner@example.net' }), /dedicated Bezalel Worker/)
  assert.throws(() => nativeMailClient({ workerUrl: nativeUrl, apiToken: 'short', adminEmails: 'owner@example.net' }), /at least 32/)
  const f = fixture()
  for (const operation of nativeReadOperations) assert.equal((await f.request('/api/native-rpc/' + operation, { inboxId: 'existing@goshenemail.com' })).status, 200)
  assert.equal(f.nativeCalls.length, 7)
})
