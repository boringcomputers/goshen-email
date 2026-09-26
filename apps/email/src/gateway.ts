import { z } from "zod"
import { address, domainName, MailError, type Transport } from "./contracts.js"
import { CustomDomains } from "./custom-domains.js"
import type { MailService } from "./mail-service.js"
import { equalSecret, readBytes } from "./security.js"
import { gatewayDelivery, ingestGatewayDelivery } from "./gateway-delivery.js"
import { MailboxStore } from "./mailbox-store.js"
import { inboundProtection, type InboundScanner } from "./protection.js"
import { ingestFeedback } from "./feedback.js"

export const gatewayScanner = (config: { url: string; token: string }, request: typeof fetch = fetch): InboundScanner =>
  async (raw, envelope) => {
    const response = await request(new URL("/scan", config.url), {
      method: "POST", headers: { authorization: `Bearer ${config.token}`,
        "content-type": "message/rfc822", "x-bezalel-sender": envelope.sender,
        "x-bezalel-recipient": envelope.recipient },
      body: raw as BodyInit, signal: AbortSignal.timeout(55_000), redirect: "manual",
    })
    if (!response.ok) throw new MailError("Incoming mail scanners are unavailable", "scanner_unavailable", 503, true)
    return inboundProtection.parse(JSON.parse(new TextDecoder().decode(await readBytes(response.body, 8192))))
  }

const receipt = z.object({
  messageId: z.string().min(1).max(998),
  delivered: z.array(address), queued: z.array(address),
  bounced: z.array(address), suppressed: z.array(address)
})

export const gatewayTransport = (
  cloudflare: Transport,
  custom: CustomDomains,
  request: typeof fetch = fetch
): Transport => ({
  verifyDomain: (domain) => custom.managedDomains.includes(domain)
    ? cloudflare.verifyDomain(domain) : custom.verify(domain),
  async send(input) {
    const from = typeof input.from === "string" ? input.from : input.from.address
    const domain = from.split("@")[1]!
    if (custom.managedDomains.includes(domain)) {
      const { trackingId: _, ...managed } = input
      return cloudflare.send(managed)
    }
    const trackingId = z.uuid().parse(input.trackingId)
    const store = new MailboxStore(custom.db)
    const inbox = await store.inbox(from)
    const recipients = [...new Set([...input.to, ...input.cc, ...input.bcc])]
    const suppressed = await store.suppressedRecipients(inbox.id, recipients)
    const allowed = recipients.filter((recipient) => !suppressed.includes(recipient))
    if (!allowed.length) return { messageId: `<${trackingId}@${domain}>`, delivered: [], queued: [], bounced: [], suppressed }
    const dkim = await custom.signingKey(domain)
    let response: Response
    try {
      response = await request(new URL("/send", custom.config.url), {
        method: "POST", headers: {
          authorization: `Bearer ${custom.config.token}`, "content-type": "application/json"
        },
        body: JSON.stringify({ ...input, trackingId, recipients: allowed, dkim }),
        signal: AbortSignal.timeout(25_000), redirect: "manual"
      })
    } catch {
      throw new MailError("Mail gateway did not return a receipt; delivery may have occurred", "delivery_uncertain", 502, true)
    }
    if (!response.ok) throw new MailError("Mail gateway could not accept the message", "gateway_error", 502, response.status >= 500)
    const parsed = receipt.safeParse(await response.json().catch(() => null))
    if (!parsed.success) throw new MailError("Mail gateway receipt was unreadable; delivery may have occurred", "delivery_uncertain", 502, true)
    return { ...parsed.data, suppressed: [...new Set([...parsed.data.suppressed, ...suppressed])] }
  }
})

export async function handleGatewayRequest(request: Request, service: MailService): Promise<Response> {
  const custom = service.customDomains
  const authorization = request.headers.get("authorization") ?? ""
  if (!custom || !equalSecret(authorization, `Bearer ${custom.config.token}`))
    return Response.json({ error: "Unauthorized" }, { status: 401 })
  const url = new URL(request.url)
  const feedbackAddress = custom.config.feedbackSigners?.length ? `feedback@${custom.config.hostname}` : null
  if (request.method === "POST" && url.pathname === "/gateway/delivery") {
    const raw = await readBytes(request.body, 8192)
    const input = gatewayDelivery.parse(JSON.parse(new TextDecoder().decode(raw)))
    if (input.status === "complained") throw new MailError("Complaints require a verified feedback report", "invalid_request", 422)
    const result = await ingestGatewayDelivery(service, input)
    await service.flushEvents()
    return Response.json({ result })
  }
  if (request.method === "GET" && (url.pathname === "/gateway/domain" || url.pathname === "/gateway/recipient")) {
    const value = url.searchParams.get("value") ?? ""
    const domainOnly = url.pathname === "/gateway/domain"
    if (!(domainOnly ? domainName : address).safeParse(value).success)
      return Response.json({ allowed: false })
    if (value === custom.config.hostname || value.split("@")[1] === custom.config.hostname)
      return Response.json({ allowed: Boolean(feedbackAddress && (domainOnly || value === feedbackAddress)) })
    try {
      if (!domainOnly && (await service.store.inbox(value)).testing) return Response.json({ allowed: false })
      await custom.ready(domainOnly ? value : value.split("@")[1]!)
      return Response.json({ allowed: true })
    } catch (error) {
      if (error instanceof MailError && ["not_found", "domain_not_ready"].includes(error.code))
        return Response.json({ allowed: false })
      throw error
    }
  }
  if (request.method === "POST" && url.pathname === "/gateway/receive") {
    const recipient = address.safeParse(request.headers.get("x-bezalel-recipient"))
    if (!recipient.success) throw new MailError("Invalid recipient")
    const metadata = request.headers.get("x-bezalel-protection") ?? ""
    if (metadata.length > 8192) throw new MailError("Invalid scan result")
    let protection
    try { protection = inboundProtection.parse(JSON.parse(metadata)) } catch {
      throw new MailError("Incoming mail requires a completed scan", "scan_required", 503, true)
    }
    const raw = await readBytes(request.body, 25 * 1024 * 1024)
    if (recipient.data === feedbackAddress) {
      await ingestFeedback(service, raw, protection)
      await service.flushEvents()
      return Response.json({ messageId: "feedback-accepted" })
    }
    if ((await service.store.inbox(recipient.data)).testing) throw new MailError("Inbox not found", "not_found", 404)
    await custom.ready(recipient.data.split("@")[1]!)
    return Response.json(await service.receive(recipient.data, raw, protection))
  }
  return Response.json({ error: "Not found" }, { status: 404 })
}
