import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { MailService } from "../src/mail-service.js"
import { jevAnalyzer, TriageError, type TriageAnalyzer } from "../src/triage.js"
import { messageTriage, triageResult, type TriageResult } from "../src/triage-contract.js"
import { triageMigrations } from "../src/triage-schema.js"
import { cleanProtection, fixture, rawMail } from "./support.js"
import { redirectResponse, workersFetch } from "./workers-fetch.js"

const response = () => ({ model: "jev-fixture", usage: { input_tokens: 250, output_tokens: 40 }, answers: {
  category: { type: "choice", choice: "billing", confidence: 0.93,
    probabilities: { billing: 0.95, support: 0.01, sales: 0.01, personal: 0.01, notification: 0.01, other: 0.01 } },
  needs_reply: { type: "noul", noul: 0.98 },
  urgency: { type: "score", score: 1.05, confidence: 0.9, probabilities: { "0": 0, "1": 0.95, "2": 0.05, "3": 0 } },
} })
export const sampleTriage = (): TriageResult => ({
  status: "complete", version: 1, model: "jev-fixture", analyzedAt: new Date().toISOString(), durationMs: 12, bodyTruncated: false,
  usage: { inputTokens: 250, outputTokens: 40 },
  category: { value: "billing", confidence: 0.93, probabilities: response().answers.category.probabilities },
  needsReply: { value: true, probability: 0.98 },
  urgency: { value: "normal", score: 1.05, confidence: 0.9, probabilities: response().answers.urgency.probabilities },
})

