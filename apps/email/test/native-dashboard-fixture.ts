import { PGlite } from '@electric-sql/pglite'
import { migrate, type Database } from '../src/database.js'
import { MailboxStore } from '../src/mailbox-store.js'
import { MailService } from '../src/mail-service.js'
import { handleRequest } from '../src/worker.js'
import type { ObjectStore, Transport } from '../src/contracts.js'

// Separate local storage proves that the dashboard does not adopt native inboxes.
export async function nativeDashboardFixture(objects: ObjectStore, transport: Transport) {
  const pg = new PGlite()
  const db: Database = {
    query: async <T>(sql: string, params: unknown[] = []) => (await pg.query<T>(sql, params)).rows,
    transaction: task => pg.transaction(tx => task({ query: async <T>(sql: string, params: unknown[] = []) => (await tx.query<T>(sql, params)).rows })),
  }
  await migrate(db)
  const service = new MailService({ store: new MailboxStore(db), objects, transport,
    config: { defaultDomain: 'example.com', domains: { 'example.com': 'a'.repeat(32) },
      publicUrl: 'https://bezalel-email.michaelwasihun96.workers.dev', apiToken: 'fixture-native-platform-token-'.repeat(3),
      webhookSecret: 'fixture-native-webhook-secret-'.repeat(3) },
  })
  for (const [username, displayName] of [['research', 'Research agent'], ['support', 'Support agent']])
    await service.execute('createInbox', { username, displayName })
  const raw = (id: string, subject: string, body: string, references?: string) => new TextEncoder().encode([
    'From: Jamie <jamie@example.net>', 'To: research@example.com', `Message-ID: <${id}@example.net>`, `Subject: ${subject}`,
    ...(references ? [`References: <${references}@example.net>`, `In-Reply-To: <${references}@example.net>`] : []),
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary=native-fixture', '',
    '--native-fixture', 'Content-Type: text/plain; charset=utf-8', '', body,
    '--native-fixture', 'Content-Type: text/plain; name="summary.txt"', 'Content-Disposition: attachment; filename="summary.txt"', '',
    'Synthetic attachment for dashboard verification.', '--native-fixture--', '',
  ].join('\r\n'))
  await service.receive('research@example.com', raw('research', 'Research summary', 'The research summary is ready.\n\nExisting conversations stay with their original inbox and owner.'))
  await service.receive('research@example.com', raw('followup', 'Re: Research summary', 'The supporting notes are attached for your review.', 'research'))
  await service.receive('support@example.com', raw('support', 'Support handoff', 'A separate inbox keeps its own conversation history.'))
  return {
    service,
    request: (url: URL, init: RequestInit) => handleRequest(new Request(url, init), service),
    snapshot: async () => Object.fromEntries(await Promise.all(['inboxes', 'messages', 'clients', 'customer_inboxes'].map(async table => [table,
      await db.query(`select to_jsonb(t) as row from mail.${table} t order by to_jsonb(t)::text`)]))),
    close: () => pg.close(),
  }
}
