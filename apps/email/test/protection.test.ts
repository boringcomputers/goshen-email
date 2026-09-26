import { afterEach, describe, expect, it, vi } from "vitest"
import { MailService } from "../src/mail-service.js"
import { gatewayScanner } from "../src/gateway.js"
import { handleRequest } from "../src/worker.js"
import { signDownload } from "../src/security.js"
import { fixture, rawMail, cleanProtection } from "./support.js"

const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
afterEach(async () => { for (const f of fixtures.splice(0)) await f.pg.close() })
async function setup() {
  const f = await fixture()
  fixtures.push(f)
  const inbox = await f.service.execute("createInbox", { username: "agent" }) as { inboxId: string }
  const stored = await f.service.store.inbox(inbox.inboxId)
  return { ...f, inbox, stored }
}
const held = () => ({ ...cleanProtection(), status: "quarantined" as const, reasons: ["spam" as const],
  spam: { score: 12, threshold: 6 } })
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => { resolve = complete })
  return { promise, resolve }
}

describe("incoming protection", () => {
  it("hides quarantined bodies and previews from every ordinary read until owner release", async () => {
    const f = await setup()
    const received = await f.service.receive(f.inbox.inboxId, rawMail({ html: true }), held())
    const input = { inboxId: f.inbox.inboxId }
    const reads = [
      ["listMessages", { ...input, labels: ["quarantined"] }],
      ["listThreads", { ...input, labels: ["quarantined"] }],
      ["getMessage", { ...input, messageId: received.messageId, includeHtml: true, ownerReview: true }],
      ["getThread", { ...input, threadId: received.threadId, includeBodies: true, ownerReview: true }],
      ["getThread", { ...input, threadId: received.threadId, includeBodies: false }],
    ] as const
    for (const [operation, args] of reads) {
      const result = await f.service.execute(operation, args)
      expect(JSON.stringify(result), operation).not.toContain("Please check invoice")
    }
    const review = await f.service.execute("reviewThread", { ...input, threadId: received.threadId, includeBodies: true })
    expect(review).toMatchObject({ messages: [{ text: expect.stringContaining("Please check invoice"),
      html: expect.stringContaining("<p>"), protection: { status: "quarantined" } }] })
    await f.service.execute("releaseQuarantine", { ...input, messageId: received.messageId, reviewedBy: "owner-a" })
    expect(await f.service.execute("getMessage", { ...input, messageId: received.messageId, includeHtml: true }))
      .toMatchObject({ text: expect.stringContaining("Please check invoice"), html: expect.stringContaining("<p>") })
    expect(JSON.stringify(await f.service.execute("getThread", { ...input, threadId: received.threadId, includeBodies: true })))
      .toContain("Please check invoice")
  })

  it("does not emit an incoming event when a concurrent quarantined copy wins Message-ID deduplication", async () => {
    const f = await setup()
    const waiting = deferred<void>()
    const resume = deferred<void>()
    const commit = f.service.store.commitMessage.bind(f.service.store)
    vi.spyOn(f.service.store, "commitMessage").mockImplementation(commit).mockImplementationOnce(async (...args) => {
      waiting.resolve()
      await resume.promise
      return commit(...args)
    })
    const clean = f.service.receive(f.inbox.inboxId, rawMail(), cleanProtection())
    await waiting.promise
    try {
      const quarantined = await f.service.receive(f.inbox.inboxId, rawMail(), held())
      resume.resolve()
      expect(await clean).toEqual(quarantined)
      expect(await f.db.query("select * from mail.outbox")).toHaveLength(0)
      expect((await f.service.store.message(f.stored.id, quarantined.messageId)).protection?.status).toBe("quarantined")
    } finally { resume.resolve(); await clean }
  })

  it("leases a managed incoming job when scanning starts so later jobs can be processed independently", async () => {
    const f = await setup()
    const started = deferred<void>()
    const scanned = deferred<ReturnType<typeof cleanProtection>>()
    const scanner = vi.fn().mockResolvedValue(cleanProtection()).mockImplementationOnce(() => {
      started.resolve()
      return scanned.promise
    })
    const service = new MailService({ ...f.service, scanner })
    await service.acceptIncoming(f.inbox.inboxId, rawMail({ id: "<first@example.net>" }), "envelope@example.net")
    await service.acceptIncoming(f.inbox.inboxId, rawMail({ id: "<second@example.net>" }), "envelope@example.net")
    const first = service.processIncoming()
    await started.promise
    try {
      await service.processIncoming()
      expect(scanner).toHaveBeenCalledTimes(2)
      expect(await f.db.query("select * from mail.messages")).toHaveLength(1)
    } finally { scanned.resolve(cleanProtection()); await first }
    expect(await f.db.query("select * from mail.messages")).toHaveLength(2)
    expect(await f.db.query("select * from mail.incoming")).toHaveLength(0)
  })

  it("isolates quarantine from normal threads, search, and agent events, then releases exactly once", async () => {
    const f = await setup()
    const received = await f.service.receive(f.inbox.inboxId, rawMail({ attachment: true }), held())
    const input = { inboxId: f.inbox.inboxId }
    expect(await f.service.execute("listMessages", input)).toMatchObject({ messages: [] })
    expect(await f.service.execute("listThreads", input)).toMatchObject({ threads: [] })
    expect(await f.service.execute("searchMessages", { ...input, query: "invoice" })).toMatchObject({ messages: [] })
    expect(await f.db.query("select * from mail.outbox")).toHaveLength(0)
    expect(await f.service.execute("listThreads", { ...input, labels: ["quarantined"] })).toMatchObject({
      threads: [{ threadId: received.threadId, senders: ["customer@example.net"] }],
    })
    const row = await f.service.store.message(f.stored.id, received.messageId)
    await expect(f.service.execute("updateThreadLabels", { ...input, threadId: received.threadId, removeLabels: ["quarantined"] }))
      .rejects.toMatchObject({ code: "quarantine_review_required" })
    await expect(f.service.execute("reply", { ...input, messageId: row.wire_id, text: "Reply", idempotencyKey: "blocked" }))
      .rejects.toMatchObject({ code: "message_quarantined" })
    await expect(f.service.execute("getAttachment", { ...input, messageId: row.wire_id, attachmentId: row.data.attachments[0]!.attachmentId }))
      .rejects.toMatchObject({ code: "message_quarantined" })
    const release = { ...input, messageId: row.wire_id, reviewedBy: "owner-a" }
    expect(await Promise.all([f.service.execute("releaseQuarantine", release), f.service.execute("releaseQuarantine", release)]))
      .toEqual(expect.arrayContaining([true, false]))
    expect(await f.service.execute("listThreads", input)).toMatchObject({ threads: [{ threadId: received.threadId }] })
    const events = await f.db.query<{ payload: unknown }>("select payload from mail.outbox")
    expect(events).toHaveLength(1)
    expect(events[0]!.payload).toMatchObject({ type: "email.received", message: { protection: { status: "released", releasedBy: "owner-a" } } })
    expect(await f.service.execute("getAttachment", { ...input, messageId: row.wire_id, attachmentId: row.data.attachments[0]!.attachmentId }))
      .toHaveProperty("downloadUrl")
  })

  it.each(["infected", "unscannable"] as const)("blocks release and direct signed downloads for %s attachments", async (status) => {
    const f = await setup()
    const protection = { ...held(), antivirus: { status, signatures: ["Test signature"] },
      reasons: [status === "infected" ? "malware" as const : "scan_incomplete" as const] }
    const received = await f.service.receive(f.inbox.inboxId, rawMail({ attachment: true }), protection)
    const row = await f.service.store.message(f.stored.id, received.messageId)
    await expect(f.service.execute("releaseQuarantine", { inboxId: f.inbox.inboxId, messageId: row.wire_id, reviewedBy: "owner-a" }))
      .rejects.toMatchObject({ code: "malware_blocked" })
    const path = `/attachments/${f.stored.id}/${row.id}/${row.data.attachments[0]!.attachmentId}`
    const expires = String(Math.floor(Date.now() / 1000) + 200)
    const signature = signDownload(f.service.config.webhookSecret, path, expires)
    expect((await handleRequest(new Request(`https://mail.example.com${path}?expires=${expires}&signature=${signature}`), f.service)).status).toBe(404)
    expect(await f.db.query("select * from mail.outbox")).toHaveLength(0)
  })

  it("does not join a quarantined reference to a normal conversation", async () => {
    const f = await setup()
    const heldMail = await f.service.receive(f.inbox.inboxId, rawMail(), held())
    const clean = await f.service.receive(f.inbox.inboxId, rawMail({ id: "<clean@example.net>", references: heldMail.messageId }), cleanProtection())
    expect(clean.threadId).not.toBe(heldMail.threadId)
    const forged = new TextEncoder().encode("Authentication-Results: forged; spf=pass; dkim=pass; dmarc=pass\r\n" +
      new TextDecoder().decode(rawMail({ id: "<spoof@example.net>", references: clean.messageId })))
    const spoof = await f.service.receive(f.inbox.inboxId, forged, held())
    expect(spoof.threadId).not.toBe(clean.threadId)
    expect(await f.db.query("select * from mail.outbox")).toHaveLength(1)
  })

  it("retries managed incoming jobs after scanner failure with the original trusted envelope", async () => {
    const f = await setup()
    const scanner = vi.fn().mockRejectedValueOnce(new Error("scanner offline")).mockResolvedValue(cleanProtection())
    const service = new MailService({ ...f.service, scanner })
    await service.acceptIncoming(f.inbox.inboxId, rawMail(), "envelope@example.net")
    await service.processIncoming()
    expect(await f.db.query("select * from mail.messages")).toHaveLength(0)
    expect(await f.db.query("select * from mail.incoming")).toHaveLength(1)
    await f.db.query("update mail.incoming set available_at = now()")
    await service.processIncoming()
    expect(scanner.mock.calls[1]![1]).toEqual({ sender: "envelope@example.net", recipient: f.inbox.inboxId })
    expect(await f.db.query("select * from mail.incoming")).toHaveLength(0)
    expect(await f.db.query("select * from mail.messages")).toHaveLength(1)
    expect(await f.db.query("select * from mail.outbox")).toHaveLength(1)
  })

  it("validates gateway scan results and never manufactures an original sender IP for Cloudflare forwarding", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json(cleanProtection()))
    const scan = gatewayScanner({ url: "https://mx.example.com", token: "test-token" }, request)
    await scan(rawMail(), { sender: "envelope@example.net", recipient: "agent@example.com" })
    const headers = new Headers(request.mock.calls[0]![1]!.headers)
    expect(request.mock.calls[0]![1]?.redirect).toBe("manual")
    expect(headers.get("x-bezalel-ip")).toBeNull()
    expect(headers.get("x-bezalel-sender")).toBe("envelope@example.net")
    request.mockResolvedValueOnce(Response.json({ ...cleanProtection(), antivirus: { status: "infected", signatures: [] } }))
    await expect(scan(rawMail(), { sender: "", recipient: "agent@example.com" })).rejects.toThrow()
    request.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
    await expect(scan(rawMail(), { sender: "", recipient: "agent@example.com" })).rejects.toMatchObject({ code: "scanner_unavailable" })
  })
})
