import { manageApiKeys } from "./api-keys.js"
import type { JWTVerifyGetKey } from "jose"
import { z } from "zod"
import { accessIdentity, type AccessConfig } from "./access-auth.js"
import { address, inputs, MailError, type Operation, type InboxRow } from "./contracts.js"
import { CustomerStore, inviteInput, type CustomerInbox, type Customer } from "./customer-store.js"
import { mailboxCredentials } from "./mail-clients.js"
import type { MailService } from "./mail-service.js"
import { readBytes } from "./security.js"

const mailboxOperations = new Set<Operation>([
  "deleteInbox", "inboxQuota", "listMessages", "getMessage", "listThreads", "getThread", "reviewThread",
  "searchMessages", "send", "reply", "updateMessageLabels", "updateThreadLabels", "getAttachment", "releaseQuarantine",
])
const domainOperations = new Set<Operation>(["listDomains", "createDomain", "verifyDomain", "deleteDomain"])
const inboxView = (row: InboxRow & Partial<CustomerInbox>) => ({ inboxId: row.address, address: row.custom_address ?? row.address,
  deliveryStatus: row.route_ready === false ? "pending" : "ready",
  setupAvailable: typeof row.route_ready === "boolean",
  displayName: row.display_name ?? undefined, createdAt: new Date(row.created_at).toISOString() })

async function verifyCustomerDomain(service: MailService, domain: string) {
  await service.store.assertUnscopedDomain(domain)
  const info = await service.transport.verifyDomain(domain)
  if (info.status !== "VERIFIED") throw new MailError("The email domain is not ready", "domain_not_ready", 422)
  await service.store.saveDomain(info)
}

async function finishRouting(service: MailService, store: CustomerStore, inbox: InboxRow) {
  try {
    await service.transport.ensureInboxRoute?.(inbox.address)
  } catch {
    throw new MailError(`Inbox ${inbox.address} is reserved. Retry this address or use Finish inbox setup to enable delivery.`, "route_pending", 503)
  }
  await store.markRouteReady(inbox.id)
  return inboxView({ ...inbox, route_ready: true })
}

export async function handleCustomerRequest(request: Request, service: MailService, config?: AccessConfig, key?: JWTVerifyGetKey): Promise<Response> {
  if (!config) throw new MailError("Customer sign-in is not configured", "not_configured", 503)
  if (request.method !== "POST") throw new MailError("Not found", "not_found", 404)
  const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? ""
  const identity = await accessIdentity(token, config, key)
  const store = new CustomerStore(service.store.db, config.adminEmails)
  const customer = await store.resolve(identity)
  return executeCustomerRequest(request, service, store, customer, new URL(request.url).pathname.slice("/dashboard-rpc/".length))
}

