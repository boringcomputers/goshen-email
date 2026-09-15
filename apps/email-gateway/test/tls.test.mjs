import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { SMTPServer } from 'smtp-server'
import { stageTls, probeStarttls } from '../src/tls.mjs'

const hostname = 'mx.gateway.test'
let directory
let source
let replacement
before(async () => {
  directory = await mkdtemp(tmpdir() + '/bezalel-smtp-tls-')
  const openssl = (args) => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' })
  openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', 'ca.key', '-out', 'ca.crt', '-subj', '/CN=Gateway test issuer'])
  for (const name of ['first', 'replacement']) {
    openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', name + '.key',
      '-out', name + '.csr', '-subj', '/CN=' + hostname, '-addext', 'subjectAltName=DNS:' + hostname])
    openssl(['x509', '-req', '-in', name + '.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
      '-CAcreateserial', '-out', name + '.crt', '-days', '2', '-copy_extensions', 'copyall'])
  }
  source = { hostname, certificate: directory + '/first.crt', privateKey: directory + '/first.key' }
  replacement = { hostname, certificate: directory + '/replacement.crt', privateKey: directory + '/replacement.key' }
})
after(async () => { await rm(directory, { recursive: true, force: true }) })

async function smtp(t, credentials, disabledCommands = ['AUTH']) {
  const server = new SMTPServer({ authOptional: true, disabledCommands,
    key: await readFile(credentials.privateKey), cert: await readFile(credentials.certificate) })
  server.listen(0, '127.0.0.1')
  await once(server.server, 'listening')
  t.after(() => server.close())
  return server.server.address().port
}

test('stages one protected PEM and proves STARTTLS with an issued, non-self-signed certificate', async (t) => {
  const staged = await stageTls(source, directory + '/staged')
  assert.equal((await stat(staged.chainPath)).mode & 0o777, 0o600)
  assert.equal((await stat(directory + '/staged')).mode & 0o777, 0o700)
  assert.equal(JSON.stringify(staged).includes('PRIVATE KEY'), false)
  const port = await smtp(t, source)
  await probeStarttls(hostname, staged, port)
})

test('rejects wrong keys and hostnames without replacing the working PEM, then stages a valid renewal', async () => {
  const staged = await stageTls(source, directory + '/renewed')
  const original = await readFile(staged.chainPath, 'utf8')
  assert.equal(await stageTls(source, directory + '/renewed', staged), staged)
  await assert.rejects(stageTls({ ...source, privateKey: replacement.privateKey }, directory + '/renewed', staged))
  await assert.rejects(stageTls({ ...source, hostname: 'other.test' }, directory + '/renewed', staged))
  assert.equal(await readFile(staged.chainPath, 'utf8'), original)
  const next = await stageTls(replacement, directory + '/renewed', staged)
  assert.notEqual(next.version, staged.version)
  assert.notEqual(next.fingerprint, staged.fingerprint)
  assert.equal((await stat(next.chainPath)).mode & 0o777, 0o600)
})

test('readiness fails when SMTP starts without STARTTLS', async (t) => {
  const staged = await stageTls(source, directory + '/disabled')
  const port = await smtp(t, source, ['AUTH', 'STARTTLS'])
  await assert.rejects(probeStarttls(hostname, staged, port), /does not offer STARTTLS/)
})

test('readiness fails when SMTP still serves a previous certificate after renewal', async (t) => {
  const staged = await stageTls(replacement, directory + '/stale')
  const port = await smtp(t, source)
  await assert.rejects(probeStarttls(hostname, staged, port))
})