describe("Jev triage with simulated inference and real message storage", () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeAll(async () => { f = await fixture() })
  afterAll(async () => { await f?.pg.close() })
  const analyzer = () => vi.fn<TriageAnalyzer>().mockResolvedValue(sampleTriage())
  async function inbox(analyze?: TriageAnalyzer) {
    const service = new MailService({ ...f.service, triageAnalyzer: analyze })
    const value = await service.execute("createInbox", { username: `triage-${crypto.randomUUID().slice(0, 8)}` }) as { inboxId: string }
    return { service, inboxId: value.inboxId, row: await service.store.inbox(value.inboxId) }
  }
  async function get(service: MailService, inboxId: string, messageId: string) {
    return await service.execute("getMessage", { inboxId, messageId }) as { triage?: unknown }
  }

  it("sends bounded source text and three independent typed questions in one server-side request", async () => {
    const { service, inboxId, row } = await inbox()
    const received = await service.receive(inboxId, rawMail())
    const message = await service.store.message(row.id, received.messageId)
    message.data.text = "a".repeat(40_000); message.data.html = "private HTML"; message.data.bcc = ["secret@example.net"]
    const request = vi.fn(workersFetch(async () => Response.json(response())))
    const result = await jevAnalyzer("fixture-secret", "jev-test", request)(message)
    expect(triageResult.parse(result)).toMatchObject({ status: "complete", model: "jev-fixture", bodyTruncated: true,
      category: { value: "billing" }, needsReply: { value: true, probability: 0.98 }, urgency: { value: "normal" } })
    expect(request).toHaveBeenCalledTimes(1)
    const [url, init] = request.mock.calls[0]!
    expect(url).toBe("https://api.typesafe.ai/v1/systemone")
    expect(init?.headers).toMatchObject({ authorization: "Bearer fixture-secret" })
    expect(init?.redirect).toBe("manual")
    await expect(jevAnalyzer("fixture-secret", "jev-test", workersFetch(async () => redirectResponse()))(message))
      .rejects.toMatchObject({ code: "provider_rejected", retryable: false })
    const body = JSON.parse(String(init?.body))
    expect(body.model).toBe("jev-test")
    expect(Object.keys(body.questions)).toEqual(["category", "needs_reply", "urgency"])
    expect(body.state.email.text).toHaveLength(32_768)
    expect(body.state.email).not.toHaveProperty("html"); expect(body.state.email).not.toHaveProperty("bcc")
    expect(JSON.stringify(result)).not.toContain("fixture-secret")
  })

  it("preserves uncertain judgments instead of turning them into confident labels", async () => {
    const provider = response(); provider.answers.needs_reply.noul = 0.5; provider.answers.urgency.confidence = 0.3
    const { service, inboxId, row } = await inbox()
    const received = await service.receive(inboxId, rawMail())
    const result = await jevAnalyzer("test", undefined, async () => Response.json(provider))(await service.store.message(row.id, received.messageId))
    expect(result.needsReply).toEqual({ value: null, probability: 0.5 })
    expect(result.urgency.value).toBeNull(); expect(result.urgency.score).toBe(1.05)
  })

  it("rejects malformed answers, oversized responses, and credentials errors without exposing provider bodies", async () => {
    const { service, inboxId, row } = await inbox()
    const received = await service.receive(inboxId, rawMail()), message = await service.store.message(row.id, received.messageId)
    for (const data of [{}, { ...response(), answers: { ...response().answers, needs_reply: { type: "noul", noul: 3 } } },
      { ...response(), answers: { ...response().answers, category: { ...response().answers.category, probabilities: { billing: 1 } } } }]) {
      await expect(jevAnalyzer("secret", undefined, async () => Response.json(data))(message)).rejects.toMatchObject({ code: "invalid_response", retryable: false })
    }
    await expect(jevAnalyzer("secret", undefined, async () => new Response("x".repeat(70_000)))(message)).rejects.toMatchObject({ code: "invalid_response" })
    await expect(jevAnalyzer("secret", undefined, async () => new Response("secret provider detail", { status: 401 }))(message)).rejects.toMatchObject({ message: "provider_rejected", retryable: false })
    await expect(jevAnalyzer("secret", undefined, async () => new Response("", { status: 429, headers: { "retry-after": "120" } }))(message)).rejects.toMatchObject({ code: "provider_unavailable", retryable: true, retryAfter: 120 })
    await expect(jevAnalyzer("secret", undefined, async () => { throw new Error("secret network detail") })(message)).rejects.toMatchObject({ message: "provider_unavailable", retryable: true })
    await expect(jevAnalyzer("secret", undefined, async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("connection lost while reading")) },
    })))(message)).rejects.toMatchObject({ code: "provider_unavailable", retryable: true })
  })

  it("stores pending triage atomically, deduplicates receives, and leaves sending and disabled analysis alone", async () => {
    const analyze = analyzer(), { service, inboxId } = await inbox(analyze)
    const first = await service.receive(inboxId, rawMail())
    expect(await service.receive(inboxId, rawMail())).toEqual(first)
    expect(analyze).not.toHaveBeenCalled()
    expect(await get(service, inboxId, first.messageId)).toHaveProperty("triage.status", "pending")
    await Promise.all([service.processTriage(), service.processTriage()])
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(await get(service, inboxId, first.messageId)).toHaveProperty("triage.status", "complete")
    await service.processTriage(); expect(analyze).toHaveBeenCalledTimes(1)
    const sent = await service.send({ inboxId, to: ["receiver@example.net"], subject: "Hello", text: "Test", idempotencyKey: crypto.randomUUID() })
    expect(await get(service, inboxId, sent.messageId)).not.toHaveProperty("triage")
    const disabled = await inbox(), original = await disabled.service.receive(disabled.inboxId, rawMail())
    await disabled.service.processTriage()
    expect(await get(disabled.service, disabled.inboxId, original.messageId)).not.toHaveProperty("triage")
    for (const sql of triageMigrations) await f.db.query(sql)
    expect(await get(service, inboxId, first.messageId)).toHaveProperty("triage.status", "complete")
  })

  it("never analyzes quarantined mail and makes pending work eligible on owner release", async () => {
    const analyze = analyzer(), { service, inboxId } = await inbox(analyze)
    const protection = { ...cleanProtection(), status: "quarantined" as const, reasons: ["spam" as const] }
    const held = await service.receive(inboxId, rawMail(), protection)
    await service.processTriage(); expect(analyze).not.toHaveBeenCalled()
    expect(await get(service, inboxId, held.messageId)).not.toHaveProperty("triage")
    expect(await service.execute("listThreads", { inboxId, labels: ["quarantined"] })).toMatchObject({ threads: [expect.not.objectContaining({ triage: expect.anything() })] })
    await service.releaseQuarantine({ inboxId, messageId: held.messageId, reviewedBy: "fixture-owner" })
    await service.releaseQuarantine({ inboxId, messageId: held.messageId, reviewedBy: "fixture-owner" })
    await service.processTriage(); expect(analyze).toHaveBeenCalledTimes(1)
    const infected = await service.receive(inboxId, rawMail({ id: "<infected@example.net>" }), {
      ...protection, antivirus: { status: "infected", signatures: ["fixture"] }, reasons: ["malware"],
    })
    await expect(service.releaseQuarantine({ inboxId, messageId: infected.messageId, reviewedBy: "fixture-owner" })).rejects.toMatchObject({ code: "malware_blocked" })
    await service.processTriage(); expect(analyze).toHaveBeenCalledTimes(1)
  })

  it("retries transient failures with backoff and stops after five attempts without affecting mail", async () => {
    const analyze = vi.fn<TriageAnalyzer>().mockRejectedValue(new TriageError("provider_unavailable", true))
    const { service, inboxId, row } = await inbox(analyze), received = await service.receive(inboxId, rawMail())
    for (let attempt = 1; attempt <= 5; attempt++) {
      await service.processTriage()
      expect(analyze).toHaveBeenCalledTimes(attempt)
      const rows = await f.db.query<{ triage: unknown; triage_attempts: number }>("select triage, triage_attempts from mail.messages where inbox_id=$1", [row.id])
      const { triage, triage_attempts } = rows[0]!
      expect(triage_attempts).toBe(attempt)
      expect(messageTriage.parse(triage).status).toBe(attempt === 5 ? "failed" : "pending")
      await service.processTriage(); expect(analyze).toHaveBeenCalledTimes(attempt)
      await f.db.query("update mail.messages set triage_available_at = now() - interval '1 second' where inbox_id=$1", [row.id])
    }
    expect(await get(service, inboxId, received.messageId)).toHaveProperty("text", expect.stringContaining("Please check invoice number 42."))
    await service.processTriage(); expect(analyze).toHaveBeenCalledTimes(5)
  })

  it("can recover a transient outage and immediately terminates permanent failures", async () => {
    const analyze = analyzer().mockRejectedValueOnce(new TriageError("provider_unavailable", true))
    const { service, inboxId, row } = await inbox(analyze), received = await service.receive(inboxId, rawMail())
    await service.processTriage()
    await f.db.query("update mail.messages set triage_available_at = now() - interval '1 second' where inbox_id=$1", [row.id])
    await service.processTriage()
    expect(await get(service, inboxId, received.messageId)).toHaveProperty("triage.status", "complete")
    const failed = await inbox(async () => { throw new TriageError("invalid_response", false) })
    const bad = await failed.service.receive(failed.inboxId, rawMail())
    await failed.service.processTriage()
    expect(await get(failed.service, failed.inboxId, bad.messageId)).toHaveProperty("triage.code", "invalid_response")
  })

  it("does not overwrite a newer lease or restore a deleted inbox", async () => {
    const newer = { ...sampleTriage(), needsReply: { value: false, probability: 0.01 } }
    const a = await inbox(async message => {
      await f.db.query("update mail.messages set triage_lease = $2, triage = $3::jsonb where id=$1", [message.id, crypto.randomUUID(), JSON.stringify(newer)])
      return sampleTriage()
    })
    const received = await a.service.receive(a.inboxId, rawMail()); await a.service.processTriage()
    expect(await get(a.service, a.inboxId, received.messageId)).toHaveProperty("triage.needsReply.value", false)
    const b = await inbox(async () => { await b.service.store.deleteInbox(b.inboxId); return sampleTriage() })
    await b.service.receive(b.inboxId, rawMail()); await b.service.processTriage()
    expect(await f.db.query("select id from mail.messages where inbox_id=$1", [b.row.id])).toEqual([])
  })

  it("reclaims an expired invocation and bounds attempts after repeated crashes", async () => {
    const analyze = analyzer(), { service, inboxId, row } = await inbox(analyze)
    const first = await service.receive(inboxId, rawMail())
    await f.db.query(`update mail.messages set triage_lease = $2, triage_attempts = 1,
      triage_available_at = now() - interval '1 second' where inbox_id=$1`, [row.id, crypto.randomUUID()])
    await service.processTriage()
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(await get(service, inboxId, first.messageId)).toHaveProperty("triage.status", "complete")
    const second = await service.receive(inboxId, rawMail({ id: "<crashed@example.net>" }))
    await f.db.query(`update mail.messages set triage_attempts = 5,
      triage_available_at = now() - interval '1 second' where inbox_id=$1 and wire_id=$2`, [row.id, second.messageId])
    await service.processTriage()
    expect(analyze).toHaveBeenCalledTimes(1)
    expect(await get(service, inboxId, second.messageId)).toHaveProperty("triage.status", "failed")
  })

  it("filters before pagination and clears the thread suggestion when a reply becomes the latest message", async () => {
    const { service, inboxId, row } = await inbox(analyzer())
    const received = []
    for (let i = 0; i < 3; i++) received.push(await service.receive(inboxId, rawMail({ id: `<filter-${i}@example.net>` })))
    await service.processTriage()
    const first = await service.execute("listMessages", { inboxId, category: "billing", needsReply: "yes", urgency: "normal", limit: 2 }) as { messages: unknown[]; nextPageToken?: string }
    expect(first.messages).toHaveLength(2); expect(first.nextPageToken).toBe("2")
    expect(await service.execute("listMessages", { inboxId, category: "billing", needsReply: "yes", limit: 2, pageToken: first.nextPageToken })).toMatchObject({ messages: [expect.anything()] })
    expect(await service.execute("searchMessages", { inboxId, query: "invoice", category: "support" })).toEqual({ messages: [] })
    expect(await service.execute("searchMessages", { inboxId, query: "invoice", category: "billing", urgency: "normal" })).toMatchObject({ messages: [expect.anything(), expect.anything(), expect.anything()] })
    await service.reply({ inboxId, messageId: received[0]!.messageId, text: "We can help.", replyAll: false, idempotencyKey: crypto.randomUUID() })
    expect(await service.execute("getThread", { inboxId, threadId: received[0]!.threadId })).not.toHaveProperty("triage")
    const threads = await service.execute("listThreads", { inboxId, needsReply: "yes" }) as { threads: { threadId: string }[] }
    expect(threads.threads).toHaveLength(2); expect(threads.threads.map(t => t.threadId)).not.toContain(received[0]!.threadId)
    const ambiguous = { ...sampleTriage(), needsReply: { value: null, probability: 0.5 } }
    await f.db.query("update mail.messages set triage=$2::jsonb where inbox_id=$1 and wire_id=$3", [row.id, JSON.stringify(ambiguous), received[1]!.messageId])
    expect(await service.execute("listThreads", { inboxId, needsReply: "uncertain" })).toMatchObject({ threads: [expect.objectContaining({ threadId: received[1]!.threadId })] })
  })
})
