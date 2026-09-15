import { afterEach, describe, expect, it, vi } from "vitest"
import { CustomDomains } from "../src/custom-domains.js"
import { gatewayTransport, handleGatewayRequest } from "../src/gateway.js"
import { ingestGatewayDelivery, type GatewayDelivery } from "../src/gateway-delivery.js"
import { MailService } from "../src/mail-service.js"
import { cleanProtection, fixture } from "./support.js"
import { ingestFeedback } from "../src/feedback.js"

const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.pg.close() })
async function setup() {
  const f = await fixture()
  fixtures.push(f)
  const dns = new Map<string, string[]>()
  const gateway = { url: "https://mx.gateway.test", hostname: "mx.gateway.test", ipv4: "192.0.2.1",
    token: "gateway-token-".repeat(4), encryptionKey: "a".repeat(64) }
  const custom = new CustomDomains(f.db, gateway, ["example.com"], async (name, type) => dns.get(type + ":" + name) ?? [])
  const info = await custom.create("customer.test")
  for (const r of info.records) dns.set(r.type + ":" + r.name, [r.type === "MX" ? r.priority + " " + r.value + "." : r.value])
  const request = vi.fn<typeof fetch>(async (_, options) => {
    const body = JSON.parse(String(options?.body))
    return Response.json({ messageId: `<${body.trackingId}@customer.test>`, queued: body.recipients,
      delivered: [], bounced: [], suppressed: [] })
  })
  const service = new MailService({ ...f.service, customDomains: custom, transport: gatewayTransport(f.service.transport, custom, request) })
  const inbox = await service.execute("createInbox", { username: "agent", domain: "customer.test" }) as { inboxId: string }
  const send = (key: string, to = ["reader@outside.test"]) => service.send({
    inboxId: inbox.inboxId, to, cc: [], bcc: ["hidden@outside.test"], subject: "Canary", text: "Hello", idempotencyKey: key,
  })
  const result = await send("first")
  const storedInbox = await service.store.inbox(inbox.inboxId)
  const read = () => service.store.message(storedInbox.id, result.messageId)
  const row = await read()
  const event = (status: GatewayDelivery["status"], extra: Partial<GatewayDelivery> = {}): GatewayDelivery => ({
    trackingId: row.id, messageId: row.wire_id, sender: inbox.inboxId, recipient: "reader@outside.test",
    status, occurredAt: new Date().toISOString(), eventId: crypto.randomUUID(), ...extra,
  })
  return { ...f, service, request, inbox, storedInbox, read, event, send, gateway }
}

