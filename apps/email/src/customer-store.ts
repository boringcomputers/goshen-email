import { z } from "zod"
import type { AccessIdentity } from "./access-auth.js"
import type { Database } from "./database.js"
import { MailError, type InboxRow } from "./contracts.js"
import { inboxGroup, listAccountInboxes } from "./account-inbox-contract.js"

interface CustomerRow {
  id: string; email: string; display_name: string | null; access_subject: string | null;
  organization_name: string; desktop_notifications: boolean; email_notifications: boolean;
  created_at: string; signed_in_at: string | null; disabled_at: string | null; inbox_limit: number | null
}
export type CustomerInbox = InboxRow & { route_ready: boolean | null; group_name: string | null }
export interface Customer { id: string; email: string; displayName?: string; organizationName?: string; desktopNotifications?: boolean; emailNotifications?: boolean; role: "admin" | "customer"; inboxLimit: number | null }
const view = (row: CustomerRow, adminEmails: string[]): Customer => ({
  id: row.id, email: row.email, displayName: row.display_name ?? undefined,
  organizationName: row.organization_name ?? "Your workspace",
  desktopNotifications: row.desktop_notifications ?? false, emailNotifications: row.email_notifications ?? false,
  role: adminEmails.includes(row.email) ? "admin" : "customer", inboxLimit: adminEmails.includes(row.email) ? null : row.inbox_limit,
})
export const inviteInput = z.object({
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  displayName: z.string().trim().min(1).max(200).optional(),
  inboxLimit: z.number().int().min(1).max(100).nullable().default(null),
}).strict()
const settingsName = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\u0000-\u001f\u007f]+$/u)
export const updateSettingsInput = z.object({
  organizationName: settingsName(100).optional(),
  displayName: settingsName(200).optional(),
  desktopNotifications: z.boolean().optional(),
  emailNotifications: z.boolean().optional(),
}).strict().refine(input => Object.values(input).some(value => value !== undefined))
const inboxCursor = z.object({ customer: z.uuid(), all: z.boolean(), group: inboxGroup.nullable(),
  createdAt: z.iso.datetime({ precision: 6 }), id: z.uuid() }).strict()

export class CustomerStore {
  constructor(readonly db: Database, readonly adminEmails: string[]) {}

  async resolve(identity: AccessIdentity): Promise<Customer> {
    if (this.adminEmails.includes(identity.email)) {
      await this.db.query("insert into mail.customers(email) values ($1) on conflict (email) do nothing", [identity.email])
    }
    const [row] = await this.db.query<CustomerRow>(
      `update mail.customers set access_subject = coalesce(access_subject, $2), signed_in_at = coalesce(signed_in_at, now())
       where email = $1 and disabled_at is null and (access_subject is null or access_subject = $2) returning *`,
      [identity.email, identity.subject])
    if (!row) throw new MailError("This account does not have dashboard access. Contact the owner for an invitation.", "access_denied", 403)
    return view(row, this.adminEmails)
  }

  async resolveAccount(user: { id: string; email: string; name: string; emailVerified: boolean }): Promise<Customer> {
    if (!user.emailVerified) throw new MailError("Verify your email to continue", "unauthorized", 401)
    const [row] = await this.db.query<CustomerRow>(
      `insert into mail.customers(email, display_name, auth_user_id, signed_in_at) values ($1, $2, $3, now())
       on conflict (email) do update set auth_user_id = coalesce(mail.customers.auth_user_id, excluded.auth_user_id),
         signed_in_at = coalesce(mail.customers.signed_in_at, now())
       where mail.customers.disabled_at is null and (mail.customers.auth_user_id is null or mail.customers.auth_user_id = excluded.auth_user_id)
       returning *`, [user.email.toLowerCase(), user.name, user.id])
    if (!row) throw new MailError("Your dashboard access has been disabled. Contact the owner.", "access_denied", 403)
    return view(row, this.adminEmails)
  }

  async invite(input: z.infer<typeof inviteInput>): Promise<{ customer: Customer }> {
    const [row] = await this.db.query<CustomerRow>(
      `insert into mail.customers(email, display_name, inbox_limit) values ($1, $2, $3)
       on conflict (email) do nothing returning *`, [input.email, input.displayName ?? null, input.inboxLimit])
    if (!row) throw new MailError("This customer already exists. Manage their access below.", "customer_exists", 409)
    return { customer: view(row, this.adminEmails) }
  }

  async list() {
    const rows = await this.db.query<CustomerRow & { inbox_count: number }>(
      `select c.*, (select count(*)::int from mail.customer_inboxes ci join mail.inboxes i on i.id = ci.inbox_id
         where ci.customer_id = c.id and i.deleted_at is null) as inbox_count
       from mail.customers c order by c.created_at desc, c.id limit 200`)
    return { customers: rows.map((row) => ({ ...view(row, this.adminEmails), inboxCount: row.inbox_count,
      status: row.disabled_at ? "disabled" : row.signed_in_at ? "active" : "invited" })) }
  }

  async updateSettings(customer: Customer, input: z.infer<typeof updateSettingsInput>): Promise<{ customer: Customer }> {
    const [row] = await this.db.query<CustomerRow>(
      `with updated as (
         update mail.customers set organization_name = coalesce($2, organization_name),
           display_name = coalesce($3, display_name),
           desktop_notifications = coalesce($4, desktop_notifications), email_notifications = coalesce($5, email_notifications)
         where id = $1 and disabled_at is null returning *
       ), notifications as (
         update mail.notifications set desktop_requested = case when $4 = false then false else desktop_requested end,
           email_requested = case when $5 = false then false else email_requested end
         where customer_id = $1 and ($4 = false or $5 = false) and exists(select 1 from updated)
       ), profile as (
         update mail.auth_users u set name = updated.display_name, "updatedAt" = now()
         from updated where u.id = updated.auth_user_id and $3::text is not null returning u.id
       ) select * from updated`, [customer.id, input.organizationName ?? null, input.displayName ?? null, input.desktopNotifications ?? null, input.emailNotifications ?? null])
    if (!row) throw new MailError("Your dashboard access has been disabled", "access_denied", 403)
    return { customer: view(row, this.adminEmails) }
  }