export async function executeCustomerRequest(request: Request, service: MailService, store: CustomerStore, customer: Customer, operation: string): Promise<Response> {
  let raw: unknown
  try { raw = JSON.parse(new TextDecoder().decode(await readBytes(request.body, 5 * 1024 * 1024))) }
  catch (error) { if (error instanceof MailError) throw error; throw new MailError("Invalid JSON") }
  const object = z.record(z.string(), z.unknown()).safeParse(raw)
  if (!object.success) throw new MailError("Invalid email request")
  const result = async (): Promise<unknown> => {
    if (["createApiKey", "listApiKeys", "revokeApiKey"].includes(operation)) return manageApiKeys(service.store.db, customer, operation, raw)
    if (operation === "session") return { customer, defaultDomain: service.config.defaultDomain, apiUrl: service.config.publicUrl,
      customDomainsEnabled: customer.role === "admin" && Boolean(service.customDomains) }
    if (["listCustomers", "inviteCustomer", "setCustomerAccess"].includes(operation)) {
      if (customer.role !== "admin") throw new MailError("Administrator access required", "forbidden", 403)
      if (operation === "listCustomers") return store.list()
      if (operation === "inviteCustomer") {
        const input = inviteInput.safeParse(raw)
        if (!input.success) throw new MailError("Enter a valid email, name, and inbox limit")
        return store.invite(input.data)
      }
      const input = z.object({ customerId: z.uuid(), enabled: z.boolean() }).strict().safeParse(raw)
      if (!input.success) throw new MailError("Invalid customer access request")
      return store.setAccess(input.data.customerId, input.data.enabled)
    }
    if (operation === "listInboxes") return { inboxes: (await store.inboxes(customer, customer.role === "admin")).map(inboxView) }
    if (operation === "createInbox") {
      const input = inputs.createInbox.strict().safeParse(raw)
      if (!input.success) throw new MailError("Invalid inbox details")
      const domain = service.config.defaultDomain
      if (!domain) throw new MailError("The email domain is not configured", "not_configured", 503)
      if (input.data.domain && input.data.domain !== domain) throw new MailError("Use the account's email domain", "forbidden", 403)
      const name = input.data.username?.toLowerCase() ?? `agent-${crypto.randomUUID().slice(0, 12)}`
      const inbox = `${name}@${domain}`
      if (!address.safeParse(inbox).success) throw new MailError("Choose a shorter username")
      const existing = await store.inboxes(customer)
      if (customer.inboxLimit !== null && existing.length >= customer.inboxLimit && !existing.some((i) => i.address === inbox))
        throw new MailError("Your account has reached its inbox limit", "inbox_limit", 422)
      await verifyCustomerDomain(service, domain)
      await store.provision(customer, inbox, domain, input.data.displayName)
      return finishRouting(service, store, await service.store.inbox(inbox))
    }
    if (domainOperations.has(operation as Operation)) {
      if (customer.role !== "admin") throw new MailError("Administrator access required", "forbidden", 403)
      return service.execute(operation as Operation, raw)
    }
    if (!mailboxOperations.has(operation as Operation) && !["getCredentials", "rotateCredentials", "finishInboxSetup", "setupStatus"].includes(operation))
      throw new MailError("Unknown dashboard operation", "not_found", 404)
    const input = object.data
    if (typeof input.inboxId !== "string") throw new MailError("Choose an inbox")
    const inbox = await service.store.inbox(input.inboxId)
    if (inbox.testing) throw new MailError("Inbox not found", "not_found", 404)
    await store.owns(customer, inbox.id)
    if (operation === "setupStatus") {
      const [setup] = await service.store.db.query<{ route_ready: boolean; connected_at: string | null; received_at: string | null }>(
        `select ci.route_ready,
           case when c.connected_token_version = c.token_version then c.connected_at end as connected_at,
           (select min(m.timestamp) from mail.messages m where m.inbox_id = ci.inbox_id
             and m.direction = 'received' and coalesce(m.protection->>'status', '') <> 'quarantined'
             and not ('trash' = any(m.labels))) as received_at
         from mail.customer_inboxes ci join mail.clients c on c.inbox_id = ci.inbox_id
         where ci.inbox_id = $1`, [inbox.id])
      if (!setup) throw new MailError("This inbox does not use customer setup", "not_found", 404)
      return { inboxId: inbox.address, deliveryReady: setup.route_ready,
        connectedAt: setup.connected_at ? new Date(setup.connected_at).toISOString() : null,
        receivedAt: setup.received_at ? new Date(setup.received_at).toISOString() : null }
    }
    if (operation === "finishInboxSetup") {
      await store.requireCustomerInbox(inbox.id)
      await verifyCustomerDomain(service, inbox.address.slice(inbox.address.lastIndexOf("@") + 1))
      return finishRouting(service, store, inbox)
    }
    if (operation === "inboxQuota" && customer.role !== "admin")
      return { count: (await store.inboxes(customer)).length, limit: customer.inboxLimit }
    if (operation === "getCredentials" || operation === "rotateCredentials")
      return mailboxCredentials(service, inbox.id, operation === "rotateCredentials")
    return service.execute(operation as Operation, { ...input, inboxId: inbox.address,
      ...(operation === "releaseQuarantine" ? { reviewedBy: customer.id } : {}) })
  }
  return Response.json({ result: await result() }, { headers: { "cache-control": "no-store" } })
}
