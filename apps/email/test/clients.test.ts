import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi
} from "vitest"
import { handleRequest } from "../src/worker.js"
import { signEvent } from "../src/security.js"
import { config, fixture, rawMail } from "./support.js"

describe("Mailbox credentials for product instances", () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeAll(async () => {
    f = await fixture()
  })
  afterAll(async () => {
    await f.pg.close()
  })
  beforeEach(async () => {
    await f.pg.exec(
      "truncate mail.inboxes, mail.domains, mail.messages, mail.sends, mail.outbox cascade"
    )
    f.send.mockClear()
    f.request.mockClear()
    f.request.mockImplementation(async () => new Response("ok"))
  })
  const request = (path: string, input: unknown, token = config.apiToken) =>
    handleRequest(
      new Request(`https://mail.example.com${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify(input)
      }),
      f.service
    )
  const provision = async (clientId = "ruth-1", dailySendLimit = 250) => {
    const response = await request("/clients/provision", {
      clientId,
      username: clientId,
      displayName: "Ruth",
      dailySendLimit,
      webhookUrl: `https://${clientId}.example.org/eve/v1/email/inbound`
    })
    expect(response.status).toBe(200)
    return ((await response.json()) as any).result
  }
  it("provisions once and returns only that mailbox's credential", async () => {
    const first = await provision()
    expect(first).toMatchObject({
      inboxId: "ruth-1@example.com",
      clientId: "ruth-1"
    })
    expect(first.apiKey).not.toBe(config.apiToken)
    expect(first.webhookSecret).not.toBe(config.webhookSecret)
    expect(await provision()).toEqual(first)
    expect(await f.db.query("select * from mail.inboxes")).toHaveLength(1)
  })
  it("rejects another inbox, admin operations, test mailboxes, and forged keys", async () => {
    const a = await provision("ruth-a")
    const b = await provision("ruth-b")
    expect((await request("/inbox-rpc/getInbox", {}, a.apiKey)).status).toBe(
      200
    )
    for (const operation of [
      "getMessage",
      "listMessages",
      "send",
      "reply",
      "getThread",
      "updateMessageLabels",
      "getAttachment"
    ]) {
      expect(
        (
          await request(
            `/inbox-rpc/${operation}`,
            { inboxId: b.inboxId },
            a.apiKey
          )
        ).status
      ).toBe(403)
    }
    for (const path of [
      "/rpc/listInboxes",
      "/test-rpc/listInboxes",
      "/clients/provision",
      "/clients/rotate",
      "/clients/delete"
    ]) {
      expect((await request(path, {}, a.apiKey)).status).toBe(401)
    }
    expect((await request("/inbox-rpc/createInbox", {}, a.apiKey)).status).toBe(
      403
    )
    expect(
      (await request("/inbox-rpc/releaseQuarantine", {}, a.apiKey)).status
    ).toBe(403)
    expect(
      (await request("/inbox-rpc/getInbox", {}, a.apiKey + "x")).status
    ).toBe(401)
    expect(
      (await request("/inbox-rpc/getInbox", {}, config.apiToken)).status
    ).toBe(401)
  })
  it("rotates and revokes access without changing or reusing the mailbox", async () => {
    const a = await provision()
    const rotated = await request("/clients/rotate", { clientId: a.clientId })
    expect(rotated.status).toBe(200)
    const b = ((await rotated.json()) as any).result
    expect(b.apiKey).not.toBe(a.apiKey)
    expect(b.inboxId).toBe(a.inboxId)
    expect((await request("/inbox-rpc/getInbox", {}, a.apiKey)).status).toBe(
      401
    )
    expect((await request("/inbox-rpc/getInbox", {}, b.apiKey)).status).toBe(
      200
    )
    expect(
      (await request("/clients/delete", { clientId: a.clientId })).status
    ).toBe(200)
    expect((await request("/inbox-rpc/getInbox", {}, b.apiKey)).status).toBe(
      401
    )
    expect(
      (
        await request("/clients/provision", {
          clientId: a.clientId,
          username: a.clientId,
          webhookUrl: "https://ruth.example.org/eve/v1/email/inbound"
        })
      ).status
    ).toBe(410)
  })
  it("enforces the send cap without charging a successful retry twice", async () => {
    const a = await provision("limited", 1)
    const input = {
      to: ["customer@example.net"],
      text: "Hello",
      idempotencyKey: "one"
    }
    const first = await request("/inbox-rpc/send", input, a.apiKey)
    expect(first.status).toBe(200)
    expect((await request("/inbox-rpc/send", input, a.apiKey)).status).toBe(200)
    expect(
      (
        await request(
          "/inbox-rpc/send",
          { ...input, idempotencyKey: "two" },
          a.apiKey
        )
      ).status
    ).toBe(429)
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it("labels one message and leaves its thread siblings unchanged", async () => {
    const a = await provision()
    const first = await f.service.receive(a.inboxId, rawMail())
    const second = await f.service.receive(
      a.inboxId,
      rawMail({ id: "<second@example.net>", references: first.messageId })
    )
    expect(
      (
        await request(
          "/inbox-rpc/updateMessageLabels",
          {
            messageId: first.messageId,
            addLabels: ["agent-handled"],
            removeLabels: ["unread"]
          },
          a.apiKey
        )
      ).status
    ).toBe(200)
    const one = (await f.service.execute("getMessage", {
      inboxId: a.inboxId,
      messageId: first.messageId
    })) as any
    const two = (await f.service.execute("getMessage", {
      inboxId: a.inboxId,
      messageId: second.messageId
    })) as any
    expect(one.labels).toContain("agent-handled")
    expect(one.labels).not.toContain("unread")
    expect(two.labels).toContain("unread")
    expect(
      (
        await request(
          "/inbox-rpc/updateMessageLabels",
          { messageId: first.messageId, removeLabels: ["quarantined"] },
          a.apiKey
        )
      ).status
    ).toBe(403)
  })
  it("delivers signed incoming events to the correct instance and preserves Bezalel delivery", async () => {
    const a = await provision("ruth-a")
    const b = await provision("ruth-b")
    await f.service.execute("createInbox", { username: "bezalel" })
    await f.service.receive(a.inboxId, rawMail())
    await f.service.receive(b.inboxId, rawMail())
    await f.service.receive("bezalel@example.com", rawMail())
    await f.service.flushEvents()
    expect(f.request).toHaveBeenCalledTimes(3)
    for (const [url, options] of f.request.mock.calls) {
      const body = String(options!.body)
      const payload = JSON.parse(body)
      const headers = options!.headers as Record<string, string>
      const client =
        payload.inboxId === a.inboxId
          ? a
          : payload.inboxId === b.inboxId
            ? b
            : undefined
      expect(String(url)).toBe(client?.webhookUrl ?? config.eventsUrl)
      expect(headers["svix-signature"]).toBe(
        signEvent(
          client?.webhookSecret ?? config.webhookSecret,
          headers["svix-id"]!,
          headers["svix-timestamp"]!,
          body
        )
      )
    }
    expect(
      (
        await request(
          "/inbox-rpc/ensureWebhook",
          { url: a.webhookUrl },
          a.apiKey
        )
      ).status
    ).toBe(200)
    expect(
      (
        await request(
          "/inbox-rpc/ensureWebhook",
          { url: b.webhookUrl },
          a.apiKey
        )
      ).status
    ).toBe(422)
  })
  it("drops leased events when their mailbox is deleted before delivery", async () => {
    const a = await provision("retired")
    await f.service.receive(a.inboxId, rawMail())
    const leased = await f.service.store.pendingEvents()
    expect(leased).toHaveLength(1)
    for (let attempt = 0; attempt < 2; attempt++) {
      const removed = await request("/clients/delete", { clientId: a.clientId })
      expect(await removed.json()).toEqual({ result: { deleted: true } })
    }
    const pending = vi
      .spyOn(f.service.store, "pendingEvents")
      .mockResolvedValueOnce(leased)
    try {
      await f.service.flushEvents()
      expect(f.request).not.toHaveBeenCalled()
    } finally {
      pending.mockRestore()
    }
  })
  it("serializes concurrent sends against the same mailbox cap", async () => {
    const a = await provision("concurrent", 1)
    const responses = await Promise.all(
      ["first", "second"].map((idempotencyKey) =>
        request(
          "/inbox-rpc/send",
          { to: ["customer@example.net"], text: "Hello", idempotencyKey },
          a.apiKey
        )
      )
    )
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 429
    ])
    expect(f.send).toHaveBeenCalledTimes(1)
  })
})
