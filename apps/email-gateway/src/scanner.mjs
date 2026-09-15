import net from 'node:net'
import { once } from 'node:events'
import { z } from 'zod'

const safeText = z.string().max(254).refine((value) => !/[\r\n\0]/.test(value))
export const envelopeSchema = z.object({
  sender: z.union([z.literal(''), z.email().max(254)]),
  recipient: z.email().max(254),
  ip: z.string().refine((value) => net.isIP(value) !== 0).optional(),
  helo: safeText.optional(),
})
const symbolsSchema = z.record(z.string(), z.object({
  options: z.array(z.string().max(1000)).max(100).optional(),
}).passthrough())
const scanSchema = z.object({ score: z.number().finite(), required_score: z.number().finite().positive(),
  action: z.string(), symbols: symbolsSchema, is_skipped: z.boolean().optional() })

async function boundedJson(response, max = 256 * 1024) {
  if (!response.ok || !response.body) throw new Error('Spam scanner unavailable')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > max) throw new Error('Spam scanner response is too large')
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader.cancel() }
}

export async function scanVirus(raw, { host = 'antivirus', port = 3310, timeout = 45000 } = {}) {
  const socket = net.connect({ host, port })
  socket.on('error', () => {})
  socket.setTimeout(timeout, () => socket.destroy(new Error('Antivirus scan timed out')))
  try {
    await once(socket, 'connect')
    const response = new Promise((resolve, reject) => {
      let value = ''
      const failed = (error) => { cleanup(); reject(error) }
      const ended = () => failed(new Error('Antivirus scan ended without a result'))
      const data = (chunk) => {
        value += chunk.toString('utf8')
        if (value.length > 8192) return failed(new Error('Antivirus result is too large'))
        const end = value.indexOf('\0')
        if (end >= 0) { cleanup(); resolve(value.slice(0, end)) }
      }
      const cleanup = () => { socket.off('data', data); socket.off('error', failed); socket.off('end', ended) }
      socket.on('data', data); socket.once('error', failed); socket.once('end', ended)
    })
    // Observe an early scanner refusal while still writing its bounded stream.
    response.catch(() => {})
    const write = (bytes) => new Promise((resolve, reject) =>
      socket.write(bytes, (error) => error ? reject(error) : resolve()))
    await write(Buffer.from('zINSTREAM\0'))
    for (let offset = 0; offset < raw.length; offset += 65536) {
      const chunk = raw.subarray(offset, offset + 65536)
      const size = Buffer.alloc(4)
      size.writeUInt32BE(chunk.length)
      await write(size)
      await write(chunk)
    }
    await write(Buffer.alloc(4))
    const value = await response
    if (value === 'stream: OK') return { status: 'clean', signatures: [] }
    const found = /^stream: (.{1,1000}) FOUND$/.exec(value)
    if (found) return {
      status: /^Heuristics\.(?:Limits\.Exceeded|Encrypted)/.test(found[1]) ? 'unscannable' : 'infected',
      signatures: [found[1].replace(/[\x00-\x1f\x7f]/g, '')],
    }
    throw new Error('Antivirus scan did not complete')
  } finally { socket.destroy() }
}

