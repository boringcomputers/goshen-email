import type { JWTVerifyGetKey } from "jose"
import { z } from "zod"
import { accessIdentity, type AccessConfig } from "./access-auth.js"
import { address, inputs, MailError, type Operation, type InboxRow } from "./contracts.js"
import { CustomerStore, inviteInput } from "./customer-store.js"
import { mailboxCredentials } from "./mail-clients.js"
import type { MailService } from "./mail-service.js"
import { readBytes } from "./security.js"

const mailboxOperations = new Set<Operation>([
  "deleteInbox", "inboxQuota", "listMessages", "getMessage", "listThreads", "getThread", "reviewThread",
  "searchMessages", "send", "reply", "updateMessageLabels", "updateThreadLabels", "getAttachment", "releaseQuarantine",
])
const domainOperations = new Set<Operation>(["listDomains", "createDomain", "verifyDomain", "deleteDomain"])
const inboxView = (row: InboxRow) => ({ inboxId: row.address, address: row.custom_address ?? row.address,
  displayName: row.display_name ?? undefined, createdAt: new Date(row.created_at).toISOString() })

export async function handleCustomerRequest(request: Request, service: MailService, config?: AccessConfig, key?: JWTVerifyGetKey): Promise<Response> {
  if (!config) throw new MailError("Customer sign-in is not configured", "not_configured", 503)
  if (request.method !== "POST") throw new MailError("Not found", "not_found", 404)
  const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? ""
  const identity = await accessIdentity(token, config, key)
  const store = new CustomerStore(service.store.db, config.adminEmails)
  const customer = await store.resolve(identity)
  let raw: unknown
  try { raw = JSON.parse(new TextDecoder().decode(await readBytes(request.body, 5 * 1024 * 1024))) }
  catch (error) { if (error instanceof MailError) throw error; throw new MailError("Invalid JSON") }
  const object = z.record(z.string(), z.unknown()).safeParse(raw)
  if (!object.success) throw new MailError("Invalid email request")
  const operation = new URL(request.url).pathname.slice("/dashboard-rpc/".length)
  const result = async (): Promise<unknown> => {
    if (operation === "session") return { customer, defaultDomain: service.config.defaultDomain,
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
    if (operation === "listInboxes") return customer.role === "admin"
      ? service.execute("listInboxes", {}) : { inboxes: (await store.inboxes(customer)).map(inboxView) }
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
      if (existing.length >= customer.inboxLimit && !existing.some((i) => i.address === inbox))
        throw new MailError("Your account has reached its inbox limit", "inbox_limit", 422)
      await service.store.assertUnscopedDomain(domain)
      const info = await service.transport.verifyDomain(domain)
      if (info.status !== "VERIFIED") throw new MailError("The email domain is not ready", "domain_not_ready", 422)
      await service.store.saveDomain(info)
      await service.transport.ensureInboxRoute?.(inbox)
      await store.provision(customer, inbox, domain, input.data.displayName)
      return inboxView(await service.store.inbox(inbox))
    }
    if (domainOperations.has(operation as Operation)) {
      if (customer.role !== "admin") throw new MailError("Administrator access required", "forbidden", 403)
      return service.execute(operation as Operation, raw)
    }
    if (!mailboxOperations.has(operation as Operation) && !["getCredentials", "rotateCredentials"].includes(operation))
      throw new MailError("Unknown dashboard operation", "not_found", 404)
    const input = object.data
    if (typeof input.inboxId !== "string") throw new MailError("Choose an inbox")
    const inbox = await service.store.inbox(input.inboxId)
    if (inbox.testing) throw new MailError("Inbox not found", "not_found", 404)
    await store.owns(customer, inbox.id)
    if (operation === "inboxQuota" && customer.role !== "admin")
      return { count: (await store.inboxes(customer)).length, limit: customer.inboxLimit }
    if (operation === "getCredentials" || operation === "rotateCredentials")
      return mailboxCredentials(service, inbox.id, operation === "rotateCredentials")
    return service.execute(operation as Operation, { ...input, inboxId: inbox.address,
      ...(operation === "releaseQuarantine" ? { reviewedBy: customer.id } : {}) })
  }
  return Response.json({ result: await result() }, { headers: { "cache-control": "no-store" } })
}
