import { afterEach, describe, expect, it, vi } from "vitest"
import { ingestDelivery } from "../src/delivery.js"
import { consumeDeliveryBatch } from "../src/worker.js"
import { config, fixture } from "./support.js"

const fixtures: Awaited<ReturnType<typeof fixture>>[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.pg.close()
})
async function setup(testing = false) {
  const f = await fixture()
  fixtures.push(f)
  await f.service.execute("createInbox", { username: "agent" }, testing)
  f.send.mockImplementation(async () => ({
    messageId: "provider-1",
    delivered: [],
    queued: ["to@example.net"],
    bounced: [],
    suppressed: [],
  }))
  const request = {
    inboxId: "agent@example.com",
    to: ["to@example.net"],
    cc: ["cc@example.net"],
    bcc: ["hidden@example.net"],
    subject: "Hello",
    text: "Hello",
    idempotencyKey: "send-1",
  }
  await f.service.execute("send", request, testing)
  const inbox = await f.service.store.inbox(request.inboxId)
  const read = () => f.service.store.message(inbox.id, "provider-1")
  return { ...f, request, inbox, read }
}
function event(status = "delivered", recipient = "to@example.net", second = 1) {
  return {
    type: `cf.email.sending.message.${status}`,
    source: {
      type: "email.sending",
      zoneId: config.domains["example.com"],
      domain: "example.com",
    },
    payload: {
      eventId: `${status}-${recipient}-${second}`,
      messageId: "provider-1",
      sender: "agent@example.com",
      recipient,
      terminal: status !== "deferred",
      delivery: { status, provider: "gmail", deliveryTimeMs: 1234 },
      ...(status === "bounced"
        ? { bounce: { reason: "550 User unknown" } }
        : {}),
      ...(status === "complained" ? { complaint: { type: "abuse" } } : {}),
    },
    metadata: {
      accountId: config.accountId,
      eventSchemaVersion: 1,
      eventTimestamp: new Date(Date.now() + second * 1000).toISOString(),
    },
  }
}