describe("native gateway delivery", () => {
  it.each(["delivered", "bounced"] as const)("applies %s after a future-dated deferral and ignores later deferral replays", async (status) => {
    const f = await setup()
    const deferred = f.event("deferred", { occurredAt: new Date(Date.now() + 240_000).toISOString() })
    expect(await ingestGatewayDelivery(f.service, deferred)).toBe("updated")
    const terminal = f.event(status, { smtpEnhancedStatusCode: status === "bounced" ? "5.1.1" : "2.0.0" })
    expect(await ingestGatewayDelivery(f.service, terminal)).toBe("updated")
    const after = (await f.read()).delivery
    expect(after?.recipients[0]?.status).toBe(status)
    expect(await f.service.store.suppressedRecipients(f.storedInbox.id, [terminal.recipient]))
      .toEqual(status === "bounced" ? [terminal.recipient] : [])
    expect(await ingestGatewayDelivery(f.service, deferred)).toBe("ignored")
    expect(await ingestGatewayDelivery(f.service, terminal)).toBe("ignored")
    expect((await f.read()).delivery).toEqual(after)
  })

  it("accepts verified ARF complaints once and ignores forged, redacted, and partially signed reports", async () => {
    const f = await setup()
    f.service.customDomains!.config.feedbackSigners = ["reports.provider.test"]
    const row = await f.read()
    const report = (recipient = "reader@outside.test", signature = "v=1; d=reports.provider.test; s=test; h=from:content-type; b=fixture; bh=fixture") =>
      new TextEncoder().encode([
        "From: feedback@reports.provider.test", "To: feedback@mx.gateway.test",
        "DKIM-Signature: " + signature, "MIME-Version: 1.0",
        'Content-Type: multipart/report; report-type=feedback-report; boundary="arf-canary"', "",
        "--arf-canary", "Content-Type: text/plain", "", "Provider feedback.", "",
        "--arf-canary", "Content-Type: message/feedback-report", "",
        "Feedback-Type: abuse", "User-Agent: Provider/1", "Version: 1",
        "Original-Mail-From: <" + row.data.from + ">", "Original-Rcpt-To: <" + recipient + ">", "",
        "--arf-canary", "Content-Type: message/rfc822", "",
        "From: " + row.data.from, "To: reader@outside.test", "Message-ID: " + row.wire_id, "",
        "Original message.", "", "--arf-canary--", "",
      ].join("\r\n"))
    const scan = { ...cleanProtection(), authentication: {
      spf: "pass" as const, dkim: "pass" as const, dmarc: "pass" as const, signingDomains: ["reports.provider.test"],
    } }
    expect(await ingestFeedback(f.service, report(), cleanProtection())).toBe("ignored")
    expect(await ingestFeedback(f.service, report("unmatched@outside.test"), scan)).toBe("ignored")
    expect(await ingestFeedback(f.service, report(""), scan)).toBe("ignored")
    expect(await ingestFeedback(f.service, report("reader@outside.test", "v=1; d=reports.provider.test; h=from:content-type; l=0; b=fixture"), scan)).toBe("ignored")
    expect(await ingestFeedback(f.service, report("reader@outside.test", "v=1; d=reports.provider.test; h=from; b=fixture"), scan)).toBe("ignored")
    expect(await f.service.store.suppressedRecipients(f.storedInbox.id, ["reader@outside.test"])).toEqual([])
    expect(await ingestFeedback(f.service, report(), scan)).toBe("updated")
    expect(await ingestFeedback(f.service, report(), scan)).toBe("ignored")
    expect((await f.read()).delivery?.recipients[0]?.status).toBe("complained")
    await f.send("after-complaint")
    expect(JSON.parse(String(f.request.mock.calls[1]![1]!.body)).recipients).toEqual(["hidden@outside.test"])
  })

  it("reserves feedback routing only when configured and requires scanner metadata on inbound delivery", async () => {
    const f = await setup()
    const headers = { authorization: "Bearer " + f.gateway.token }
    const lookup = (value: string, kind = "recipient") => handleGatewayRequest(
      new Request("https://worker.test/gateway/" + kind + "?value=" + value, { headers }), f.service).then((r) => r.json())
    expect(await lookup("feedback@mx.gateway.test")).toEqual({ allowed: false })
    f.service.customDomains!.config.feedbackSigners = ["reports.provider.test"]
    expect(await lookup("mx.gateway.test", "domain")).toEqual({ allowed: true })
    expect(await lookup("feedback@mx.gateway.test")).toEqual({ allowed: true })
    expect(await lookup("other@mx.gateway.test")).toEqual({ allowed: false })
    await expect(handleGatewayRequest(new Request("https://worker.test/gateway/receive", {
      method: "POST", headers: { ...headers, "x-bezalel-recipient": f.inbox.inboxId }, body: "unscanned",
    }), f.service)).rejects.toMatchObject({ code: "scan_required", transient: true })
  })

  it("does not leave a message deferred when final delivery shares a log timestamp", async () => {
    const f = await setup()
    const occurredAt = new Date().toISOString()
    await ingestGatewayDelivery(f.service, f.event("deferred", { occurredAt, eventId: "z" }))
    await ingestGatewayDelivery(f.service, f.event("delivered", { occurredAt, eventId: "a" }))
    expect((await f.read()).delivery?.recipients[0]?.status).toBe("delivered")
  })
  it("tracks final delivery and replays a duplicate without another outbox event", async () => {
    const f = await setup()
    const update = f.event("delivered", { deliveryTimeMs: 1200 })
    expect(await ingestGatewayDelivery(f.service, update)).toBe("updated")
    const current = (await f.read()).delivery
    expect(current?.recipients[0]).toMatchObject({ status: "delivered", provider: "bezalel-smtp", deliveryTimeMs: 1200 })
    expect(await ingestGatewayDelivery(f.service, update)).toBe("ignored")
    expect((await f.read()).delivery).toEqual(current)
    const outbox = await f.db.query("select * from mail.outbox where payload->>'type'='email.delivery_updated'")
    expect(outbox).toHaveLength(2)
  })

  it("atomically suppresses a hard bounce and leaves allowed BCC delivery intact", async () => {
    const f = await setup()
    await ingestGatewayDelivery(f.service, f.event("bounced", { smtpEnhancedStatusCode: "5.1.1" }))
    await f.send("next")
    const body = JSON.parse(String(f.request.mock.calls[1]![1]!.body))
    expect(body.to).toEqual(["reader@outside.test"])
    expect(body.bcc).toEqual(["hidden@outside.test"])
    expect(body.recipients).toEqual(["hidden@outside.test"])
    await ingestGatewayDelivery(f.service, f.event("complained", { recipient: "hidden@outside.test" }))
    const allSuppressed = await f.send("none")
    expect(f.request).toHaveBeenCalledTimes(2)
    const message = await f.service.store.message(f.storedInbox.id, allSuppressed.messageId)
    expect(message.delivery?.recipients.map((r) => r.status)).toEqual(["rejected", "rejected"])
  })

  it("does not suppress a temporary failure or a retry queue expiry with a 4.x code", async () => {
    const f = await setup()
    await ingestGatewayDelivery(f.service, f.event("deferred", { smtpEnhancedStatusCode: "4.4.1" }))
    await ingestGatewayDelivery(f.service, f.event("bounced", { smtpEnhancedStatusCode: "4.4.1" }))
    expect(await f.service.store.suppressedRecipients(f.storedInbox.id, ["reader@outside.test"])).toEqual([])
  })

  it("keeps suppressions within the sending inbox", async () => {
    const f = await setup()
    await ingestGatewayDelivery(f.service, f.event("bounced", { smtpEnhancedStatusCode: "5.1.1" }))
    const other = await f.service.execute("createInbox", { username: "other", domain: "customer.test" }) as { inboxId: string }
    await f.service.send({ inboxId: other.inboxId, to: ["reader@outside.test"], subject: "", text: "Hello", idempotencyKey: "other" })
    expect(JSON.parse(String(f.request.mock.calls[1]![1]!.body)).recipients).toContain("reader@outside.test")
  })

  it("ignores forged tracking IDs and recipients, retries early events, and requires report verification for complaints", async () => {
    const f = await setup()
    expect(await ingestGatewayDelivery(f.service, f.event("bounced", { trackingId: crypto.randomUUID() }))).toBe("ignored")
    expect(await ingestGatewayDelivery(f.service, f.event("bounced", { recipient: "foreign@outside.test" }))).toBe("ignored")
    await expect(ingestGatewayDelivery(f.service, f.event("delivered", { messageId: "<not-stored@customer.test>" }))).rejects.toMatchObject({ code: "message_pending" })
    await expect(handleGatewayRequest(new Request("https://worker.test/gateway/delivery", {
      method: "POST", headers: { authorization: "Bearer " + f.gateway.token },
      body: JSON.stringify(f.event("complained")),
    }), f.service)).rejects.toMatchObject({ status: 422 })
    const unauthorized = await handleGatewayRequest(new Request("https://worker.test/gateway/delivery", {
      method: "POST", headers: { authorization: "Bearer wrong-token" }, body: JSON.stringify(f.event("delivered")),
    }), f.service)
    expect(unauthorized.status).toBe(401)
  })

  it("rolls delivery and its outbox back if suppression storage fails", async () => {
    const f = await setup()
    const row = await f.read()
    const before = row.delivery!
    await expect(f.service.store.applyGatewayDelivery(row, before.version, { ...before, version: 2 }, { type: "invalid" },
      { recipient: "reader@outside.test", reason: "invalid", eventId: "invalid" })).rejects.toThrow()
    expect((await f.read()).delivery).toEqual(before)
    expect(await f.db.query("select * from mail.outbox where payload->>'type'='invalid'")).toEqual([])
  })
})
