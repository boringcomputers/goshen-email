import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { generateKeyPairSync } from 'node:crypto'
import net from 'node:net'
import nodemailer from 'nodemailer'
import { SMTPServer } from 'smtp-server'
import { dkimVerify } from 'mailauth/lib/dkim/verify.js'
import { gatewayServer } from '../src/server.mjs'
import { socketmapServer } from '../src/socketmap.mjs'
import { workerClient } from '../src/worker-client.mjs'
import { DeliveryJournal } from '../src/journal.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const token = 'gateway-test-token-'.repeat(3)
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 })
const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
const message = {
  trackingId: 'cf0fb7df-e34f-4f66-b744-b9e5d0242f4b',
  recipients: ['recipient@outside.test', 'hidden@outside.test'],
  from: 'agent@customer.test', to: ['recipient@outside.test'], cc: [], bcc: ['hidden@outside.test'],
  subject: 'Gateway canary', text: 'Hello from a custom domain.', headers: { 'Auto-Submitted': 'auto-generated' },
  dkim: { domainName: 'customer.test', keySelector: 'bzl-canary', privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }) },
}
async function listen(server) { const listener = server.server ?? server; server.listen(0, '127.0.0.1'); await once(listener, 'listening'); return listener.address().port }
async function journalFor(t) {
  const directory = await mkdtemp(tmpdir() + '/bezalel-gateway-test-')
  const journal = new DeliveryJournal(directory)
  t.after(async () => { journal.close(); await rm(directory, { recursive: true, force: true }) })
  return journal
}

test('signs SMTP mail, keeps BCC out of the message, and returns the queue receipt without secrets', async (t) => {
  const captured = []
  const smtp = new SMTPServer({ authOptional: true, disabledCommands: ['AUTH', 'STARTTLS'],
    onData(stream, session, done) {
      const parts = []
      stream.on('data', (part) => parts.push(part))
      stream.on('end', () => { captured.push({ raw: Buffer.concat(parts), recipients: session.envelope.rcptTo.map((r) => r.address) }); done(null, '2.0.0 Ok: queued as TEST123') })
    },
  })
  const smtpPort = await listen(smtp)
  const transport = nodemailer.createTransport({ host: '127.0.0.1', port: smtpPort, ignoreTLS: true })
  const server = gatewayServer({ token }, transport, () => true, await journalFor(t))
  const port = await listen(server)
  t.after(() => { server.closeAllConnections(); server.close(); transport.close(); smtp.close() })
  const response = await fetch(`http://127.0.0.1:${port}/send`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(message) })
  assert.equal(response.status, 200)
  const receipt = await response.json()
  assert.deepEqual(receipt.queued.toSorted(), [...message.to, ...message.bcc].sort())
  assert.equal(JSON.stringify(receipt).includes('PRIVATE KEY'), false)
  assert.deepEqual(captured[0].recipients.toSorted(), receipt.queued.toSorted())
  assert.doesNotMatch(captured[0].raw.toString(), /^Bcc:/mi)
  const verified = await dkimVerify(captured[0].raw, { resolver: async (name, type) => {
    assert.equal(name, 'bzl-canary._domainkey.customer.test')
    assert.equal(type, 'TXT')
    return [[`v=DKIM1; k=rsa; p=${publicKey}`]]
  } })
  assert.equal(verified.results[0].status.result, 'pass')
  const duplicate = await fetch(`http://127.0.0.1:${port}/send`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(message) })
  assert.deepEqual(await duplicate.json(), receipt)
  assert.equal(captured.length, 1)
})

test('requires the gateway token and matching DKIM domain before SMTP dispatch', async (t) => {
  let sends = 0
  const server = gatewayServer({ token }, { sendMail() { sends++; throw new Error('must not send') } }, () => true, await journalFor(t))
  const port = await listen(server)
  t.after(() => { server.closeAllConnections(); server.close() })
  const post = (body, authorization) => fetch(`http://127.0.0.1:${port}/send`, { method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await post(message, 'Bearer wrong-token')).status, 401)
  assert.equal((await post({ ...message, dkim: { ...message.dkim, domainName: 'someone-else.test' } }, `Bearer ${token}`)).status, 422)
  assert.equal((await post({ ...message, attachments: [{ filename: 'unsafe', path: '/a/local/file' }] }, `Bearer ${token}`)).status, 422)
  assert.equal((await post({ ...message, recipients: ['not-in-message@outside.test'] }, `Bearer ${token}`)).status, 422)
  const malformed = await fetch(`http://127.0.0.1:${port}/send`, { method: 'POST',
    headers: { authorization: `Bearer ${token}` }, body: '{incomplete' })
  assert.equal(malformed.status, 422)
  assert.equal(sends, 0)
})

test('returns an uncertain result when SMTP fails after submission', async (t) => {
  let sends = 0
  const server = gatewayServer({ token }, { sendMail() { sends++; throw new Error('socket closed') } }, () => true, await journalFor(t))
  const port = await listen(server)
  t.after(() => { server.closeAllConnections(); server.close() })
  const response = await fetch(`http://127.0.0.1:${port}/send`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(message) })
  assert.equal(response.status, 502)
  assert.equal(JSON.stringify(await response.json()).includes('socket closed'), false)
  await fetch(`http://127.0.0.1:${port}/send`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(message) })
  assert.equal(sends, 1)
})

test('speaks Postfix netstrings across packet boundaries and defers unavailable lookups', async (t) => {
  const server = socketmapServer({ async allowed(kind, value) {
    if (value === 'unavailable.test') throw new Error('DNS unavailable')
    return kind === 'domain' && value === 'customer.test'
  } })
  const port = await listen(server)
  const socket = net.connect(port, '127.0.0.1')
  t.after(() => { socket.destroy(); server.close() })
  await once(socket, 'connect')
  const query = async (value, split = false) => {
    const wire = `${Buffer.byteLength(value)}:${value},`
    const reply = once(socket, 'data')
    if (split) { socket.write(wire.slice(0, 2)); await new Promise((r) => setTimeout(r, 10)); socket.write(wire.slice(2)) }
    else socket.write(wire)
    return (await reply)[0].toString()
  }
  assert.equal(await query('domains customer.test', true), '4:OK 1,')
  assert.equal(await query('recipients missing@customer.test'), '9:NOTFOUND ,')
  assert.equal(await query('domains unavailable.test'), '29:TEMP Email lookup unavailable,')
})

test('worker delivery distinguishes a deleted inbox from a retryable outage', async () => {
  const config = { workerUrl: 'https://worker.test', token }
  assert.equal(await workerClient(config, async () => new Response('', { status: 404 })).receive('a@customer.test', Buffer.from('mail')), 'rejected')
  await assert.rejects(workerClient(config, async () => new Response('', { status: 503 })).receive('a@customer.test', Buffer.from('mail')), /unavailable/)
  assert.equal(await workerClient(config, async () => Response.json({ messageId: '<id@customer.test>' })).receive('a@customer.test', Buffer.from('mail')), 'delivered')
})
