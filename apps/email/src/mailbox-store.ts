import type { MessageDelivery } from "./delivery.js"
import {
  MailError,
  type DomainInfo,
  type InboxRow,
  type MailData,
  type MessageRow,
  type SendResult
} from "./contracts.js"
import { triageFilterSql, triageFilterParams, type TriageFilters } from "./triage-contract.js"
import type { Database } from "./database.js"

export interface SendReservation {
  fingerprint: string
  state: "pending" | "sent" | "failed"
  result: SendResult | null
  error: { message: string; code: string; status: number } | null
}

const timestamp = (value: string | Date): string =>
  new Date(value).toISOString()
const messageRow = (row: MessageRow): MessageRow => ({
  ...row,
  timestamp: timestamp(row.timestamp)
})

export class MailboxStore {
  readonly db: Database
  constructor(db: Database) {
    this.db = db
  }

  async inbox(address: string): Promise<InboxRow> {
    const [row] = await this.db.query<InboxRow>(
      `select id, address, custom_address, email_aliases, display_name, created_at, testing
       from mail.inboxes where (address = $1 or custom_address = $1) and deleted_at is null`,
      [address]
    )
    if (!row) throw new MailError("Inbox not found", "not_found", 404)
    return { ...row, created_at: timestamp(row.created_at) }
  }

  /** The account billed for an inbox. Platform-provisioned inboxes have no account and are not metered. */
  async inboxCustomer(inboxId: string): Promise<{ id: string; email: string; name?: string } | null> {
    const [row] = await this.db.query<{ id: string; email: string; display_name: string | null }>(
      `select c.id, c.email, c.display_name from mail.customer_inboxes ci join mail.customers c on c.id = ci.customer_id
       where ci.inbox_id = $1`, [inboxId])
    return row ? { id: row.id, email: row.email, ...(row.display_name ? { name: row.display_name } : {}) } : null
  }

  async sendReserved(inboxId: string, key: string): Promise<boolean> {
    const [row] = await this.db.query("select 1 from mail.sends where inbox_id = $1 and key = $2", [inboxId, key])
    return Boolean(row)
  }

  /** Reports belong to the original sent message, even after domain transfer. */
  async deliveryInbox(sender: string, trackingId: string): Promise<InboxRow> {
    const [row] = await this.db.query<InboxRow>(
      `select i.id, i.address, i.custom_address, i.email_aliases, i.display_name, i.created_at, i.testing
       from mail.messages m join mail.inboxes i on i.id = m.inbox_id
       where m.id = $1 and m.direction = 'sent' and m.data->>'from' = $2 and i.deleted_at is null`,
      [trackingId, sender])
    // Early reports still need the active sender so the caller can request a
    // retry until message storage completes. Retired aliases cannot receive mail.
    return row ? { ...row, created_at: timestamp(row.created_at) } : this.inbox(sender)
  }

  async createInbox(
    address: string,
    domain: string,
    displayName?: string,
    testing = false
  ): Promise<InboxRow> {
    const [row] = await this.db.query<InboxRow>(
      `with ready as (select domain from mail.domains
         where domain = $3 and client_id is null and info->>'status' = 'VERIFIED' for update)
       insert into mail.inboxes (id, address, domain, display_name, testing)
       select $1, $2, domain, $4, $5 from ready
       on conflict (address) do nothing returning *`,
      [crypto.randomUUID(), address, domain, displayName ?? null, testing]
    )
    if (!row)
      throw new MailError(
        "Address is already used or retired; choose another username",
        "inbox_conflict",
        409
      )
    return { ...row, created_at: timestamp(row.created_at) }
  }

  async listInboxes(testing = false): Promise<InboxRow[]> {
    const rows = await this.db.query<InboxRow>(
      `select id, address, display_name, created_at, testing from mail.inboxes where deleted_at is null and testing = $1 order by created_at, id`,
      [testing]
    )
    return rows.map((row) => ({
      ...row,
      created_at: timestamp(row.created_at)
    }))
  }

  async deleteInbox(address: string): Promise<boolean> {
    const [result] = await this.db.query<{ status: string }>(
      `select mail.delete_inbox($1) as status`,
      [address]
    )
    if (result?.status === "pending")
      throw new MailError(
        "Resolve the inbox's pending send before deleting it",
        "send_pending",
        409
      )
    return result?.status === "deleted"
  }

