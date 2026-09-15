import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest"
import { MailError, inputs } from "../src/contracts.js"
import { migrate } from "../src/database.js"
import { handleRequest } from "../src/worker.js"
import { signEvent } from "../src/security.js"
import { config, fixture, rawMail } from "./support.js"

describe("Cloudflare mailbox with PostgreSQL", () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeAll(async () => {
    f = await fixture()
  })
  afterAll(async () => {
    await f.pg.close()
  })
  beforeEach(async () => {
    await f.pg.exec(
      "truncate mail.inboxes, mail.domains, mail.messages, mail.sends, mail.incoming, mail.outbox, mail.garbage cascade"
    )
    f.blobs.clear()
    f.send.mockClear()
    f.request.mockClear()
    f.request.mockImplementation(async () => new Response("ok"))
    await f.service.execute("createInbox", { username: "agent" })
  })
  const rpc = async (
    operation: string,
    body: unknown,
    token = config.apiToken
  ) =>
    handleRequest(
      new Request(`https://mail.example.com/rpc/${operation}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      }),
      f.service
    )
  const sendInput = (key = "send-1") =>
    inputs.send.parse({
      inboxId: "agent@example.com",
      to: ["customer@example.net"],
      subject: "Hello",
      text: "A message",
      idempotencyKey: key
    })

  it("sends attachments and keeps downloadable bytes in Sent", async () => {
    const file = { filename: "report.txt", contentType: "text/plain", content: "cmVwb3J0" }
    const response = await rpc("send", { ...sendInput(), attachments: [file] })
    expect(response.status).toBe(200)
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ attachments: [file] }))
    const { result } = await response.json() as any
    const message = await f.service.execute("getMessage", { inboxId: "agent@example.com", messageId: result.messageId }) as any
    expect(message.attachments).toEqual([expect.objectContaining({ filename: "report.txt", size: 6 })])
    const download = await f.service.execute("getAttachment", { inboxId: "agent@example.com", messageId: result.messageId, attachmentId: message.attachments[0].attachmentId }) as any
    const bytes = await handleRequest(new Request(download.downloadUrl), f.service)
    expect(await bytes.text()).toBe("report")
    const replay = await rpc("send", { ...sendInput(), attachments: [file] })
    expect((await replay.json() as any).result.deduplicated).toBe(true)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect((await rpc("send", { ...sendInput(), attachments: [{ ...file, content: "Y2hhbmdlZA==" }] })).status).toBe(409)
  })

  it("rejects malformed and oversized attachments before reserving or sending", async () => {
    const file = { filename: "report.txt", contentType: "text/plain", content: "cmVwb3J0" }
    for (const attachments of [
      [{ ...file, filename: "../report.txt" }], [{ ...file, content: "Zh==" }],
      [{ ...file, contentType: "text/plain\r\nBcc: x" }], Array(11).fill(file),
      [{ ...file, content: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64") }],
      Array(2).fill({ ...file, content: Buffer.alloc(1024 * 1024 + 1).toString("base64") })
    ]) expect((await rpc("send", { ...sendInput(), attachments })).status).toBe(400)
    expect(f.send).not.toHaveBeenCalled()
    expect(await f.db.query("select * from mail.sends")).toHaveLength(0)
  })
  it("accepts the attachment byte limit and cleans sent files on inbox deletion", async () => {
    const file = { filename: "limit.bin", contentType: "application/octet-stream", content: Buffer.alloc(2 * 1024 * 1024).toString("base64") }
    expect((await rpc("send", { ...sendInput(), attachments: [file] })).status).toBe(200)
    expect(f.blobs.size).toBe(1)
    expect(await f.db.query("select * from mail.garbage")).toHaveLength(0)
    await f.service.execute("deleteInbox", { inboxId: "agent@example.com" })
    await f.service.collectGarbage()
    expect(f.blobs.size).toBe(0)
  })
  it("includes attachments in replies without losing the original thread", async () => {
    const original = await f.service.receive("agent@example.com", rawMail())
    const file = { filename: "answer.txt", contentType: "text/plain", content: "cmVwb3J0" }
    const response = await rpc("reply", { inboxId: "agent@example.com", messageId: original.messageId, text: "Here is the report", attachments: [file], idempotencyKey: "reply-with-file" })
    expect(response.status).toBe(200)
    expect((await response.json() as any).result.threadId).toBe(original.threadId)
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ attachments: [file], headers: expect.objectContaining({ "In-Reply-To": "<incoming@example.net>" }) }))
  })

  it("retries storage failures without calling the transport first or exposing storage errors", async () => {
    const put = vi.spyOn(f.objects, "put").mockRejectedValueOnce(new Error("private storage detail"))
    const input = { ...sendInput(), attachments: [{ filename: "report.txt", contentType: "text/plain", content: "cmVwb3J0" }] }
    const failed = await rpc("send", input)
    expect(failed.status).toBe(503)
    expect(await failed.json()).toMatchObject({ error: { code: "attachment_storage_error", transient: false } })
    expect(f.send).not.toHaveBeenCalled()
    expect((await rpc("send", input)).status).toBe(200)
    expect(f.send).toHaveBeenCalledTimes(1)
    put.mockRestore()
  })

  it("requires authentication before mailbox access", async () => {
    expect((await rpc("listInboxes", {}, "wrong")).status).toBe(401)
    expect((await rpc("send", sendInput(), "wrong")).status).toBe(401)
    expect(f.send).not.toHaveBeenCalled()
    expect(
      ((await (await rpc("listInboxes", {})).json()) as any).result.inboxes
    ).toHaveLength(1)
  })
  it("validates requests without echoing private input", async () => {
    const response = await rpc("send", {
      ...sendInput(),
      to: ["invalid-secret"]
    })
    expect(response.status).toBe(400)
    expect(await response.text()).not.toContain("invalid-secret")
    expect(
      (await rpc("send", { ...sendInput(), text: "bad\0text" })).status
    ).toBe(400)
    expect(f.send).not.toHaveBeenCalled()
  })
  it("creates many inboxes without a provider quota", async () => {
    for (let i = 0; i < 5; i++)
      await f.service.execute("createInbox", { username: `agent${i}` })
    expect(await f.service.execute("inboxQuota", {})).toEqual({
      count: 6,
      limit: null
    })
  })
  it("stores parsed mail and emits one durable event across redeliveries", async () => {
    const first = await f.service.receive(
      "agent@example.com",
      rawMail({ html: true, attachment: true })
    )
    expect(
      await f.service.receive(
        "agent@example.com",
        rawMail({ html: true, attachment: true })
      )
    ).toEqual(first)
    const message = (await f.service.execute("getMessage", {
      inboxId: "agent@example.com",
      messageId: first.messageId
    })) as any
    expect(message.text).toContain("invoice number 42")
    expect(message.html).toBeUndefined()
    expect(message.attachments[0]).toMatchObject({
      filename: "invoice.txt",
      size: 10
    })
    expect(JSON.stringify(message)).not.toContain("objectKey")
    expect(await f.db.query("select * from mail.messages")).toHaveLength(1)
    expect(await f.db.query("select * from mail.outbox")).toHaveLength(1)
    await f.service.flushEvents()
    const [url, options] = f.request.mock.calls[0]!
    expect(String(url)).toBe(config.eventsUrl)
    const headers = options!.headers as Record<string, string>
    expect(headers["svix-signature"]).toBe(
      signEvent(
        config.webhookSecret,
        headers["svix-id"]!,
        headers["svix-timestamp"]!,
        options!.body as string
      )
    )
    expect(JSON.parse(options!.body as string)).toMatchObject({
      type: "email.received",
      inboxId: "agent@example.com"
    })
    expect(options!.body).not.toContain("<p>")
  })
  it("makes HTML-only mail readable and searchable without exposing HTML by default", async () => {
    const received = await f.service.receive(
      "agent@example.com",
      new TextEncoder().encode(
        [
          "From: customer@example.net",
          "To: agent@example.com",
          "Message-ID: <html-only@example.net>",
          "Subject: HTML message",
          "Content-Type: text/html; charset=utf-8",
          "",
          "<p>Your <b>invoice</b> &amp; receipt</p><script>secretScript()</script>"
        ].join("\r\n")
      )
    )
    const message = (await f.service.execute("getMessage", {
      inboxId: "agent@example.com",
      messageId: received.messageId
    })) as any
    expect(message.text).toBe("Your invoice & receipt")
    expect(message.html).toBeUndefined()
    expect(
      (
        (await f.service.execute("searchMessages", {
          inboxId: "agent@example.com",
          query: "invoice"
        })) as any
      ).messages
    ).toHaveLength(1)
    await f.service.flushEvents()
    expect(
      JSON.parse(f.request.mock.calls[0]![1]!.body as string).message.text
    ).toBe(message.text)
    const sent = await f.service.send({
      ...sendInput(),
      text: undefined,
      html: "<p>Thank you</p>"
    })
    expect(
      (
        (await f.service.execute("getMessage", {
          inboxId: "agent@example.com",
          messageId: sent.messageId
        })) as any
      ).text
    ).toBe("Thank you")
  })
  const largeMail = () => {
    const text = Array.from({ length: 120000 }, (_, i) => `word${i}`).join(
      " "
    )
    const raw = new TextEncoder().encode(
      [
        "From: customer@example.net",
        "To: agent@example.com",
        "Message-ID: <large@example.net>",
        "Content-Type: text/plain; charset=utf-8",
        "",
        text
      ].join("\r\n")
    )
    return { text, raw }
  }
  it("stores large message bodies without exceeding PostgreSQL's search-index limit", async () => {
    const { text, raw } = largeMail()
    const received = await f.service.receive("agent@example.com", raw)
    const stored = (await f.service.execute("getMessage", {
      inboxId: "agent@example.com",
      messageId: received.messageId
    })) as any
    expect(stored.text.trimEnd()).toBe(text)
    expect(
      (
        (await f.service.execute("searchMessages", {
          inboxId: "agent@example.com",
          query: "word42"
        })) as any
      ).messages
    ).toHaveLength(1)
  })
  it("upgrades existing unbounded search columns without losing mail and can rerun", async () => {
    const original = await f.service.receive(
      "agent@example.com",
      rawMail()
    )
    await f.pg.exec(`
      drop table mail.schema_migrations;
      drop index mail.mail_messages_search;
      alter table mail.messages drop column search;
      alter table mail.messages add column search tsvector generated always as (to_tsvector('simple', coalesce(data->>'text', ''))) stored;
      create index mail_messages_search on mail.messages using gin(search);
    `)
    const { text, raw } = largeMail()
    await expect(
      f.service.receive("agent@example.com", raw)
    ).rejects.toMatchObject({ code: "54000" })
    await migrate(f.db)
    await migrate(f.db)
    expect(
      (
        (await f.service.execute("getMessage", {
          inboxId: "agent@example.com",
          messageId: original.messageId
        })) as any
      ).text
    ).toContain("invoice number 42")
    const received = await f.service.receive("agent@example.com", raw)
    expect(
      (
        (await f.service.execute("getMessage", {
          inboxId: "agent@example.com",
          messageId: received.messageId
        })) as any
      ).text.trimEnd()
    ).toBe(text)
    expect(
      (
        (await f.service.execute("searchMessages", {
          inboxId: "agent@example.com",
          query: "word42"
        })) as any
      ).messages
    ).toHaveLength(1)
    expect(
      await f.db.query(
        "select 1 from pg_indexes where schemaname = 'mail' and indexname = 'mail_messages_search'"
      )
    ).toHaveLength(1)
  })
  it("keeps incoming mail durable until processing succeeds", async () => {
    await f.service.acceptIncoming("agent@example.com", rawMail())
    expect(await f.db.query("select * from mail.messages")).toHaveLength(0)
    expect(await f.db.query("select * from mail.incoming")).toHaveLength(1)
    await f.service.processIncoming()
    expect(await f.db.query("select * from mail.messages")).toHaveLength(1)
    expect(await f.db.query("select * from mail.incoming")).toHaveLength(0)
    expect(await f.db.query("select * from mail.outbox")).toHaveLength(1)
  })
  it("keeps failed event deliveries queued with stable identity", async () => {
    await f.service.receive("agent@example.com", rawMail())
    f.request.mockResolvedValueOnce(new Response("down", { status: 503 }))
    await f.service.flushEvents()
    expect(
      (await f.db.query("select delivered_at from mail.outbox"))[0]
        ?.delivered_at
    ).toBeNull()
    await f.db.query("update mail.outbox set available_at = now()")
    await f.service.flushEvents()
    const ids = f.request.mock.calls.map(
      (call) => (call[1]!.headers as Record<string, string>)["svix-id"]
    )
    expect(ids[0]).toBe(ids[1])
    expect(
      (await f.db.query("select delivered_at from mail.outbox"))[0]
        ?.delivered_at
    ).not.toBeNull()
  })
  it("retries raw MIME cleanup after an object deletion failure", async () => {
    await f.service.acceptIncoming("agent@example.com", rawMail())
    const [job] = await f.db.query<{ object_key: string }>(
      "select object_key from mail.incoming"
    )
    await f.service.processIncoming()
    expect(await f.db.query("select * from mail.incoming")).toHaveLength(0)
    expect(
      await f.db.query("select * from mail.garbage where prefix = $1", [
        job!.object_key
      ])
    ).toHaveLength(1)
    const deletion = vi
      .spyOn(f.objects, "delete")
      .mockRejectedValueOnce(new Error("R2 unavailable"))
    try {
      await expect(f.service.collectGarbage()).rejects.toThrow(
        "R2 unavailable"
      )
      expect(f.blobs.has(job!.object_key)).toBe(true)
      expect(
        await f.db.query("select * from mail.garbage where prefix = $1", [
          job!.object_key
        ])
      ).toHaveLength(1)
      await f.service.collectGarbage()
      expect(f.blobs.has(job!.object_key)).toBe(false)
      expect(
        await f.db.query("select * from mail.garbage where prefix = $1", [
          job!.object_key
        ])
      ).toHaveLength(0)
    } finally {
      deletion.mockRestore()
    }
  })
  it("keeps raw cleanup separate from a redelivered incoming job", async () => {
    await f.service.acceptIncoming("agent@example.com", rawMail())
    await f.service.processIncoming()
    await f.service.acceptIncoming("agent@example.com", rawMail())
    await f.service.collectGarbage()
    await f.service.processIncoming()
    await f.service.collectGarbage()
    expect(await f.db.query("select * from mail.messages")).toHaveLength(1)
    expect(await f.db.query("select * from mail.outbox")).toHaveLength(1)
    expect(await f.db.query("select * from mail.incoming")).toHaveLength(0)
    expect(
      [...f.blobs.keys()].filter((key) => key.includes("/incoming/"))
    ).toHaveLength(0)
  })
  it("deduplicates sends and rejects conflicting use of a key", async () => {
    const first = await f.service.send(sendInput())
    expect(await f.service.send(sendInput())).toEqual({
      ...first,
      deduplicated: true
    })
    expect(f.send).toHaveBeenCalledTimes(1)
    await expect(
      f.service.send({ ...sendInput(), text: "different" })
    ).rejects.toMatchObject({ code: "idempotency_conflict" })
    expect(f.send).toHaveBeenCalledTimes(1)
    const stored = (await f.service.execute("getMessage", {
      inboxId: "agent@example.com",
      messageId: first.messageId
    })) as any
    expect(stored.labels).toContain("sent")
  })
  it("never repeats an uncertain outbound request", async () => {
    f.send.mockRejectedValueOnce(
      new MailError("Timeout", "delivery_uncertain", 502, true)
    )
    await expect(f.service.send(sendInput())).rejects.toMatchObject({
      transient: true
    })
    await expect(f.service.send(sendInput())).rejects.toMatchObject({
      code: "delivery_uncertain",
      transient: true
    })
    expect(f.send).toHaveBeenCalledTimes(1)
    await expect(
      f.service.execute("deleteInbox", { inboxId: "agent@example.com" })
    ).rejects.toMatchObject({ code: "send_pending" })
  })
  it("replays a definite rejection without sending again", async () => {
    f.send.mockRejectedValueOnce(
      new MailError("Invalid send", "provider_error", 400)
    )
    await expect(f.service.send(sendInput())).rejects.toMatchObject({
      code: "provider_error"
    })
    await expect(f.service.send(sendInput())).rejects.toMatchObject({
      code: "provider_error"
    })
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it("retries a rate-limited send with the same key and preserves conflict checks", async () => {
    f.send.mockRejectedValueOnce(
      new MailError("Quota", "rate_limited", 429)
    )
    await expect(f.service.send(sendInput())).rejects.toMatchObject({
      code: "rate_limited",
      transient: false
    })
    await expect(
      f.service.send({ ...sendInput(), text: "different" })
    ).rejects.toMatchObject({ code: "idempotency_conflict" })
    const retry = await f.service.send(sendInput())
    expect(await f.service.send(sendInput())).toEqual({
      ...retry,
      deduplicated: true
    })
    expect(f.send).toHaveBeenCalledTimes(2)
    expect(await f.db.query("select * from mail.messages")).toHaveLength(1)
  })
  it("blocks concurrent retries and deletion while a send is in flight", async () => {
    let finish: (() => void) | undefined
    f.send.mockImplementationOnce(async (input) => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return {
        messageId: "<concurrent@cloudflare.net>",
        delivered: input.to,
        queued: [],
        bounced: [],
        suppressed: []
      }
    })
    const first = f.service.send(sendInput())
    await vi.waitFor(() => expect(finish).toBeDefined())
    await expect(f.service.send(sendInput())).rejects.toMatchObject({
      code: "delivery_uncertain"
    })
    await expect(
      f.service.execute("deleteInbox", { inboxId: "agent@example.com" })
    ).rejects.toMatchObject({ code: "send_pending" })
    finish!()
    const receipt = await first
    expect(await f.service.send(sendInput())).toEqual({
      ...receipt,
      deduplicated: true
    })
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it("keeps raw mail queued when object storage is temporarily unavailable", async () => {
    await f.service.acceptIncoming("agent@example.com", rawMail())
    const get = vi.spyOn(f.objects, "get").mockResolvedValueOnce(null)
    await f.service.processIncoming()
    expect(await f.db.query("select * from mail.incoming")).toHaveLength(1)
    expect(await f.db.query("select * from mail.messages")).toHaveLength(0)
    get.mockRestore()
    await f.db.query("update mail.incoming set available_at = now()")
    await f.service.processIncoming()
    expect(await f.db.query("select * from mail.incoming")).toHaveLength(0)
    expect(await f.db.query("select * from mail.messages")).toHaveLength(1)
  })
  it("normalizes NUL characters before storing MIME text in PostgreSQL", async () => {
    const raw = new TextDecoder()
      .decode(rawMail())
      .replace("number 42", "number \0 42")
    const received = await f.service.receive(
      "agent@example.com",
      new TextEncoder().encode(raw)
    )
    const message = (await f.service.execute("getMessage", {
      inboxId: "agent@example.com",
      messageId: received.messageId
    })) as any
    expect(message.text).not.toContain("\0")
    expect(message.text).toContain("42")
  })
  it("isolates threads and message lookups by inbox", async () => {
    await f.service.execute("createInbox", { username: "other" })
    const first = await f.service.receive("agent@example.com", rawMail())
    const second = await f.service.receive(
      "agent@example.com",
      rawMail({ id: "<reply@example.net>", references: first.messageId })
    )
    expect(second.threadId).toBe(first.threadId)
    const other = await f.service.receive(
      "other@example.com",
      rawMail({ id: "<other@example.net>", references: first.messageId })
    )
    expect(other.threadId).not.toBe(first.threadId)
    await expect(
      f.service.execute("getMessage", {
        inboxId: "other@example.com",
        messageId: first.messageId
      })
    ).rejects.toMatchObject({ code: "not_found" })
    await expect(
      f.service.execute("getThread", {
        inboxId: "other@example.com",
        threadId: first.threadId
      })
    ).rejects.toMatchObject({ code: "not_found" })
  })
  it("replies to Reply-To with correct threading and excludes BCC from reply-all", async () => {
    const received = await f.service.receive(
      "agent@example.com",
      rawMail()
    )
    const result = await f.service.reply(
      inputs.reply.parse({
        inboxId: "agent@example.com",
        messageId: received.messageId,
        replyAll: true,
        text: "Done",
        idempotencyKey: "reply-1"
      })
    )
    expect(result.threadId).toBe(received.threadId)
    expect(f.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["support@example.net"],
        cc: ["colleague@example.net"],
        bcc: [],
        headers: expect.objectContaining({
          "In-Reply-To": received.messageId,
          References: received.messageId
        })
      })
    )
    const followup = await f.service.receive(
      "agent@example.com",
      rawMail({
        id: "<followup@example.net>",
        references: result.messageId
      })
    )
    expect(followup.threadId).toBe(result.threadId)
  })
  it("sends exactly the reviewed reply recipients and files while retaining thread headers", async () => {
    const received = await f.service.receive("agent@example.com", rawMail({ attachment: true }))
    const message = await f.service.execute("getMessage", { inboxId: "agent@example.com", messageId: received.messageId }) as any
    expect(message.replyTo).toEqual(["support@example.net"])
    const request = { inboxId: "agent@example.com", messageId: received.messageId, replyAll: true, to: ["reviewed@example.net"], cc: [], bcc: ["owner@example.net"], text: "Approved", attachments: [], idempotencyKey: "reviewed-reply" }
    const result = await rpc("reply", request)
    expect(result.status).toBe(200)
    expect((await result.json() as any).result.threadId).toBe(received.threadId)
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ to: request.to, cc: [], bcc: request.bcc, headers: expect.objectContaining({ "In-Reply-To": received.messageId }) }))
    expect(f.send.mock.calls[0]?.[0].attachments ?? []).toEqual([])
    expect((await rpc("reply", request)).status).toBe(200)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect((await rpc("reply", { ...request, to: ["changed@example.net"] })).status).toBe(409)
  })
  it("rejects reviewed replies exceeding the combined recipient limit before transport", async () => {
    const received = await f.service.receive("agent@example.com", rawMail())
    const result = await rpc("reply", { inboxId: "agent@example.com", messageId: received.messageId, to: Array.from({ length: 50 }, (_, i) => `r${i}@example.net`), cc: ["extra@example.net"], text: "Reply", idempotencyKey: "over-cap" })
    expect(result.status).toBe(422)
    expect(f.send).not.toHaveBeenCalled()
  })
  it("supports labels, trash filtering, full-text search and pagination", async () => {
    const invoice = await f.service.receive("agent@example.com", rawMail())
    await f.service.receive(
      "agent@example.com",
      rawMail({ id: "<second@example.net>", subject: "Lunch plans" })
    )
    const page = (await f.service.execute("listMessages", {
      inboxId: "agent@example.com",
      limit: 1
    })) as any
    expect(page.messages).toHaveLength(1)
    const next = (await f.service.execute("listMessages", {
      inboxId: "agent@example.com",
      limit: 1,
      pageToken: page.nextPageToken
    })) as any
    expect(next.messages[0].messageId).not.toBe(page.messages[0].messageId)
    const search = (await f.service.execute("searchMessages", {
      inboxId: "agent@example.com",
      query: "Lunch"
    })) as any
    expect(search.messages).toHaveLength(1)
    await f.service.execute("updateThreadLabels", {
      inboxId: "agent@example.com",
      threadId: invoice.threadId,
      addLabels: ["trash"],
      removeLabels: ["unread"]
    })
    expect(
      (
        (await f.service.execute("listThreads", {
          inboxId: "agent@example.com"
        })) as any
      ).threads
    ).toHaveLength(1)
    expect(
      (
        (await f.service.execute("listThreads", {
          inboxId: "agent@example.com",
          includeTrash: true
        })) as any
      ).threads
    ).toHaveLength(2)
    const read = (await f.service.execute("getThread", {
      inboxId: "agent@example.com",
      threadId: invoice.threadId
    })) as any
    expect(read.labels).not.toContain("unread")
    expect(read.messages[0].text).toBeUndefined()
  })
  it("signs attachment downloads and revokes them when an inbox is deleted", async () => {
    const received = await f.service.receive(
      "agent@example.com",
      rawMail({ attachment: true })
    )
    const message = (await f.service.execute("getMessage", {
      inboxId: "agent@example.com",
      messageId: received.messageId
    })) as any
    const link = (await f.service.execute("getAttachment", {
      inboxId: "agent@example.com",
      messageId: received.messageId,
      attachmentId: message.attachments[0].attachmentId
    })) as any
    const response = await handleRequest(
      new Request(link.downloadUrl),
      f.service
    )
    expect(await response.text()).toBe("Invoice 42")
    expect(response.headers.get("content-disposition")).toContain(
      "attachment;"
    )
    expect(
      (
        await handleRequest(
          new Request(
            link.downloadUrl.replace("signature=", "signature=bad")
          ),
          f.service
        )
      ).status
    ).toBe(401)
    await f.service.execute("deleteInbox", {
      inboxId: "agent@example.com"
    })
    expect(
      (await handleRequest(new Request(link.downloadUrl), f.service))
        .status
    ).toBe(404)
    await f.service.collectGarbage()
    expect(f.blobs.size).toBe(0)
    await expect(
      f.service.execute("createInbox", { username: "agent" })
    ).rejects.toMatchObject({ code: "inbox_conflict" })
    expect(
      await f.service.execute("deleteInbox", {
        inboxId: "agent@example.com"
      })
    ).toBe(false)
  })
  it("prevents webhook redirection", async () => {
    expect(
      await f.service.execute("ensureWebhook", { url: config.eventsUrl })
    ).toMatchObject({
      secret: config.webhookSecret,
      status: { configured: true }
    })
    await expect(
      f.service.execute("ensureWebhook", {
        url: "https://attacker.example/hook"
      })
    ).rejects.toMatchObject({ code: "webhook_url_mismatch" })
    expect(
      JSON.stringify(await f.service.execute("webhookStatus", {}))
    ).not.toContain(config.webhookSecret)
  })
  it("keeps webhook events queued when the destination redirects", async () => {
    await f.service.receive("agent@example.com", rawMail({}))
    f.request.mockResolvedValue(new Response(null, {
      status: 307,
      headers: { location: "https://attacker.example/collect" }
    }))
    await f.service.flushEvents()
    expect(f.request).toHaveBeenCalledTimes(1)
    expect(f.request.mock.calls[0]![1]?.redirect).toBe("manual")
    expect(await f.db.query("select delivered_at, attempts from mail.outbox"))
      .toEqual([{ delivered_at: null, attempts: 1 }])
  })
})
