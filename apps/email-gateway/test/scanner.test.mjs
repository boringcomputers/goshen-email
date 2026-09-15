import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { scanVirus, protectionFromScan, makeScanner } from '../src/scanner.mjs'

async function antivirus(t, reply) {
  const received = []
  const sockets = []
  const server = net.createServer((socket) => {
    sockets.push(socket)
    let buffered = Buffer.alloc(0), command = false
    socket.on('data', (bytes) => {
      buffered = Buffer.concat([buffered, bytes])
      if (!command) {
        if (buffered.length < 10) return
        assert.equal(buffered.subarray(0, 10).toString(), 'zINSTREAM\0')
        buffered = buffered.subarray(10)
        command = true
      }
      while (buffered.length >= 4) {
        const size = buffered.readUInt32BE()
        if (buffered.length < size + 4) return
        received.push(buffered.subarray(4, 4 + size))
        buffered = buffered.subarray(size + 4)
        if (!size) { if (reply !== null) socket.end(reply + '\0'); return }
      }
    })
    socket.on('error', () => {})
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise((resolve) => { for (const socket of sockets) socket.destroy(); server.close(resolve) }))
  return { host: '127.0.0.1', port: server.address().port, received, sockets }
}
const base = { score: 0, required_score: 15, action: 'no action',
  symbols: { R_SPF_ALLOW: {}, R_DKIM_ALLOW: {}, DMARC_POLICY_ALLOW: {}, DKIM_TRACE: { options: ['sender.test:+', 'forged.test:-'] } } }

test('computes authentication from scan symbols and respects unavailable original IPs', () => {
  const clean = { status: 'clean', signatures: [] }
  const protection = protectionFromScan(base, clean, true)
  assert.equal(protection.status, 'clean')
  assert.deepEqual(protection.authentication, { spf: 'pass', dkim: 'pass', dmarc: 'pass', signingDomains: ['sender.test'] })
  assert.equal(protectionFromScan(base, clean, false).authentication.spf, 'unavailable')
  assert.deepEqual(protectionFromScan({ ...base, symbols: { R_SPF_FAIL: {}, R_DKIM_REJECT: {}, DMARC_POLICY_REJECT: {} } }, clean, true).reasons, ['authentication_failed'])
  assert.deepEqual(protectionFromScan({ ...base, score: 7 }, clean, true).reasons, ['spam'])
  assert.throws(() => protectionFromScan({ ...base, symbols: { R_SPF_DNSFAIL: {} } }, clean, true))
  assert.throws(() => protectionFromScan({ ...base, is_skipped: true }, clean, true))
  assert.deepEqual(protectionFromScan({ ...base, action: 'reject', is_skipped: true }, clean, true).reasons, ['spam'])
})

test('streams attachment bytes to ClamAV with bounded chunks and detects its verdict', async (t) => {
  const av = await antivirus(t, 'stream: Eicar-Signature FOUND')
  const raw = Buffer.alloc(150_000, 'x')
  assert.deepEqual(await scanVirus(raw, av), { status: 'infected', signatures: ['Eicar-Signature'] })
  assert.deepEqual(Buffer.concat(av.received), raw)
  assert.ok(av.received.every((chunk) => chunk.length <= 65536))
})

test('encrypted and oversized archives cannot pass as fully scanned attachments', async (t) => {
  for (const signature of ['Heuristics.Encrypted.Zip', 'Heuristics.Limits.Exceeded.MaxScanSize']) {
    const av = await antivirus(t, 'stream: ' + signature + ' FOUND')
    assert.equal((await scanVirus(Buffer.from('archive'), av)).status, 'unscannable')
  }
})

test('antivirus errors and timeouts defer delivery instead of passing mail', async (t) => {
  const invalid = await antivirus(t, 'INSTREAM size limit exceeded. ERROR')
  await assert.rejects(scanVirus(Buffer.from('mail'), invalid), /did not complete/)
  const stalled = await antivirus(t, null)
  await assert.rejects(scanVirus(Buffer.from('mail'), { ...stalled, timeout: 25 }), /timed out/)
})

test('only passes trusted envelope metadata and refuses malformed spam results', async (t) => {
  const av = await antivirus(t, 'stream: OK')
  let response = base, captured
  const scanner = makeScanner({ rspamdUrl: 'http://scanner.test', antivirusHost: av.host, antivirusPort: av.port },
    async (url, request) => { captured = request; return Response.json(response) })
  const raw = Buffer.from('Authentication-Results: forged; dkim=pass\r\n\r\nBody')
  await scanner(raw, { sender: 'envelope@sender.test', recipient: 'agent@recipient.test', ip: '192.0.2.10', helo: 'mx.sender.test' })
  assert.equal(captured.headers.From, 'envelope@sender.test')
  assert.equal(captured.headers.IP, '192.0.2.10')
  assert.equal(captured.body, raw)
  response = { score: 0 }
  await assert.rejects(scanner(raw, { sender: '', recipient: 'agent@recipient.test' }))
})

test('keeps the concurrency limit while antivirus is pending after a spam-scanner failure', async (t) => {
  const av = await antivirus(t, null)
  const scanner = makeScanner({ rspamdUrl: 'http://scanner.test', antivirusHost: av.host, antivirusPort: av.port },
    async () => { throw new Error('Spam scanner is down') })
  const input = { sender: '', recipient: 'agent@recipient.test' }
  const scans = Array.from({ length: 4 }, () => scanner(Buffer.from('mail'), input))
  const completed = Promise.allSettled(scans)
  const deadline = Date.now() + 2000
  while (av.received.filter((chunk) => !chunk.length).length < 4) {
    assert.ok(Date.now() < deadline, 'Antivirus streams must arrive')
    await new Promise((resolve) => setImmediate(resolve))
  }
  await assert.rejects(scanner(Buffer.from('mail'), input), /scanners are busy/)
  for (const socket of av.sockets) socket.end('stream: OK\0')
  assert.ok((await completed).every((result) => result.status === 'rejected' && /Spam scanner is down/.test(result.reason.message)))
  await assert.rejects(scanner(Buffer.from('mail'), { ...input, recipient: 'invalid' }), (error) => !/scanners are busy/.test(error.message))
})
