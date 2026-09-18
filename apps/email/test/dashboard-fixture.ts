import { sendNotifications } from "../src/notifications.js"
import { fixtureTriage } from "./triage-fixture.js"
import { nativeDashboardFixture } from './native-dashboard-fixture.js'
import { KyselyPGlite } from "kysely-pglite"
import { createAccountAuth, handleAccountRequest } from "../src/account-auth.js"
import { PGlite } from '@electric-sql/pglite'
import { createServer } from 'node:http'
import { migrate, type Database } from '../src/database.js'
import { MailboxStore } from '../src/mailbox-store.js'
import { MailService } from '../src/mail-service.js'
import { handleRequest } from '../src/worker.js'
import type { ObjectStore } from '../src/contracts.js'

// This fixture binds only to loopback and never contacts email providers.
const { dashboardServer } = await import(new URL('../../email-dashboard/src/server.mjs', import.meta.url).href)
const { accountDashboardHandler } = await import(new URL('../../email-dashboard/src/account-handler.mjs', import.meta.url).href)
const { mailClient, nativeMailClient } = await import(new URL('../../email-dashboard/src/service.mjs', import.meta.url).href)
const pg = new PGlite()
const db: Database = {
  query: async <T>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows,
  transaction: task => pg.transaction(tx => task({ query: async <T>(sql: string, params: unknown[] = []) => (await tx.query<T>(sql, params)).rows })),
}
await migrate(db)
const blobs = new Map<string, Uint8Array>()
const objects: ObjectStore = {
  async put(key, body) { blobs.set(key, typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body)) },
  async get(key) { const value = blobs.get(key); return value ? { body: new Response(value).body! } : null },
  async list({ prefix }) { return { objects: [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false } },
  async delete(keys) { for (const key of typeof keys === 'string' ? [keys] : keys) blobs.delete(key) },
}
const sends: unknown[] = []
let routingAvailable = true
const service = new MailService({
  ...(process.env.FIXTURE_TRIAGE === "true" ? { triageAnalyzer: fixtureTriage } : {}),
  store: new MailboxStore(db), objects,
  config: { defaultDomain: 'example.com', domains: { 'example.com': 'a'.repeat(32) }, publicUrl: 'https://fixture.example.com', apiToken: 'fixture-worker-token-'.repeat(3), webhookSecret: `whsec_${Buffer.from('fixture-webhook-secret-'.repeat(3)).toString('base64')}` },
  transport: {
    ensureInboxRoute: async () => { if (!routingAvailable) throw new Error('Fixture routing unavailable') },
    verifyDomain: async (domain) => ({ domainId: domain, domain, status: 'VERIFIED', records: [] }),
    send: async (input) => { sends.push(input); return { messageId: `<${crypto.randomUUID()}@fixture.example.com>`, delivered: input.to, queued: [], bounced: [], suppressed: [] } },
  },
})
const port = Number(process.env.FIXTURE_PORT ?? 3038)
const accountMode = process.env.FIXTURE_AUTH_MODE === 'account'
const accountConfig = { publicUrl: `http://127.0.0.1:${port}`, secret: 'fixture-account-secret-'.repeat(3), proxySecret: 'fixture-proxy-secret-'.repeat(3), from: 'accounts@example.com', adminEmails: ['owner@example.net'] }
const auth = accountMode ? createAccountAuth(accountConfig, new KyselyPGlite(pg).dialect, service) : undefined
const native = process.env.FIXTURE_NATIVE_MAIL === 'true' ? await nativeDashboardFixture(objects, service.transport) : undefined
const server = dashboardServer({ ...(accountMode ? {
  handler: accountDashboardHandler, workerUrl: service.config.publicUrl, proxySecret: accountConfig.proxySecret,
  request: async (url: URL, init: RequestInit) => handleAccountRequest(new Request(url, init), service, accountConfig, auth!),
  ...(native ? { nativeMail: nativeMailClient({ workerUrl: native.service.config.publicUrl,
    apiToken: native.service.config.apiToken, adminEmails: 'owner@example.net', request: native.request }) } : {}),
} : {}), password: 'fixture-dashboard-password-'.repeat(2), publicUrl: `http://127.0.0.1:${port}`,
  client: mailClient({ workerUrl: service.config.publicUrl, apiToken: service.config.apiToken,
    request: async (url: URL, init: RequestInit) => handleRequest(new Request(url, init), service),
  }),
})
server.listen(port, '127.0.0.1', () => console.log(`Fixture dashboard http://127.0.0.1:${port}`))
const control = createServer(async (req, res) => {
  try {
    if (req.url === '/sends') { res.end(JSON.stringify(sends)); return }
    if (native && req.url === '/native-state') { res.end(JSON.stringify(await native.snapshot())); return }
    if (native && req.url?.startsWith('/native-attachment/')) {
      const response = await native.request(new URL(req.url.slice('/native-attachment'.length), native.service.config.publicUrl), { method: 'GET' })
      res.writeHead(response.status, Object.fromEntries(response.headers.entries())).end(Buffer.from(await response.arrayBuffer())); return
    }
    if (req.url?.startsWith('/v1/') || req.url === '/mcp' || req.url === '/openapi.json') {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const response = await handleRequest(new Request(service.config.publicUrl + req.url, {
        method: req.method, headers: { authorization: req.headers.authorization ?? '', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        ...(!['GET', 'HEAD'].includes(req.method ?? 'GET') ? { body: Buffer.concat(chunks).toString() } : {}),
      }), service)
      res.writeHead(response.status, Object.fromEntries(response.headers.entries())).end(await response.text()); return
    }
    if (req.method !== 'POST') { res.writeHead(404).end(); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.url?.startsWith('/inbox-rpc/')) {
      const response = await handleRequest(new Request(service.config.publicUrl + req.url, {
        method: 'POST', headers: { authorization: req.headers.authorization ?? '', 'content-type': 'application/json' },
        body: Buffer.concat(chunks).toString(),
      }), service)
      res.writeHead(response.status, { 'content-type': 'application/json' }).end(await response.text()); return
    }
    const input = JSON.parse(Buffer.concat(chunks).toString())
    if (req.url === '/notifications') { await sendNotifications(db, service.transport, accountConfig.from, accountConfig.publicUrl); res.end('{}'); return }
    if (req.url === '/triage') { await service.processTriage(); res.end('{}'); return }
    if (req.url === '/routing') { routingAvailable = input.available === true; res.end('{}'); return }
    if (req.url !== '/receive') { res.writeHead(404).end(); return }
    const raw = new TextEncoder().encode([
      `From: ${input.from ?? 'Jamie <jamie@example.net>'}`, `To: ${input.inboxId}`,
      `Message-ID: <${crypto.randomUUID()}@example.net>`, `Subject: ${input.subject ?? 'A fresh start for your inbox'}`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '',
      input.text ?? 'Hi Michael,\r\n\r\nYour standalone email workspace is ready. Inboxes, conversations, and delivery tracking now have a home of their own.\r\n\r\nTry sending a reply when you have a moment.\r\n\r\nJamie',
    ].join('\r\n'))
    const result = await service.receive(input.inboxId, raw, input.quarantine ? {
      status: 'quarantined', scannedAt: new Date().toISOString(), authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass', signingDomains: ['example.net'] },
      spam: { score: 8, threshold: 6 }, antivirus: { status: 'clean', signatures: [] }, reasons: ['spam'],
    } : undefined)
    if (!input.deferTriage) await service.processTriage()
    res.end(JSON.stringify(result))
  } catch { res.writeHead(500).end('Fixture operation failed') }
})
control.listen(port + 1, '127.0.0.1')
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  server.close(); control.close(); void Promise.all([pg.close(), native?.close()]).then(() => process.exit(0))
})