export function protectionFromScan(scan, antivirus, hasIp, now = new Date()) {
  if (scan.action === 'soft reject' || (scan.is_skipped && !['reject', 'quarantine', 'discard'].includes(scan.action)))
    throw new Error('Spam scan did not complete')
  const has = (...names) => names.some((name) => Object.hasOwn(scan.symbols, name))
  const spf = !hasIp ? 'unavailable' : has('R_SPF_ALLOW') ? 'pass' :
    has('R_SPF_FAIL', 'R_SPF_SOFTFAIL') ? 'fail' : has('R_SPF_DNSFAIL') ? 'temperror' :
    has('R_SPF_PERMFAIL') ? 'permerror' : 'none'
  const dkim = has('R_DKIM_ALLOW') ? 'pass' : has('R_DKIM_TEMPFAIL') ? 'temperror' :
    has('R_DKIM_REJECT', 'R_DKIM_PERMFAIL') ? 'fail' : 'none'
  const dmarc = has('DMARC_POLICY_ALLOW') ? 'pass' :
    has('DMARC_POLICY_REJECT', 'DMARC_POLICY_QUARANTINE', 'DMARC_POLICY_SOFTFAIL') ? 'fail' :
    has('DMARC_DNSFAIL') ? 'temperror' : has('DMARC_BAD_POLICY') ? 'permerror' : 'none'
  if ([spf, dkim, dmarc].includes('temperror')) throw new Error('Sender authentication needs another DNS attempt')
  const signingDomains = (scan.symbols.DKIM_TRACE?.options ?? []).flatMap((option) => {
    const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):\+$/i.exec(option)
    return match ? [match[1].toLowerCase()] : []
  })
  const reasons = []
  if (antivirus.status === 'infected') reasons.push('malware')
  if (antivirus.status === 'unscannable') reasons.push('scan_incomplete')
  if (scan.score >= 6 || ['reject', 'add header', 'rewrite subject', 'quarantine', 'discard'].includes(scan.action)) reasons.push('spam')
  if (dmarc === 'fail' || (spf === 'fail' && dkim !== 'pass' && dmarc !== 'pass')) reasons.push('authentication_failed')
  return {
    status: reasons.length ? 'quarantined' : 'clean', scannedAt: now.toISOString(),
    authentication: { spf, dkim, dmarc, signingDomains: [...new Set(signingDomains)].slice(0, 20) },
    spam: { score: scan.score, threshold: 6 }, antivirus, reasons,
  }
}

export function makeScanner(config, request = fetch) {
  let active = 0
  return async (raw, input) => {
    if (active >= 4) throw new Error('Message scanners are busy')
    active++
    try {
      if (raw.length > 25 * 1024 * 1024) throw new Error('Message exceeds the scan limit')
      const envelope = envelopeSchema.parse(input)
      const headers = { From: envelope.sender, Rcpt: envelope.recipient, Flags: 'pass_all',
        ...(envelope.ip ? { IP: envelope.ip } : {}), ...(envelope.helo ? { Helo: envelope.helo } : {}) }
      // Retain the slot until both scans finish, including when one fails early.
      const [result, antivirus] = await Promise.allSettled([
        request(new URL('/checkv2', config.rspamdUrl), { method: 'POST', headers, body: raw,
          redirect: 'error', signal: AbortSignal.timeout(45000) }).then(boundedJson),
        scanVirus(raw, { host: config.antivirusHost, port: config.antivirusPort }),
      ])
      if (result.status === 'rejected') throw result.reason
      if (antivirus.status === 'rejected') throw antivirus.reason
      return protectionFromScan(scanSchema.parse(result.value), antivirus.value, Boolean(envelope.ip))
    } finally { active-- }
  }
}

export async function checkScanners(config, request = fetch) {
  await Promise.all([
    request(new URL('/ping', config.rspamdUrl), { redirect: 'error', signal: AbortSignal.timeout(4000) })
      .then(async (response) => { if (!response.ok || (await response.text()).trim().toLowerCase() !== 'pong') throw new Error('Spam scanner not ready') }),
    scanVirus(Buffer.from('Bezalel scanner readiness check\n'), { host: config.antivirusHost, port: config.antivirusPort, timeout: 4000 }),
  ])
}

export async function requestScan(url, token, raw, envelope, request = fetch) {
  const input = envelopeSchema.parse(envelope)
  const response = await request(new URL('/scan', url), { method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'message/rfc822',
      'x-bezalel-sender': input.sender, 'x-bezalel-recipient': input.recipient,
      ...(input.ip ? { 'x-bezalel-ip': input.ip } : {}), ...(input.helo ? { 'x-bezalel-helo': input.helo } : {}) },
    body: raw, redirect: 'error', signal: AbortSignal.timeout(55000),
  })
  return boundedJson(response, 8192)
}