  async saveDomain(info: DomainInfo): Promise<void> {
    await this.db.query(
      `insert into mail.domains(domain, info) values ($1, $2::jsonb)
       on conflict (domain) do update set info = excluded.info where mail.domains.credentials is null`,
      [info.domain, JSON.stringify(info)]
    )
  }
  async assertUnscopedDomain(domain: string): Promise<void> {
    const [row] = await this.db.query<{ client_id: string | null }>(
      "select client_id from mail.domains where domain = $1 and info->>'status' <> 'DELETED'", [domain])
    if (row?.client_id) throw new MailError("This domain belongs to a managed mailbox", "domain_conflict", 409)
  }
  async domains(): Promise<DomainInfo[]> {
    return (
      await this.db.query<{ info: DomainInfo }>(
        `select info from mail.domains where client_id is null order by domain`
      )
    ).map((row) => row.info)
  }
  async deleteDomain(domain: string): Promise<boolean> {
    const [result] = await this.db.query<{ status: string }>("select mail.delete_domain($1) as status", [domain])
    if (result?.status === "in_use")
      throw new MailError(
        "Delete the domain's inboxes first",
        "domain_in_use",
        409
      )
    return result?.status === "deleted"
  }

  async message(inboxId: string, wireId: string): Promise<MessageRow> {
    const [row] = await this.db.query<MessageRow>(
      `select * from mail.messages where inbox_id = $1 and wire_id = $2`,
      [inboxId, wireId]
    )
    if (!row) throw new MailError("Message not found", "not_found", 404)
    return messageRow(row)
  }

  async resolveThread(
    inboxId: string,
    references: string[]
  ): Promise<string> {
    const [row] = await this.db.query<{ thread_id: string }>(
      `select thread_id from mail.messages where inbox_id = $1 and wire_id = any($2::text[])
        and coalesce(protection->>'status', '') <> 'quarantined'
        order by array_position($2::text[], wire_id) desc limit 1`,
      [inboxId, references]
    )
    return row?.thread_id ?? crypto.randomUUID()
  }

  async listMessages(
    inboxId: string,
    options: {
      limit: number
      offset: number
      labels?: string[]
      query?: string
    } & TriageFilters
  ): Promise<MessageRow[]> {
    const rows = await this.db.query<MessageRow>(
      `
      select id, inbox_id, wire_id, thread_id, timestamp, direction, labels, protection, triage,
        (data - 'html') || jsonb_build_object('text', left(data->>'text', 200)) as data
      from mail.messages where inbox_id = $1 and labels @> $2::text[]
        and ($3::text is null or search @@ websearch_to_tsquery('simple', $3))
        and (coalesce(protection->>'status', '') <> 'quarantined' or 'quarantined' = any($2::text[]))
      ${triageFilterSql('triage')}
      order by case when $3::text is not null then ts_rank(search, websearch_to_tsquery('simple', $3)) else 0 end desc,
        timestamp desc, id desc limit $4 offset $5`,
      [
        inboxId,
        options.labels ?? [],
        options.query ?? null,
        options.limit + 1,
        options.offset,
        ...triageFilterParams(options)
      ]
    )
    return rows.map(messageRow)
  }

  async thread(
    inboxId: string,
    threadId: string,
    includeBodies: boolean
  ): Promise<MessageRow[]> {
    if (includeBodies) {
      const [size] = await this.db.query<{ bytes: string }>(
        `select coalesce(sum(octet_length(data::text) + coalesce(octet_length(delivery::text), 0)), 0)::text as bytes from mail.messages where inbox_id = $1 and thread_id = $2`,
        [inboxId, threadId]
      )
      if (Number(size?.bytes) > 8 * 1024 * 1024)
        throw new MailError(
          "Thread bodies exceed 8 MiB; read individual messages",
          "thread_too_large",
          413
        )
    }
    const rows = await this.db.query<MessageRow>(
      `select id, inbox_id, wire_id, thread_id, timestamp, direction, labels, protection, triage,
      case when $3::boolean then delivery else null end as delivery,
      case when $3::boolean then data else (data - 'html') || jsonb_build_object('text', left(data->>'text', 200)) end as data
      from mail.messages where inbox_id = $1 and thread_id = $2 order by timestamp, id limit 501`,
      [inboxId, threadId, includeBodies]
    )
    if (!rows.length)
      throw new MailError("Thread not found", "not_found", 404)
    if (rows.length > 500)
      throw new MailError(
        "Thread exceeds 500 messages; use listMessages",
        "thread_too_large",
        413
      )
    return rows.map(messageRow)
  }

