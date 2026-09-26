import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CustomDomains, decodeTxt, dnsLookup, spfAllows, type GatewayConfig } from "../src/custom-domains.js"
import { gatewayTransport } from "../src/gateway.js"
import { MailService } from "../src/mail-service.js"
import { handleRequest } from "../src/worker.js"
import { fixture, rawMail, config, cleanProtection } from "./support.js"
import { redirectResponse, workersFetch } from "./workers-fetch.js"

const domain = "agents.customer.test"
const gateway: GatewayConfig = {
  url: "https://mx.bezalel.test", hostname: "mx.bezalel.test", ipv4: "192.0.2.50",
  token: "gateway-test-token-".repeat(3), encryptionKey: "a".repeat(64)
}
describe("native custom domains", () => {
  let f: Awaited<ReturnType<typeof fixture>>
  let custom: CustomDomains
  let service: MailService
  let dns: Map<string, string[]>
  const request = vi.fn<typeof fetch>()
  beforeEach(async () => {
    f = await fixture()
    dns = new Map()
    custom = new CustomDomains(f.db, gateway, ["example.com"], async (name, type) => dns.get(`${type}:${name}`) ?? [])
    service = new MailService({ ...f.service, customDomains: custom,
      transport: gatewayTransport(f.service.transport, custom, request) })
    request.mockReset()
  })
  afterEach(async () => { await f.pg.close() })
  async function publish() {
    const info = await custom.create(domain)
    for (const record of info.records) dns.set(`${record.type}:${record.name}`, [record.type === "MX" ? `${record.priority} ${record.value}.` : record.value])
    return info
  }

  it("returns DNS records, stores an encrypted key, and keeps pending domains unusable", async () => {
    const info = await service.execute("createDomain", { domain })
    expect(info).toMatchObject({ status: "PENDING", domain, records: expect.arrayContaining([expect.objectContaining({ type: "MX", value: gateway.hostname })]) })
    const [stored] = await f.db.query<{ credentials: { encryptedKey: string } }>("select credentials from mail.domains where domain = $1", [domain])
    expect(stored!.credentials.encryptedKey).not.toContain("PRIVATE KEY")
    expect(JSON.stringify(await service.execute("listDomains", {}))).not.toContain("encryptedKey")
    await expect(service.execute("createInbox", { username: "agent", domain })).rejects.toMatchObject({ code: "domain_not_ready" })
    expect(f.verifyDomain).not.toHaveBeenCalled()
  })

  it("reports each record and requires proof even when mail records are correct", async () => {
    await publish()
    dns.delete(`TXT:_bezalel.${domain}`)
    const info = await custom.verify(domain)
    expect(info.status).toBe("PENDING")
    expect(info.records.map((record) => record.status)).toEqual(["pending", "verified", "verified", "verified", "verified"])
    await expect(custom.signingKey(domain)).rejects.toMatchObject({ code: "domain_not_ready" })
  })

  it("verifies DNS, creates an inbox, and sends through the gateway with the matching DKIM key", async () => {
    const initial = await publish()
    expect((await service.execute("verifyDomain", { domainId: domain }) as { status: string }).status).toBe("VERIFIED")
    const inbox = await service.execute("createInbox", { username: "agent", domain }) as { inboxId: string }
    request.mockResolvedValue(Response.json({ messageId: "<queued@mx.bezalel.test>", queued: ["reader@example.net"], delivered: [], bounced: [], suppressed: [] }))
    await service.execute("send", { inboxId: inbox.inboxId, to: ["reader@example.net"], text: "Domain canary", idempotencyKey: "custom-send" })
    expect(f.send).not.toHaveBeenCalled()
    const payload = JSON.parse(String(request.mock.calls[0]![1]!.body))
    expect(request.mock.calls[0]![1]?.redirect).toBe("manual")
    expect(payload.dkim.domainName).toBe(domain)
    expect(payload.dkim.privateKey).toContain("BEGIN PRIVATE KEY")
    expect(initial.records.some((record) => record.name.startsWith(payload.dkim.keySelector))).toBe(true)
    await service.execute("send", { inboxId: inbox.inboxId, to: ["reader@example.net"], text: "Domain canary", idempotencyKey: "custom-send" })
    expect(request).toHaveBeenCalledTimes(1)
  })

  it("checks the policy in the DMARC record instead of borrowing a tag from another TXT record", async () => {
    await publish()
    dns.set(`TXT:_dmarc.${domain}`, ["v=DMARC1; p=invalid", "unrelated=value; p=none"])
    expect((await custom.verify(domain)).records[4]!.status).toBe("pending")
    dns.set(`TXT:_dmarc.${domain}`, ["v=DMARC1; p=reject", "unrelated=value; p=none"])
    expect((await custom.verify(domain)).status).toBe("VERIFIED")
  })

  it("keeps managed domains on Cloudflare and rejects custom claims on them", async () => {
    await expect(custom.create("example.com")).rejects.toMatchObject({ code: "invalid_argument" })
    await expect(custom.create("sub.example.com")).rejects.toMatchObject({ code: "invalid_argument" })
    const inbox = await service.execute("createInbox", { username: "agent" }) as { inboxId: string }
    await service.execute("send", { inboxId: inbox.inboxId, to: ["reader@example.net"], text: "Managed inbox", idempotencyKey: "managed" })
    expect(f.send).toHaveBeenCalledOnce()
    expect(request).not.toHaveBeenCalled()
  })

  it("accepts case-insensitive SPF mechanisms and DMARC policies while keeping DKIM values exact", async () => {
    const info = await publish()
    dns.set(`TXT:${domain}`, ["v=spf1 +IP4:192.0.2.50 ~all"])
    dns.set(`TXT:_dmarc.${domain}`, ["v=DMARC1; p=REJECT"])
    expect((await custom.verify(domain)).status).toBe("VERIFIED")
    const dkim = info.records[3]!
    dns.set(`TXT:${dkim.name}`, [dkim.value.replace("k=rsa", "k=RSA")])
    expect((await custom.verify(domain)).records[3]!.status).toBe("pending")
  })

  it("rotates ownership proof and signing keys after removal and cannot revive a deletion with a stale write", async () => {
    const original = await publish()
    await custom.verify(domain)
    await service.execute("deleteDomain", { domainId: domain })
    await f.service.store.saveDomain({ ...original, status: "VERIFIED" })
    expect(await service.execute("listDomains", {})).toEqual([])
    const next = await custom.create(domain)
    expect(next.records[0]!.value).not.toBe(original.records[0]!.value)
    expect(next.records[3]!.value).not.toBe(original.records[3]!.value)
    expect((await custom.verify(domain)).status).toBe("PENDING")
  })

  it("refuses domain removal while inboxes exist and rechecks DNS when the short verification cache expires", async () => {
    await publish()
    await service.execute("createInbox", { username: "agent", domain })
    await expect(service.execute("deleteDomain", { domainId: domain })).rejects.toMatchObject({ code: "domain_in_use" })
    dns.set(`MX:${domain}`, ["10 elsewhere.example.net."])
    await f.db.query("update mail.domains set verified_at = now() - interval '6 minutes'")
    await expect(custom.signingKey(domain)).rejects.toMatchObject({ code: "domain_not_ready" })
  })

  it("does not let a DNS check started before deletion verify a replacement registration", async () => {
    await publish()
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    const slow = new CustomDomains(f.db, gateway, ["example.com"], async (name, type) => {
      const records = dns.get(`${type}:${name}`) ?? []
      entered()
      await blocked
      return records
    })
    const verification = slow.verify(domain).catch((error: unknown) => error)
    await started
    await service.execute("deleteDomain", { domainId: domain })
    const replacement = await custom.create(domain)
    release()
    expect(await verification).toMatchObject({ code: "not_found" })
    expect(await service.execute("listDomains", {})).toEqual([replacement])
    expect(replacement.status).toBe("PENDING")
  })

  it("admits inbound SMTP only for verified, existing, non-test inboxes and deduplicates queue retries", async () => {
    await publish()
    await service.execute("createInbox", { username: "agent", domain })
    const recipient = `agent@${domain}`
    const headers = { authorization: `Bearer ${gateway.token}`, "x-bezalel-recipient": recipient,
      "x-bezalel-protection": JSON.stringify(cleanProtection()) }
    expect((await handleRequest(new Request(`https://worker.test/gateway/recipient?value=${recipient}`), service)).status).toBe(401)
    expect((await handleRequest(new Request(`https://worker.test/gateway/recipient?value=${recipient}`, { headers }), service)).status).toBe(200)
    const lookup = await handleRequest(new Request(`https://worker.test/gateway/recipient?value=missing@${domain}`, { headers }), service)
    expect(await lookup.json()).toEqual({ allowed: false })
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await handleRequest(new Request("https://worker.test/gateway/receive", { method: "POST", headers, body: rawMail() }), service)
      expect(response.status).toBe(200)
    }
    expect(await f.db.query("select * from mail.messages")).toHaveLength(1)
    expect(await f.db.query("select * from mail.outbox")).toHaveLength(1)
    const denied = await handleRequest(new Request("https://worker.test/rpc/listInboxes", { method: "POST", headers, body: "{}" }), service)
    expect(denied.status).toBe(401)
    await service.execute("createInbox", { username: "test", domain }, true)
    const testLookup = await handleRequest(new Request(`https://worker.test/gateway/recipient?value=test@${domain}`, { headers }), service)
    expect(await testLookup.json()).toEqual({ allowed: false })
  })

  it("does not treat an uncertain queue response as permission to send twice", async () => {
    await publish()
    const inbox = await service.execute("createInbox", { username: "agent", domain }) as { inboxId: string }
    request.mockRejectedValue(new Error("timeout"))
    const message = { inboxId: inbox.inboxId, to: ["reader@example.net"], text: "One send", idempotencyKey: "uncertain" }
    await expect(service.execute("send", message)).rejects.toMatchObject({ transient: true })
    await expect(service.execute("send", message)).rejects.toMatchObject({ code: "delivery_uncertain" })
    expect(request).toHaveBeenCalledOnce()
  })
})

