import http from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import nodemailer from 'nodemailer'
import { z } from 'zod'

const text = z.string().max(2000).refine((value) => !/[\r\n\0]/.test(value))
const address = z.email().max(254)
const requestBody = z.object({
  trackingId: z.uuid(),
  recipients: z.array(address).min(1).max(50),
  from: z.union([address, z.object({ address, name: text })]),
  to: z.array(address).min(1).max(50), cc: z.array(address).max(50), bcc: z.array(address).max(50),
  subject: text, text: z.string().max(512 * 1024).optional(), html: z.string().max(512 * 1024).optional(),
  headers: z.object({ 'Auto-Submitted': text.optional(), 'In-Reply-To': text.optional(), References: text.optional() }),
  attachments: z.array(z.object({ filename: text.max(200), contentType: text.max(100),
    content: z.string().max(3 * 1024 * 1024).regex(/^[A-Za-z0-9+/]*={0,2}$/) })).max(10).optional(),
  dkim: z.object({ domainName: z.string().regex(/^[a-z0-9.-]+$/), keySelector: z.string().regex(/^[a-z0-9-]{1,63}$/),
    privateKey: z.string().max(4096).startsWith('-----BEGIN PRIVATE KEY-----') }),
}).refine((value) => value.to.length + value.cc.length + value.bcc.length <= 50)
  .refine((value) => new Set(value.recipients).size === value.recipients.length &&
    value.recipients.every((recipient) => [...value.to, ...value.cc, ...value.bcc].includes(recipient)))
  .refine((value) => (typeof value.from === 'string' ? value.from : value.from.address).split('@')[1] === value.dkim.domainName)
  .refine((value) => Boolean(value.text?.trim() || value.html?.trim()))
  .refine((value) => (value.attachments ?? []).reduce((bytes, file) => bytes + Buffer.from(file.content, 'base64').length, 0) <= 2 * 1024 * 1024)

const digest = (value) => createHash('sha256').update(value).digest()
export const authorized = (value, token) => timingSafeEqual(digest(value ?? ''), digest(`Bearer ${token}`))
export function makeTransport(hostname) {
  return nodemailer.createTransport({ host: '127.0.0.1', port: 10025, name: hostname,
    ignoreTLS: true, connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 15000,
    disableFileAccess: true, disableUrlAccess: true })
}

export function gatewayServer(config, transport, ready, journal, scanner) {
  if (!journal) throw new Error('A persistent delivery journal is required')
  const server = http.createServer(async (req, res) => {
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    if (req.method === 'GET' && req.url === '/healthz') return json(ready() ? 200 : 503, { ready: ready() })
    if (!authorized(req.headers.authorization, config.token)) return json(401, { error: 'Unauthorized' })
    const scanning = req.url === '/scan'
    if (req.method !== 'POST' || (!scanning && req.url !== '/send')) return json(404, { error: 'Not found' })
    if (!ready()) return json(503, { error: 'Mail queue is unavailable' })
    let size = 0
    const chunks = []
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > (scanning ? 25 : 5) * 1024 * 1024) return json(413, { error: 'Message too large' })
        chunks.push(chunk)
      }
      if (scanning) {
        if (!scanner) return json(503, { error: 'Message scanning is unavailable' })
        const protection = await scanner(Buffer.concat(chunks), {
          sender: req.headers['x-bezalel-sender'] ?? '', recipient: req.headers['x-bezalel-recipient'],
          ip: req.headers['x-bezalel-ip'], helo: req.headers['x-bezalel-helo'],
        })
        return json(200, protection)
      }
      let body
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
        return json(422, { error: 'Invalid message' })
      }
      const input = requestBody.safeParse(body)
      if (!input.success) return json(422, { error: 'Invalid message' })
      const mail = input.data
      const reserved = journal.reserve(mail)
      if (reserved.receipt) return json(200, reserved.receipt)
      const from = typeof mail.from === 'string' ? mail.from : mail.from.address
      const { trackingId, recipients, ...message } = mail
      const result = await transport.sendMail({ ...message, messageId: reserved.messageId, envelope: { from, to: recipients },
        attachments: mail.attachments?.map((file) => ({ ...file, content: Buffer.from(file.content, 'base64') })),
        disableFileAccess: true, disableUrlAccess: true })
      const receipt = { messageId: reserved.messageId, queued: result.accepted,
        delivered: [], bounced: result.rejected ?? [], suppressed: [] }
      journal.accepted(trackingId, result.response, receipt)
      return json(200, receipt)
    } catch {
      if (scanning) return json(503, { error: 'Message scanning is unavailable; retry later' })
      return json(502, { error: 'Mail queue did not return a receipt; inspect it before retrying' })
    }
  })
  server.requestTimeout = 30000
  server.headersTimeout = 10000
  return server
}