  async listThreads(
    inboxId: string,
    options: {
      limit: number
      offset: number
      labels?: string[]
      includeTrash: boolean
    } & TriageFilters
  ): Promise<Array<Record<string, unknown>>> {
    return this.db.query(
      `with grouped as (
      select thread_id, max(timestamp) as timestamp, count(*)::int as message_count,
        (array_agg(data->>'subject' order by timestamp desc, id desc))[1] as subject,
        (array_agg(case when protection->>'status' = 'quarantined' then '' else left(data->>'text', 200) end
          order by timestamp desc, id desc))[1] as preview,
        (array_agg(wire_id order by timestamp desc, id desc))[1] as last_message_id,
        (array_agg(case when protection->>'status' = 'quarantined' then null else triage end order by timestamp desc, id desc))[1] as triage,
        array_agg(distinct data->>'from') as senders,
        (array_agg(data->'to' order by timestamp desc, id desc))[1] as recipients,
        max(timestamp) filter (where direction = 'received') as received_timestamp,
        max(timestamp) filter (where direction = 'sent') as sent_timestamp,
        sum(jsonb_array_length(data->'attachments'))::int as attachment_count
      from mail.messages where inbox_id = $1
        and (coalesce(protection->>'status', '') <> 'quarantined' or 'quarantined' = any($2::text[]))
        group by thread_id
    ), thread_labels as (
      select thread_id, array_agg(distinct label) as labels
      from mail.messages, unnest(labels) label where inbox_id = $1 group by thread_id
    ) select g.*, coalesce(l.labels, '{}') as labels from grouped g left join thread_labels l using (thread_id)
      where coalesce(l.labels, '{}') @> $2::text[] and ($3::boolean or not ('trash' = any(coalesce(l.labels, '{}'))))
      ${triageFilterSql("g.triage")}
      order by timestamp desc, thread_id desc limit $4 offset $5`,
      [
        inboxId,
        options.labels ?? [],
        options.includeTrash,
        options.limit + 1,
        options.offset,
        ...triageFilterParams(options)
      ]
    )
  }

  async updateLabels(
    inboxId: string,
    threadId: string,
    add: string[],
    remove: string[]
  ): Promise<void> {
    const rows = await this.db.query(
      `update mail.messages set labels = array(
      select distinct label from unnest(labels || $3::text[]) label where not (label = any($4::text[]))
    ) where inbox_id = $1 and thread_id = $2 returning id`,
      [inboxId, threadId, add, remove]
    )
    if (!rows.length)
      throw new MailError("Thread not found", "not_found", 404)
  }

  async updateMessageLabels(inboxId: string, messageId: string, add: string[], remove: string[]): Promise<void> {
    const rows = await this.db.query(
      `update mail.messages set labels = array(
        select distinct label from unnest(labels || $3::text[]) label where not (label = any($4::text[]))
      ) where inbox_id = $1 and wire_id = $2 returning id`,
      [inboxId, messageId, add, remove]
    )
    if (!rows.length) throw new MailError("Message not found", "not_found", 404)
  }

  async reserveSend(
    inboxId: string,
    key: string,
    fingerprint: string
  ): Promise<SendReservation | null> {
    const [inserted] = await this.db.query<{ reserved: boolean }>(
      `select mail.reserve_send($1, $2, $3) as reserved`,
      [inboxId, key, fingerprint]
    ).catch((error: unknown) => {
      if (error instanceof Error && error.message.includes("MAIL_DAILY_SEND_LIMIT"))
        throw new MailError("This inbox has reached its rolling 24-hour send limit", "rate_limited", 429, true)
      throw error
    })
    if (inserted?.reserved) return null
    const [existing] = await this.db.query<SendReservation>(
      `select fingerprint, state, result, error from mail.sends where inbox_id = $1 and key = $2`,
      [inboxId, key]
    )
    if (!existing) throw new MailError("Inbox not found", "not_found", 404)
    return existing
  }

  async failSend(
    inboxId: string,
    key: string,
    error: MailError
  ): Promise<void> {
    await this.db.query(
      `update mail.sends set state = 'failed', error = $3::jsonb where inbox_id = $1 and key = $2`,
      [
        inboxId,
        key,
        JSON.stringify({
          message: error.message,
          code: error.code,
          status: error.status
        })
      ]
    )
  }

