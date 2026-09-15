import { z } from "zod"
import { domainName, inputs, MailError, type DomainInfo } from "./contracts.js"
import type { MailService } from "./mail-service.js"

interface ClientDomain { domain: string; client_address: string; info: DomainInfo }
const input = z.object({
  domain: domainName,
  username: inputs.createInbox.shape.username.unwrap(),
  inboxId: z.string().optional()
}).strict()
const empty = z.object({ inboxId: z.string().optional() }).strict()

async function connected(service: MailService, clientId: string) {
  const [row] = await service.store.db.query<ClientDomain>(
    `select domain, client_address, info from mail.domains
     where client_id = $1 and info->>'status' <> 'DELETED'`, [clientId])
  return row
}

/** A mailbox credential can manage only the domain registered to its client. */
export async function clientDomainRequest(
  service: MailService, clientId: string, operation: string, raw: unknown
) {
  const custom = service.customDomains
  if (operation === "connectCustomDomain") {
    if (!custom) throw new MailError("Custom email domains are temporarily unavailable. Contact support.", "not_configured", 503)
    const parsed = input.safeParse(raw)
    if (!parsed.success) throw new MailError("Enter a valid domain and email name", "invalid_argument", 422)
    const { domain, username } = parsed.data
    await custom.create(domain, { id: clientId, address: `${username.toLowerCase()}@${domain}` })
  } else {
    if (!empty.safeParse(raw).success) throw new MailError("Invalid domain request", "invalid_argument", 422)
    if (operation === "disconnectCustomDomain") {
      try {
        const [result] = await service.store.db.query<{ removed: boolean }>(
          "select mail.disconnect_client_domain($1) as removed", [clientId])
        if (!result?.removed) throw new MailError("Mailbox not found", "not_found", 404)
      } catch (error) {
        if (error instanceof Error && error.message.includes("MAIL_SEND_PENDING"))
          throw new MailError("An email is still being sent. Try disconnecting again after it finishes.", "send_pending", 409)
        throw error
      }
    } else if (operation !== "getCustomDomain") throw new MailError("Not found", "not_found", 404)
  }
  const row = await connected(service, clientId)
  const detail = row && custom && operation === "getCustomDomain" ? await custom.verify(row.domain) : row?.info
  const [inbox] = await service.store.db.query<{ address: string; custom_address: string | null }>(
    `select i.address, i.custom_address from mail.clients c join mail.inboxes i on i.id = c.inbox_id
     where c.client_id = $1 and i.deleted_at is null`, [clientId])
  if (!inbox) throw new MailError("Mailbox not found", "not_found", 404)
  return {
    available: Boolean(custom),
    connected: Boolean(row),
    emailAddress: inbox.custom_address ?? inbox.address,
    ...(row && detail ? {
      domain: row.domain, status: detail.status, records: detail.records,
      requestedEmailAddress: row.client_address, active: inbox.custom_address === row.client_address
    } : {})
  }
}