describe("delivery outcomes", () => {
  it("stores one initial snapshot for every unique To, Cc and Bcc recipient and replays without another send", async () => {
    const f = await setup()
    expect((await f.read()).delivery?.recipients).toMatchObject([
      { recipient: "to@example.net", status: "queued" },
      { recipient: "cc@example.net", status: "accepted" },
      { recipient: "hidden@example.net", status: "accepted" },
    ])
    await f.service.execute("send", f.request)
    expect(f.send).toHaveBeenCalledTimes(1)
    const outbox = await f.db.query<{ payload: { type: string } }>(
      "select payload from mail.outbox",
    )
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.payload.type).toBe("email.delivery_updated")
  })
  it("deduplicates events, keeps terminal outcomes, and enriches late delivery after a complaint", async () => {
    const f = await setup()
    const delivered = event("delivered")
    await ingestDelivery(f.service.store, config, delivered)
    const before = (await f.read()).delivery
    await ingestDelivery(f.service.store, config, delivered)
    expect((await f.read()).delivery).toEqual(before)
    await ingestDelivery(
      f.service.store,
      config,
      event("deferred", "to@example.net", 10),
    )
    expect((await f.read()).delivery).toEqual(before)
    const complaint = event("complained", "hidden@example.net", 20)
    await ingestDelivery(f.service.store, config, complaint)
    await ingestDelivery(
      f.service.store,
      config,
      event("delivered", "hidden@example.net", 2),
    )
    expect((await f.read()).delivery?.recipients[2]).toMatchObject({
      status: "complained",
      delivered: true,
      deliveryTimeMs: 1234,
      reason: "abuse",
    })
    await ingestDelivery(f.service.store, config, complaint)
    expect((await f.read()).delivery?.version).toBe(4)
  })
  it.each(["bounced", "failed", "rejected"])(
    "does not count stale delivery after %s, in either arrival order",
    async (status) => {
      const f = await setup()
      const delivered = event("delivered", "to@example.net", 1)
      const failure = event(status, "to@example.net", 10)
      await ingestDelivery(f.service.store, config, failure)
      const before = (await f.read()).delivery
      await ingestDelivery(f.service.store, config, delivered)
      expect((await f.read()).delivery).toEqual(before)
      expect((await f.read()).delivery?.recipients[0]).toMatchObject({
        status,
        delivered: false,
      })
      expect((await f.read()).delivery?.recipients[0]).not.toHaveProperty(
        "deliveryTimeMs",
      )

      await ingestDelivery(
        f.service.store,
        config,
        event("delivered", "cc@example.net", 1),
      )
      await ingestDelivery(
        f.service.store,
        config,
        event(status, "cc@example.net", 10),
      )
      const recipient = (await f.read()).delivery?.recipients[1]
      expect(recipient).toMatchObject({ status, delivered: false })
      expect(recipient).not.toHaveProperty("deliveryTimeMs")
      expect(recipient).not.toHaveProperty("deliveryEventAt")
    },
  )

  it.each(["deferred", "bounced", "failed", "rejected", "complained"])(
    "records %s and exposes details in full message and thread reads",
    async (status) => {
      const f = await setup()
      await ingestDelivery(f.service.store, config, event(status))
      const row = await f.read()
      expect(row.delivery?.recipients[0]?.status).toBe(status)
      const message = await f.service.execute("getMessage", {
        inboxId: f.inbox.address,
        messageId: row.wire_id,
      })
      expect(message).toMatchObject({ delivery: row.delivery })
      const thread = await f.service.execute("getThread", {
        inboxId: f.inbox.address,
        threadId: row.thread_id,
        includeBodies: true,
      })
      expect(thread).toMatchObject({ messages: [{ delivery: row.delivery }] })
    },
  )
  it("rejects foreign accounts, zones, senders, recipients and invalid schemas", async () => {
    const f = await setup()
    const samples = [event(), event(), event(), event(), event()]
    samples[0]!.metadata.accountId = "foreign"
    samples[1]!.source.zoneId = "foreign"
    samples[2]!.payload.sender = "other@example.com"
    samples[3]!.payload.recipient = "foreign@example.net"
    samples[4]!.payload.delivery.status = "invented"
    for (const sample of samples)
      expect(await ingestDelivery(f.service.store, config, sample)).toBe(
        "ignored",
      )
    expect((await f.read()).delivery?.version).toBe(1)
  })
  it("serializes concurrent recipients without dropping either outcome", async () => {
    const f = await setup()
    await Promise.all([
      ingestDelivery(f.service.store, config, event("bounced")),
      ingestDelivery(
        f.service.store,
        config,
        event("delivered", "cc@example.net"),
      ),
    ])
    expect((await f.read()).delivery).toMatchObject({
      version: 3,
      recipients: [
        { status: "bounced" },
        { status: "delivered" },
        { status: "accepted" },
      ],
    })
    expect(await f.db.query("select id from mail.outbox")).toHaveLength(3)
  })
  it("updates test mail without creating production events and cascades deletion", async () => {
    const f = await setup(true)
    await ingestDelivery(f.service.store, config, event())
    expect((await f.read()).delivery?.version).toBe(2)
    expect(await f.db.query("select id from mail.outbox")).toHaveLength(0)
    await f.service.store.deleteInbox(f.inbox.address)
    expect(await ingestDelivery(f.service.store, config, event())).toBe(
      "ignored",
    )
    expect(await f.db.query("select id from mail.messages")).toHaveLength(0)
  })
  it("retries a queue event arriving before message storage and acknowledges ignored events individually", async () => {
    const f = await setup()
    const pending = event()
    pending.payload.messageId = "not-stored-yet"
    const messages = [pending, { invalid: true }, event()].map((body) => ({
      body,
      ack: vi.fn(),
      retry: vi.fn(),
    }))
    await consumeDeliveryBatch(
      { messages } as unknown as MessageBatch,
      f.service.store,
      config,
    )
    expect(messages[0]!.retry).toHaveBeenCalledWith({ delaySeconds: 60 })
    expect(messages[0]!.ack).not.toHaveBeenCalled()
    expect(messages[1]!.ack).toHaveBeenCalledOnce()
    expect(messages[2]!.ack).toHaveBeenCalledOnce()
  })
  it("keeps outcome and outbox changes atomic on storage failure", async () => {
    const f = await setup()
    await f.db.query(
      "alter table mail.outbox add constraint fixture_reject check (payload->>'type' <> 'email.delivery_updated') not valid",
    )
    await expect(
      ingestDelivery(f.service.store, config, event()),
    ).rejects.toThrow()
    expect((await f.read()).delivery?.version).toBe(1)
  })
})