  async commitMessage(
    row: MessageRow,
    event: unknown,
    send?: { key: string; result: SendResult; deliveryEvent?: unknown },
    notifyEmail = true
  ): Promise<MessageRow> {
    const [saved] = await this.db.query<MessageRow>(
      `with active as (
      select id from mail.inboxes where id = $2 and deleted_at is null for update
    ), saved as (
      insert into mail.messages(id, inbox_id, wire_id, thread_id, timestamp, direction, labels, data, delivery, protection, triage)
      select $1, id, $3, $4, $5::timestamptz, $6, $7::text[], $8::jsonb, $12::jsonb, $14::jsonb, $15::jsonb from active
      on conflict (inbox_id, wire_id) do update set wire_id = excluded.wire_id returning *
    ), sent as (
      update mail.sends set state = 'sent', result = $11::jsonb
      where inbox_id = $2 and key = $10 and exists(select 1 from saved)
    ), event as (
      insert into mail.outbox(id, inbox_id, payload)
      select saved.id::text, saved.inbox_id, $9::jsonb from saved where saved.id = $1 and $9::jsonb is not null
      on conflict do nothing
    ), notifications as (
      insert into mail.notifications(customer_id, message_id, desktop_requested, email_requested)
      select c.id, saved.id, c.desktop_notifications, c.email_notifications and $16::boolean
      from saved join mail.customer_inboxes ci on ci.inbox_id = saved.inbox_id
        join mail.customers c on c.id = ci.customer_id join mail.inboxes i on i.id = saved.inbox_id
      where saved.id = $1 and saved.direction = 'received' and not i.testing
        and c.disabled_at is null and c.signed_in_at is not null
        and (c.desktop_notifications or (c.email_notifications and $16::boolean))
        and not saved.labels && array['quarantined','spam','trash']::text[]
        and coalesce(saved.protection->>'status', '') <> 'quarantined'
        and coalesce(saved.protection->'antivirus'->>'status', 'clean') = 'clean'
      on conflict do nothing
    ), delivery_event as (
      insert into mail.outbox(id, inbox_id, payload)
      select 'delivery:' || saved.id::text || ':1', saved.inbox_id, $13::jsonb from saved where saved.id = $1 and $13::jsonb is not null
      on conflict do nothing
    ), cleanup as (
      delete from mail.garbage where prefix = $2::text || '/' || $1::text || '/'
        and exists(select 1 from saved where id = $1)
    ) select * from saved`,
      [
        row.id,
        row.inbox_id,
        row.wire_id,
        row.thread_id,
        row.timestamp,
        row.direction,
        row.labels,
        JSON.stringify(row.data),
        event ? JSON.stringify(event) : null,
        send?.key ?? null,
        send ? JSON.stringify(send.result) : null,
        row.delivery ? JSON.stringify(row.delivery) : null,
        send?.deliveryEvent ? JSON.stringify(send.deliveryEvent) : null,
        row.protection ? JSON.stringify(row.protection) : null,
        row.triage ? JSON.stringify(row.triage) : null,
        notifyEmail,
      ]
    )
    if (!saved) throw new MailError("Inbox not found", "not_found", 404)
    return messageRow(saved)
  }

  async applyDelivery(row: MessageRow, version: number, delivery: MessageDelivery, event: unknown): Promise<string> {
    const [result] = await this.db.query<{ status: string }>(
      `select mail.apply_delivery($1, $2, $3, $4::jsonb, $5::jsonb) as status`,
      [row.inbox_id, row.id, version, JSON.stringify(delivery), event ? JSON.stringify(event) : null]
    )
    return result!.status
  }

  async applyGatewayDelivery(row: MessageRow, version: number, delivery: MessageDelivery, event: unknown, suppression: unknown): Promise<string> {
    const [result] = await this.db.query<{ status: string }>(
      `select mail.apply_gateway_delivery($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb) as status`,
      [row.inbox_id, row.id, version, JSON.stringify(delivery), JSON.stringify(event),
        suppression ? JSON.stringify(suppression) : null],
    )
    return result!.status
  }

  async suppressedRecipients(inboxId: string, recipients: string[]): Promise<string[]> {
    const rows = await this.db.query<{ recipient: string }>(
      "select recipient from mail.recipient_suppressions where inbox_id = $1 and recipient = any($2::text[])",
      [inboxId, recipients],
    )
    return rows.map((row) => row.recipient)
  }

  async pendingEvents(): Promise<
    Array<{ id: string; inbox_id: string; payload: unknown; attempts: number }>
  > {
    return this.db.query(`with due as (
      select id from mail.outbox where delivered_at is null and available_at <= now()
      order by available_at limit 25 for update skip locked
    ) update mail.outbox o set available_at = now() + interval '5 minutes', attempts = attempts + 1
      from due where o.id = due.id returning o.id, o.inbox_id, o.payload, o.attempts`)
  }
  async completeIncoming(objectKey: string): Promise<void> {
    await this.db.query(
      `with removed as (
        delete from mail.incoming where object_key = $1 returning object_key
      ) insert into mail.garbage(prefix) select object_key from removed on conflict do nothing`,
      [objectKey]
    )
  }
  async settleEvent(
    id: string,
    delivered: boolean,
    attempts: number
  ): Promise<void> {
    await this.db.query(
      `update mail.outbox set delivered_at = case when $2 then now() else null end,
      available_at = now() + $3 * interval '1 second' where id = $1`,
      [id, delivered, Math.min(3600, 2 ** Math.min(attempts, 12) * 5)]
    )
  }
}

export const emptyMail = (): MailData => ({
  from: "",
  to: [],
  cc: [],
  bcc: [],
  replyTo: [],
  subject: "",
  text: "",
  html: "",
  references: [],
  attachments: []
})
