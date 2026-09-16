import { PGlite } from '@electric-sql/pglite'
import { URL as NodeURL } from 'node:url'
import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { generateKeyPair, SignJWT } from 'jose'
import { migrate, type Database } from '../src/database.js'
import { MailboxStore } from '../src/mailbox-store.js'
import { MailService } from '../src/mail-service.js'
import { CustomerStore } from '../src/customer-store.js'
import { handleRequest } from '../src/worker.js'
import type { ObjectStore } from '../src/contracts.js'

// Loopback-only fixture: signed test identities, isolated PostgreSQL, and no provider traffic.
const { accessDashboardHandler } = await import(new URL('../../email-dashboard/src/access-handler.mjs', import.meta.url).href)
const { customerMailClient } = await import(new URL('../../email-dashboard/src/service.mjs', import.meta.url).href)
const pg = new PGlite()
const db: Database = { query: async <T>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows }
await migrate(db)
const access = { teamDomain: 'fixture.cloudflareaccess.com', audience: 'a'.repeat(64), adminEmails: ['owner@example.net'] }
const keys = await generateKeyPair('RS256')
const blobs = new Map<string, Uint8Array>()
const objects: ObjectStore = {
  async put(key, body) { blobs.set(key, typeof body === 'string' ? new TextEncoder().encode(body) : new Uint8Array(body)) },
  async get(key) { const value = blobs.get(key); return value ? { body: new Response(value).body! } : null },
  async list({ prefix }) { return { objects: [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false } },
  async delete(keys) { for (const key of typeof keys === 'string' ? [keys] : keys) blobs.delete(key) },
}
const service = new MailService({ store: new MailboxStore(db), objects,
  config: { defaultDomain: 'agents.example.com', domains: { 'agents.example.com': 'a'.repeat(32) }, publicUrl: 'https://fixture.example.com', apiToken: 'fixture-worker-token-'.repeat(3), webhookSecret: `whsec_${Buffer.from('fixture-webhook-secret-'.repeat(3)).toString('base64')}` },
  transport: {
    verifyDomain: async (domain) => ({ domainId: domain, domain, status: 'VERIFIED', records: [] }),
    send: async (input) => ({ messageId: `<${crypto.randomUUID()}@fixture.example.com>`, delivered: input.to, queued: [], bounced: [], suppressed: [] }),
  },
})
const store = new CustomerStore(db, access.adminEmails)
await store.invite({ email: 'alex@example.net', displayName: 'Alex', inboxLimit: 5 })
await store.invite({ email: 'sam@example.net', displayName: 'Sam', inboxLimit: 5 })
const client = customerMailClient({ workerUrl: service.config.publicUrl,
  request: (url: URL, init: RequestInit) => handleRequest(new Request(url, init), service, access, async () => keys.publicKey) })
const servers: Server[] = []
for (const [index, email] of ['owner@example.net', 'alex@example.net', 'sam@example.net'].entries()) {
  const jwt = await new SignJWT({ email, type: 'app' }).setProtectedHeader({ alg: 'RS256' })
    .setIssuer(`https://${access.teamDomain}`).setAudience(access.audience).setSubject(email).setIssuedAt().setExpirationTime('2h').sign(keys.privateKey)
  const port = Number(process.env.FIXTURE_PORT ?? 3042) + index
  const origin = `http://127.0.0.1:${port}`
  if (index) {
    const inbox = await client.execute('createInbox', { username: email.split('@')[0], displayName: email.split('@')[0] }, jwt)
    await service.receive(inbox.inboxId, new TextEncoder().encode([
      'From: Jamie <jamie@example.org>', `To: ${inbox.inboxId}`, `Message-ID: <${crypto.randomUUID()}@example.org>`,
      `Subject: ${index === 1 ? 'Alex project update' : 'Sam private planning notes'}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '',
      index === 1 ? 'Hi Alex,\r\n\r\nThe project is ready for your review. Let me know what you think.\r\n\r\nJamie' : 'Hi Sam,\r\n\r\nHere are your private planning notes for next week.\r\n\r\nJamie',
    ].join('\r\n')), { status: 'clean', scannedAt: new Date().toISOString(), authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass', signingDomains: ['example.org'] }, spam: { score: 0, threshold: 6 }, antivirus: { status: 'clean', signatures: [] }, reasons: [] })
  }
  const handle = accessDashboardHandler({ client, publicUrl: origin,
    asset: (file: string) => readFile(new NodeURL(`../../email-dashboard/public/${file}`, import.meta.url)) })
  const server = createServer(async (incoming, outgoing) => {
    try {
      if (incoming.headers.host !== new URL(origin).host) { outgoing.writeHead(403).end(); return }
      const headers = new Headers(incoming.headers as Record<string, string>)
      headers.set('cf-access-jwt-assertion', jwt)
      const request = new Request(origin + incoming.url, { method: incoming.method, headers,
        ...(!['GET', 'HEAD'].includes(incoming.method!) ? { body: Readable.toWeb(incoming), duplex: 'half' } : {}) } as RequestInit)
      const response = await handle(request)
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    } catch { outgoing.writeHead(500).end('Fixture request failed') }
  })
  server.listen(port, '127.0.0.1', () => console.log(`Fixture ${email}: ${origin}`))
  servers.push(server)
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  for (const server of servers) server.close()
  void pg.close().then(() => process.exit(0))
})
