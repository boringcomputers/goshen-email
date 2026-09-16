import { z } from "zod"
import type { AccessIdentity } from "./access-auth.js"
import type { Database } from "./database.js"
import { MailError, type InboxRow } from "./contracts.js"

interface CustomerRow {
  id: string; email: string; display_name: string | null; access_subject: string | null;
  created_at: string; signed_in_at: string | null; disabled_at: string | null; inbox_limit: number
}
export interface Customer { id: string; email: string; displayName?: string; role: "admin" | "customer"; inboxLimit: number }
const view = (row: CustomerRow, adminEmails: string[]): Customer => ({
  id: row.id, email: row.email, displayName: row.display_name ?? undefined,
  role: adminEmails.includes(row.email) ? "admin" : "customer", inboxLimit: row.inbox_limit,
})
export const inviteInput = z.object({
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  displayName: z.string().trim().min(1).max(200).optional(),
  inboxLimit: z.number().int().min(1).max(100).default(5),
}).strict()

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

  async setAccess(customerId: string, enabled: boolean) {
    const [row] = await this.db.query<CustomerRow>("select * from mail.customers where id = $1", [customerId])
    if (!row) throw new MailError("Customer not found", "not_found", 404)
    if (this.adminEmails.includes(row.email)) throw new MailError("Administrator access is managed in the deployment configuration", "forbidden", 403)
    await this.db.query("select mail.set_customer_access($1, $2)", [customerId, enabled])
    return { enabled }
  }

  async inboxes(customer: Customer): Promise<InboxRow[]> {
    return this.db.query<InboxRow>(
      `select i.* from mail.inboxes i join mail.customer_inboxes c on c.inbox_id = i.id
       where c.customer_id = $1 and i.deleted_at is null and i.testing = false order by i.created_at, i.id`, [customer.id])
  }

  async owns(customer: Customer, inboxId: string): Promise<void> {
    if (customer.role === "admin") return
    const [row] = await this.db.query("select 1 from mail.customer_inboxes where customer_id = $1 and inbox_id = $2", [customer.id, inboxId])
    if (!row) throw new MailError("Inbox not found", "not_found", 404)
  }

  async provision(customer: Customer, address: string, domain: string, displayName?: string): Promise<void> {
    try {
      await this.db.query("select mail.provision_customer_inbox($1, $2, $3, $4)", [customer.id, address, domain, displayName ?? null])
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
