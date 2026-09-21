import type { Database } from "./database.js"
import type { MessageRow } from "./contracts.js"
import { triageResult } from "./triage-contract.js"
import { TriageError, type TriageAnalyzer } from "./triage.js"

/** `settled` runs after a message's triage reaches a final status, once the update was ours. */
export async function processTriage(db: Database, analyze: TriageAnalyzer,
  settled?: (message: MessageRow, status: "complete" | "failed") => Promise<void>): Promise<void> {
  // Lease one message at a time. A crashed invocation is reclaimed by the cron;
  // a late worker cannot overwrite the result from a newer lease.
  for (let count = 0; count < 10; count++) {
    const lease = crypto.randomUUID()
    const [message] = await db.query<MessageRow & { triage_attempts: number }>(`with due as (
      select m.id from mail.messages m join mail.inboxes i on i.id = m.inbox_id
      where i.deleted_at is null and m.direction = 'received' and m.triage->>'status' = 'pending'
        and coalesce(m.protection->>'status', '') <> 'quarantined'
        and coalesce(m.protection->'antivirus'->>'status', 'clean') = 'clean'
        and m.triage_available_at <= now()
      order by m.triage_available_at, m.id limit 1 for update of m skip locked
    ) update mail.messages m set triage_lease = $1, triage_attempts = triage_attempts + 1,
      triage_available_at = now() + interval '2 minutes' from due where m.id = due.id returning m.*`, [lease])
    if (!message) return
    let result: unknown, retryIn = 0
    try {
      if (message.triage_attempts > 5) throw new TriageError("provider_unavailable", false)
      result = triageResult.parse(await analyze({ ...message, timestamp: new Date(message.timestamp).toISOString() }))
    } catch (error) {
      const failure = error instanceof TriageError ? error : new TriageError("provider_unavailable", true)
      if (failure.retryable && message.triage_attempts < 5) retryIn = Math.max(failure.retryAfter, 30 * 2 ** (message.triage_attempts - 1))
      result = retryIn ? { status: "pending" } : { status: "failed", code: failure.code, failedAt: new Date().toISOString() }
    }
    const updated = await db.query<{ id: string }>(`update mail.messages m set triage = $3::jsonb, triage_lease = null,
      triage_available_at = now() + $4 * interval '1 second'
      where id = $1 and triage_lease = $2 and triage->>'status' = 'pending'
        and coalesce(protection->>'status', '') <> 'quarantined'
        and exists(select 1 from mail.inboxes i where i.id = m.inbox_id and i.deleted_at is null) returning m.id`,
    [message.id, lease, JSON.stringify(result), retryIn])
    const status = (result as { status: string }).status
    if (settled && updated.length && status !== "pending") await settled(message, status as "complete" | "failed").catch(() => {})
  }
}
