import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest"
import { CustomDomains, type GatewayConfig } from "../src/custom-domains.js"
import { gatewayTransport } from "../src/gateway.js"
import { ingestFeedback } from "../src/feedback.js"
import { MailService } from "../src/mail-service.js"
import { handleRequest } from "../src/worker.js"
import { fixture, config, rawMail, cleanProtection } from "./support.js"

const gateway: GatewayConfig = { url: "https://mx.test", hostname: "mx.test", ipv4: "192.0.2.50", token: "gateway-test-token-".repeat(3), encryptionKey: "a".repeat(64) }
const domain = "mail.customer.test"
let f: Awaited<ReturnType<typeof fixture>>
let service: MailService
let custom: CustomDomains
let dns: Map<string, string[]>
const delivery = vi.fn<typeof fetch>()
beforeAll(async () => { f = await fixture() })
afterAll(async () => { await f.pg.close() })
beforeEach(async () => {
  await f.pg.exec("truncate mail.inboxes, mail.domains, mail.messages, mail.sends, mail.outbox cascade")
  dns = new Map()
  custom = new CustomDomains(f.db, gateway, ["example.com"], async (name, type) => dns.get(`${type}:${name}`) ?? [])
  service = new MailService({ ...f.service, customDomains: custom, transport: gatewayTransport(f.service.transport, custom, delivery) })
  delivery.mockReset().mockImplementation(async () => Response.json({ messageId: `<${crypto.randomUUID()}@mx.test>`, queued: ["friend@example.net"], delivered: [], bounced: [], suppressed: [] }))
  f.send.mockClear()
})
async function request(path: string, input: unknown, token = config.apiToken) {
  return handleRequest(new Request(`https://mail.test${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(input) }), service)
}
async function provision(clientId = "ruth-a", limit = 250) {
  const response = await request("/clients/provision", { clientId, username: clientId, dailySendLimit: limit, webhookUrl: `https://${clientId}.test/eve/v1/email/inbound` })
  expect(response.status).toBe(200)
  return (await response.json() as any).result
}
async function rpc(client: { apiKey: string }, name: string, input = {}, status = 200) {
  const response = await request(`/inbox-rpc/${name}`, input, client.apiKey)
  const payload = await response.json() as any
  expect(response.status, JSON.stringify(payload)).toBe(status)
  return payload.result ?? payload.error
}
async function connect(client: { apiKey: string }, name = domain) {
  return rpc(client, "connectCustomDomain", { domain: name, username: "ruth" })
}
function publish(state: any) {
  for (const record of state.records) dns.set(`${record.type}:${record.name}`, [record.type === "MX" ? `${record.priority} ${record.value}.` : record.value])
}

it("requires all DNS records, preserves mailbox identity and history, and sends with the custom DKIM identity", async () => {
  const client = await provision()
  const old = await rpc(client, "send", { to: ["friend@example.net"], text: "Before", idempotencyKey: "before" })
  const pending = await connect(client)
  expect(pending).toMatchObject({ connected: true, active: false, emailAddress: client.inboxId, requestedEmailAddress: `ruth@${domain}` })
  publish(pending)
  dns.delete(`TXT:_bezalel.${domain}`)
  expect(await rpc(client, "getCustomDomain")).toMatchObject({ status: "PENDING", active: false })
  publish(pending)
  expect(await rpc(client, "getCustomDomain")).toMatchObject({ status: "VERIFIED", active: true, emailAddress: `ruth@${domain}` })
  expect(await rpc(client, "getInbox")).toMatchObject({ inboxId: client.inboxId, address: `ruth@${domain}` })
  expect(await provision()).toMatchObject({ inboxId: client.inboxId, apiKey: client.apiKey, webhookSecret: client.webhookSecret, address: `ruth@${domain}` })
  expect(await rpc(client, "getMessage", { messageId: old.messageId })).toMatchObject({ from: client.inboxId })
  const sent = await rpc(client, "send", { to: ["friend@example.net"], text: "After", idempotencyKey: "after" })
  const wire = JSON.parse(String(delivery.mock.calls[0]![1]!.body))
  expect(wire.from).toBe(`ruth@${domain}`)
  expect(wire.dkim.domainName).toBe(domain)
  expect(await rpc(client, "getMessage", { messageId: sent.messageId })).toMatchObject({ inboxId: client.inboxId, from: `ruth@${domain}` })
  await service.receive(`ruth@${domain}`, rawMail(), cleanProtection())
  const messages = await rpc(client, "listMessages")
  expect(messages.messages).toHaveLength(3)
  expect(messages.messages.every((message: any) => message.inboxId === client.inboxId)).toBe(true)
  expect(await rpc(client, "disconnectCustomDomain")).toMatchObject({ connected: false, emailAddress: client.inboxId })
  expect((await rpc(client, "listMessages")).messages).toHaveLength(3)
  await expect(service.store.inbox(`ruth@${domain}`)).rejects.toMatchObject({ status: 404 })
})

it("isolates domain ownership from other mailbox credentials and global Bezalel operations", async () => {
  const a = await provision()
  const b = await provision("ruth-b")
  publish(await connect(a))
  await rpc(a, "getCustomDomain")
  expect(await rpc(b, "getCustomDomain")).toMatchObject({ connected: false })
  await rpc(b, "connectCustomDomain", { domain, username: "ruth" }, 409)
  await rpc(b, "getCustomDomain", { inboxId: a.inboxId }, 403)
  await rpc(b, "getCustomDomain", { domain }, 422)
  await rpc(b, "disconnectCustomDomain")
  expect(await rpc(a, "getCustomDomain")).toMatchObject({ active: true })
  expect(await service.execute("listDomains", {})).not.toContainEqual(expect.objectContaining({ domain }))
  for (const operation of ["createDomain", "verifyDomain", "createInbox", "deleteDomain"])
    await expect(service.execute(operation as any, operation === "createDomain" ? { domain } : operation === "createInbox" ? { domain, username: "intruder" } : { domainId: domain })).rejects.toMatchObject({ status: 409 })
  await service.execute("createDomain", { domain: "operator.test" })
  await rpc(b, "connectCustomDomain", { domain: "operator.test", username: "ruth" }, 409)
})

it("limits an instance to one domain and rotates proof after disconnect or transfer", async () => {
  const a = await provision()
  const b = await provision("ruth-b")
  const first = await connect(a)
  expect(await connect(a)).toEqual(first)
  await rpc(a, "connectCustomDomain", { domain: "second.test", username: "ruth" }, 409)
  await rpc(a, "connectCustomDomain", { domain, username: "different" }, 409)
  publish(first)
  await rpc(a, "getCustomDomain")
  await rpc(a, "disconnectCustomDomain")
  const second = await connect(b)
  expect(second.records[0].value).not.toBe(first.records[0].value)
  expect(await rpc(b, "getCustomDomain")).toMatchObject({ status: "PENDING", active: false })
})

it("fences DNS verification started before disconnect and never revives the old address", async () => {
  const a = await provision()
  publish(await connect(a))
  let release!: () => void
  let entered!: () => void
  const pause = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const slow = new CustomDomains(f.db, gateway, ["example.com"], async (name, type) => { const value = dns.get(`${type}:${name}`) ?? []; entered(); await pause; return value })
  const pending = slow.verify(domain).catch(error => error)
  await started
  await rpc(a, "disconnectCustomDomain")
  release()
  expect(await pending).toMatchObject({ status: 404 })
  expect(await rpc(a, "getInbox")).toMatchObject({ address: a.inboxId })
})

it("keeps quota and idempotency on the original inbox and refuses disconnect during a send", async () => {
  const a = await provision("ruth-a", 1)
  publish(await connect(a))
  await rpc(a, "getCustomDomain")
  let release!: () => void
  let entered!: () => void
  const pause = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  delivery.mockImplementationOnce(async () => { entered(); await pause; return Response.json({ messageId: "<sent@mx.test>", queued: ["friend@example.net"], delivered: [], bounced: [], suppressed: [] }) })
  const input = { to: ["friend@example.net"], text: "Hello", idempotencyKey: "one" }
  const pending = rpc(a, "send", input)
  await started
  await rpc(a, "disconnectCustomDomain", {}, 409)
  release()
  await pending
  await rpc(a, "disconnectCustomDomain")
  expect(await rpc(a, "send", input)).toMatchObject({ deduplicated: true })
  await rpc(a, "send", { ...input, idempotencyKey: "two" }, 429)
})

it("cleans up domains when the platform deletes a mailbox", async () => {
  const a = await provision()
  publish(await connect(a))
  await rpc(a, "getCustomDomain")
  expect((await request("/clients/delete", { clientId: "ruth-a" })).status).toBe(200)
  await expect(service.store.inbox(`ruth@${domain}`)).rejects.toMatchObject({ status: 404 })
  expect((await f.db.query<any>("select info from mail.domains where domain = $1", [domain]))[0].info.status).toBe("DELETED")
})

it("keeps managed email usable when the SMTP gateway has not been configured", async () => {
  const a = await provision()
  service = f.service
  expect(await rpc(a, "getCustomDomain")).toMatchObject({ available: false, connected: false, emailAddress: a.inboxId })
  await rpc(a, "connectCustomDomain", { domain, username: "ruth" }, 503)
  expect(await rpc(a, "getInbox")).toMatchObject({ address: a.inboxId })
})

it("excludes previous custom addresses from reply-all after disconnect", async () => {
  const a = await provision()
  publish(await connect(a))
  await rpc(a, "getCustomDomain")
  const incoming = new TextEncoder().encode(new TextDecoder().decode(rawMail()).replace('To: Agent <agent@example.com>', `To: Ruth <ruth@${domain}>`).replace('Cc: colleague@example.net', `Cc: ${a.inboxId}, ruth@${domain}, colleague@example.net`))
  const received = await service.receive(`ruth@${domain}`, incoming, cleanProtection())
  await rpc(a, "disconnectCustomDomain")
  await rpc(a, "reply", { messageId: received.messageId, text: "Reply after disconnect", replyAll: true, idempotencyKey: "reply" })
  const sent = f.send.mock.calls.at(-1)![0]
  expect(sent.to).toEqual(["support@example.net"])
  expect(sent.cc).toEqual(["colleague@example.net"])
})

it("re-reads the sender after a disconnect wins the race with send reservation", async () => {
  const a = await provision()
  publish(await connect(a))
  await rpc(a, "getCustomDomain")
  const reserve = service.store.reserveSend.bind(service.store)
  const spy = vi.spyOn(service.store, "reserveSend").mockImplementationOnce(async (...args) => {
    await rpc(a, "disconnectCustomDomain")
    return reserve(...args)
  })
  try {
    await rpc(a, "send", { to: ["friend@example.net"], text: "Race", idempotencyKey: "race" })
    expect(delivery).not.toHaveBeenCalled()
    expect(f.send.mock.calls.at(-1)![0].from).toBe(a.inboxId)
  } finally { spy.mockRestore() }
})

it.each([false, true])("keeps the latest DNS observation when an older ready=%s check finishes late", async (oldReady) => {
  const a = await provision()
  const pending = await connect(a)
  if (oldReady) publish(pending)
  let release!: () => void
  let entered!: () => void
  const pause = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const slow = new CustomDomains(f.db, gateway, ["example.com"], async (name, type) => {
    const records = dns.get(`${type}:${name}`) ?? []
    entered(); await pause; return records
  })
  const older = slow.verify(domain)
  await started
  if (oldReady) dns.clear(); else publish(pending)
  const latest = await custom.verify(domain)
  expect(latest.status).toBe(oldReady ? "PENDING" : "VERIFIED")
  release()
  expect(await older).toEqual(latest)
  expect(await rpc(a, "getInbox")).toMatchObject({ address: oldReady ? a.inboxId : `ruth@${domain}` })
})

it.each([false, true])("routes late bounce and complaint reports to the original mailbox after transfer=%s", async (transfer) => {
  const a = await provision()
  const b = await provision("ruth-b")
  publish(await connect(a))
  await rpc(a, "getCustomDomain")
  delivery.mockImplementation(async (_, init) => {
    const body = JSON.parse(String(init?.body))
    return Response.json({ messageId: `<${body.trackingId}@${domain}>`, queued: body.recipients, delivered: [], bounced: [], suppressed: [] })
  })
  const sent = await rpc(a, "send", { to: ["friend@example.net"], text: "Before disconnect", idempotencyKey: "late-bounce" })
  const complaint = await rpc(a, "send", { to: ["complaint@example.net"], text: "Before disconnect", idempotencyKey: "late-complaint" })
  const original = await service.store.inbox(a.inboxId)
  const other = await service.store.inbox(b.inboxId)
  const row = await service.store.message(original.id, sent.messageId)
  const complaintRow = await service.store.message(original.id, complaint.messageId)
  await rpc(a, "disconnectCustomDomain")
  if (transfer) { publish(await connect(b)); await rpc(b, "getCustomDomain") }
  else await expect(service.store.inbox(`ruth@${domain}`)).rejects.toMatchObject({ status: 404 })
  const response = await request("/gateway/delivery", {
    eventId: "late-bounce", trackingId: row.id, messageId: row.wire_id, sender: row.data.from,
    recipient: "friend@example.net", status: "bounced", smtpEnhancedStatusCode: "5.1.1", occurredAt: new Date().toISOString()
  }, gateway.token)
  expect(await response.json()).toEqual({ result: "updated" })
  expect((await service.store.message(original.id, row.wire_id)).delivery?.recipients[0]?.status).toBe("bounced")
  expect(await service.store.suppressedRecipients(original.id, ["friend@example.net"])).toEqual(["friend@example.net"])
  expect(await service.store.suppressedRecipients(other.id, ["friend@example.net"])).toEqual([])

  custom.config.feedbackSigners = ["reports.provider.test"]
  const report = new TextEncoder().encode([
    "From: feedback@reports.provider.test", "To: feedback@mx.test",
    "DKIM-Signature: v=1; d=reports.provider.test; s=test; h=from:content-type; b=fixture; bh=fixture", "MIME-Version: 1.0",
    'Content-Type: multipart/report; report-type=feedback-report; boundary="arf"', "",
    "--arf", "Content-Type: text/plain", "", "Feedback", "",
    "--arf", "Content-Type: message/feedback-report", "",
    "Feedback-Type: abuse", "User-Agent: Provider/1", "Version: 1",
    `Original-Mail-From: <${complaintRow.data.from}>`, "Original-Rcpt-To: <complaint@example.net>", "",
    "--arf", "Content-Type: message/rfc822", "",
    `From: ${complaintRow.data.from}`, "To: complaint@example.net", `Message-ID: ${complaintRow.wire_id}`, "", "Original", "", "--arf--", "",
  ].join("\r\n"))
  const scan = cleanProtection()
  scan.authentication.signingDomains = ["reports.provider.test"]
  expect(await ingestFeedback(service, report, scan)).toBe("updated")
  expect((await service.store.message(original.id, complaintRow.wire_id)).delivery?.recipients[0]?.status).toBe("complained")
  expect(await service.store.suppressedRecipients(original.id, ["complaint@example.net"])).toEqual(["complaint@example.net"])
  expect(await service.store.suppressedRecipients(other.id, ["complaint@example.net"])).toEqual([])
  if (!transfer) await expect(service.store.inbox(`ruth@${domain}`)).rejects.toMatchObject({ status: 404 })
})
