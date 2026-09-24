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
      publicUrl: 'https://native-mail.example.com', apiToken: 'fixture-native-platform-token-'.repeat(3),
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
  const deleted = await service.receive('support@example.com', raw('deleted', 'Deleted note', 'This note belongs only in Trash.'))
  await service.execute('updateMessageLabels', { inboxId: 'support@example.com', messageId: deleted.messageId, addLabels: ['trash'] })
  const archive = await service.receive('support@example.com', raw('archive', 'Long archive', 'Archive entry 0 body.'))
  await db.query("update mail.messages set timestamp = '2020-01-01' where wire_id = $1", [archive.messageId])
  await db.query(`insert into mail.messages(id, inbox_id, wire_id, thread_id, timestamp, direction, labels, data)
    select gen_random_uuid(), inbox_id, '<archive-' || n || '@example.net>', thread_id,
      timestamp + n * interval '1 second', direction, labels,
      data || jsonb_build_object('text', 'Archive entry ' || n || ' body.', 'attachments', '[]'::jsonb)
    from mail.messages cross join generate_series(1, 500) n where wire_id = $1`, [archive.messageId])
  const large = await service.receive('support@example.com', raw('large', 'Large body archive', 'Large body entry 0.'))
  await db.query(`update mail.messages set timestamp = '2021-01-01',
    data = data || jsonb_build_object('text', 'Large body entry 0. ' || repeat('x', 1048576), 'attachments', '[]'::jsonb)
    where wire_id = $1`, [large.messageId])
  await db.query(`insert into mail.messages(id, inbox_id, wire_id, thread_id, timestamp, direction, labels, data)
    select gen_random_uuid(), inbox_id, '<large-' || n || '@example.net>', thread_id,
      timestamp + n * interval '1 second', direction, labels,
      data || jsonb_build_object('text', 'Large body entry ' || n || '. ' || repeat('x', 1048576))
    from mail.messages cross join generate_series(1, 8) n where wire_id = $1`, [large.messageId])
  return {
    service,
    request: (url: URL, init: RequestInit) => handleRequest(new Request(url, init), service),
    snapshot: async () => Object.fromEntries(await Promise.all(['inboxes', 'messages', 'clients', 'customer_inboxes'].map(async table => [table,
      await db.query(`select to_jsonb(t) as row from mail.${table} t order by to_jsonb(t)::text`)]))),
    close: () => pg.close(),
  }
}