it("decodes DNS TXT chunks and fails closed on DNS errors", async () => {
  expect(decodeTxt('"v=DKIM1; p=abc" "def"')).toBe("v=DKIM1; p=abcdef")
  expect(decodeTxt('"a\\032b"')).toBe("a b")
  const lookup = dnsLookup(vi.fn().mockResolvedValue(Response.json({ Status: 2 })))
  await expect(lookup("example.com", "TXT")).rejects.toMatchObject({ code: "dns_unavailable" })
})

it("reads DNS under the Workers fetch rules and does not follow redirects", async () => {
  const answer = vi.fn(workersFetch(async () => Response.json({ Status: 0, Answer: [{ type: 16, data: '"v=spf1 -all"' }] })))
  await expect(dnsLookup(answer)("example.com", "TXT")).resolves.toEqual(["v=spf1 -all"])
  expect(answer.mock.calls[0]![1]?.redirect).toBe("manual")
  await expect(dnsLookup(workersFetch(async () => redirectResponse()))("example.com", "TXT")).rejects.toMatchObject({ code: "dns_unavailable" })
})

it("accepts a merged SPF record but rejects duplicate policies and an IP after all", () => {
  expect(spfAllows(["v=spf1 include:_spf.example.net ip4:192.0.2.50 -all"], gateway.ipv4)).toBe(true)
  expect(spfAllows(["v=spf1 -all ip4:192.0.2.50"], gateway.ipv4)).toBe(false)
  expect(spfAllows(["v=spf1 ip4:192.0.2.50 -all", "v=spf1 -all"], gateway.ipv4)).toBe(false)
})