  async setAccess(customerId: string, enabled: boolean) {
    const [row] = await this.db.query<CustomerRow>("select * from mail.customers where id = $1", [customerId])
    if (!row) throw new MailError("Customer not found", "not_found", 404)
    if (this.adminEmails.includes(row.email)) throw new MailError("Administrator access is managed in the deployment configuration", "forbidden", 403)
    await this.db.query("select mail.set_customer_access($1, $2)", [customerId, enabled])
    return { enabled }
  }

  async inboxes(customer: Customer, input: z.infer<typeof listAccountInboxes>, all = false) {
    const includeAll = all && customer.role === "admin", group = input.group ?? null
    let cursor: z.infer<typeof inboxCursor> | undefined
    if (input.pageToken) {
      try { cursor = inboxCursor.parse(JSON.parse(Buffer.from(input.pageToken, "base64url").toString("utf8"))) }
      catch { throw new MailError("Invalid inbox page token") }
      if (cursor.customer !== customer.id || cursor.all !== includeAll || cursor.group !== group)
        throw new MailError("Use the page token with the same account and group")
    }
    const rows = await this.db.query<CustomerInbox & { cursor_time: string }>(
      `select i.*, c.route_ready, c.group_name,
         to_char(i.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_time
       from mail.inboxes i left join mail.customer_inboxes c on c.inbox_id = i.id
       where (c.customer_id = $1 or $2::boolean) and i.deleted_at is null and i.testing = false
         and ($3::text is null or c.group_name = $3)
         and ($4::timestamptz is null or (i.created_at, i.id) > ($4::timestamptz, $5::uuid))
       order by i.created_at, i.id limit $6`,
      [customer.id, includeAll, group, cursor?.createdAt ?? null, cursor?.id ?? null, input.limit + 1])
    const inboxes = rows.slice(0, input.limit), last = inboxes.at(-1)
    const nextPageToken = rows.length > input.limit && last ? Buffer.from(JSON.stringify({
      customer: customer.id, all: includeAll, group, createdAt: last.cursor_time, id: last.id,
    })).toString("base64url") : undefined
    return { inboxes, nextPageToken }
  }

  async inbox(customer: Customer, address: string): Promise<CustomerInbox> {
    const [row] = await this.db.query<CustomerInbox>(
      `select i.*, c.route_ready, c.group_name from mail.inboxes i left join mail.customer_inboxes c on c.inbox_id = i.id
       where (c.customer_id = $1 or $2::boolean) and i.address = $3 and i.deleted_at is null and i.testing = false`,
      [customer.id, customer.role === "admin", address])
    if (!row) throw new MailError("Inbox not found", "not_found", 404)
    return row
  }

  async setGroup(customer: Customer, address: string, group: string | null): Promise<CustomerInbox> {
    const rows = await this.db.query(
      `update mail.customer_inboxes c set group_name = $3 from mail.inboxes i
       where c.inbox_id = i.id and c.customer_id = $1 and i.address = $2
         and i.deleted_at is null and i.testing = false returning c.inbox_id`, [customer.id, address, group])
    if (!rows.length) throw new MailError("Inbox not found", "not_found", 404)
    return this.inbox(customer, address)
  }

  async inboxCount(customer: Customer): Promise<number> {
    const [row] = await this.db.query<{ count: number }>(
      `select count(*)::int as count from mail.customer_inboxes c join mail.inboxes i on i.id = c.inbox_id
       where c.customer_id = $1 and i.deleted_at is null and i.testing = false`, [customer.id])
    return row!.count
  }

  async markRouteReady(inboxId: string): Promise<void> {
    await this.db.query("update mail.customer_inboxes set route_ready = true where inbox_id = $1", [inboxId])
  }

  async requireCustomerInbox(inboxId: string): Promise<void> {
    const [row] = await this.db.query("select 1 from mail.customer_inboxes where inbox_id = $1", [inboxId])
    if (!row) throw new MailError("This inbox does not use customer setup", "not_found", 404)
  }

  async owns(customer: Customer, inboxId: string): Promise<void> {
    if (customer.role === "admin") return
    const [row] = await this.db.query("select 1 from mail.customer_inboxes where customer_id = $1 and inbox_id = $2", [customer.id, inboxId])
    if (!row) throw new MailError("Inbox not found", "not_found", 404)
  }

  async provision(customer: Customer, address: string, domain: string, displayName?: string, group?: string): Promise<void> {
    try {
      await this.db.query("select mail.provision_customer_inbox($1, $2, $3, $4, $5, $6)", [customer.id, address, domain, displayName ?? null, customer.role === "admin", group ?? null])
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      if (message.includes("CUSTOMER_INBOX_LIMIT")) throw new MailError("Your account has reached its inbox limit", "inbox_limit", 422)
      if (message.includes("CUSTOMER_DISABLED")) throw new MailError("Your dashboard access has been disabled", "access_denied", 403)
      if (error && typeof error === "object" && "code" in error && error.code === "23505")
        throw new MailError("This address is already used or retired. Choose another username.", "inbox_conflict", 409)
      throw error
    }
  }
}
