import type { Database } from "./database.js"
import type { Transport } from "./contracts.js"

// Recheck ownership and protection at delivery, not only when mail arrives.
const eligible = `join mail.messages m on m.id = n.message_id
  join mail.inboxes i on i.id = m.inbox_id
  join mail.customer_inboxes ci on ci.inbox_id = i.id and ci.customer_id = n.customer_id
  join mail.customers c on c.id = n.customer_id
  where c.disabled_at is null and c.signed_in_at is not null and i.deleted_at is null and not i.testing
    and m.direction = 'received' and not m.labels && array['quarantined','spam','trash']::text[]
    and coalesce(m.protection->>'status', '') <> 'quarantined'
    and coalesce(m.protection->'antivirus'->>'status', 'clean') = 'clean'
    and n.created_at > now() - interval '1 day'`

export async function desktopNotifications(db: Database, customerId: string, since?: string) {
  const notifications = await db.query<{ id: string; inboxId: string; createdAt: string }>(
    `select n.id, i.address as "inboxId", n.created_at as "createdAt" from mail.notifications n ${eligible}
     and c.id = $1 and c.desktop_notifications and n.desktop_requested
     and ($2::timestamptz is null or n.created_at >= $2::timestamptz)
     order by n.created_at desc, n.id desc limit 100`, [customerId, since ?? null])
  return { notifications }
}

export async function sendNotifications(db: Database, transport: Transport, from: string, publicUrl: string) {
  await db.query(`delete from mail.notifications where created_at < now() - interval '7 days'`)
  for (let batch = 0; batch < 10; batch++) {
    // Reserve before calling the provider. An uncertain result is never retried:
    // the transport accepts no idempotency key and delivery may already have happened.
    const rows = await db.query<{ id: string; customer_id: string }>(
      `with candidate as (
        select n.customer_id from mail.notifications n ${eligible}
        and c.email_notifications and n.email_requested and n.email_state = 'pending'
        order by n.created_at limit 1
      ), due as (
        select n.id from mail.notifications n ${eligible}
        and n.customer_id = (select customer_id from candidate) and c.email_notifications
        and n.email_requested and n.email_state = 'pending'
        order by n.created_at limit 100 for update of n skip locked
      ) update mail.notifications n set email_state = 'attempted' from due where n.id = due.id
        returning n.id, n.customer_id`)
    if (!rows.length) return
    const ids = rows.map(row => row.id)
    let transportStarted = false
    try {
      await db.transaction(async tx => {
        // Settings updates acquire this same row lock. An opt-out either wins
        // before delivery, or waits for the already-started send to finish.
        await tx.query("select id from mail.customers where id = $1 for update", [rows[0]!.customer_id])
        const [recipient] = await tx.query<{ email: string; count: number }>(
          `select c.email, count(*)::int as count from mail.notifications n ${eligible}
           and n.id = any($1::uuid[]) and c.email_notifications and n.email_requested group by c.email`, [ids])
        let state = 'failed'
        if (recipient) {
          const text = `${recipient.count} new ${recipient.count === 1 ? 'message has' : 'messages have'} arrived in your inboxes.\n\nOpen your inboxes: ${new URL('/app#/inboxes', publicUrl).href}\n\nChange notification preferences: ${new URL('/app#/settings', publicUrl).href}`
          transportStarted = true
          try {
            const result = await transport.send({
              from: { address: from, name: "Bezalel Email" }, to: [recipient.email], cc: [], bcc: [],
              headers: { "Auto-Submitted": "auto-generated", "X-Bezalel-Notification": "new-mail" },
              subject: "New mail in Bezalel Email", text,
            })
            if ([...result.delivered, ...result.queued].includes(recipient.email)) state = 'accepted'
          } catch { /* Delivery may have happened, so do not retry the transport. */ }
        }
        await tx.query(`update mail.notifications set email_state = $2 where id = any($1::uuid[])`, [ids, state])
      })
    } catch (error) {
      // Reservation was committed outside the transaction. Restore only work
      // known not to have reached the transport, including failed lookups.
      if (!transportStarted) await db.query(
        `update mail.notifications set email_state = 'pending' where id = any($1::uuid[]) and email_state = 'attempted'`, [ids])
      throw error
    }
  }
}
