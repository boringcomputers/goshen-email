import { readFile } from "node:fs/promises"
import { URL } from "node:url"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { GoshenEmailClient } from "@goshenemail/client"
import { run } from "goshenemail-cli"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { apiScopes, manageApiKeys } from "../src/api-keys.js"
import { allocatedFeatures, autumnBilling, billingFeatures, billingPlans } from "../src/billing.js"
import { MailError } from "../src/contracts.js"
import { executeCustomerRequest } from "../src/customer-api.js"
import { CustomerStore, type Customer } from "../src/customer-store.js"
import { developerOperations } from "../src/developer-contract.js"
import { mailboxCredentials } from "../src/mail-clients.js"
import { MailService } from "../src/mail-service.js"
import { Metering } from "../src/metering.js"
import { pricingPlans, topUpPrice, type PlanView } from "../src/pricing.js"
import { handleRequest } from "../src/worker.js"
import { fakeAutumn } from "./autumn-fixture.js"
import { cleanProtection, fixture, rawMail } from "./support.js"
import { fixtureTriage } from "./triage-fixture.js"
import { redirectResponse, workersFetch } from "./workers-fetch.js"

const admin = "owner@example.net"

describe("plan limits through Autumn", () => {
  let f: Awaited<ReturnType<typeof fixture>>, autumn: ReturnType<typeof fakeAutumn>, service: MailService, store: CustomerStore
  beforeAll(async () => {
    f = await fixture()
    autumn = fakeAutumn()
    service = new MailService({ ...f.service, triageAnalyzer: fixtureTriage, metering: new Metering(autumnBilling("am_sk_test_fixture", autumn.request), [admin]) })
    store = new CustomerStore(f.db, [admin])
  })
  afterAll(async () => { await f?.pg.close() })
  const request: typeof fetch = async (input, init) => handleRequest(new Request(input, init), service)
  async function account(email = `${crypto.randomUUID()}@example.net`) {
    const { customer } = await store.invite({ email, inboxLimit: null })
    const key = await manageApiKeys(f.db, customer, "createApiKey", { name: "Agent", scopes: apiScopes }) as { apiKey: string }
    return { customer, key: key.apiKey, client: new GoshenEmailClient({ apiKey: key.apiKey, baseUrl: service.config.publicUrl, fetch: request }) }
  }
  const dashboard = async (customer: Customer, operation: string, body: unknown = {}) => {
    const response = await executeCustomerRequest(new Request("https://dashboard.test/rpc", { method: "POST", body: JSON.stringify(body) }), service, store, customer, operation)
    return ((await response.json()) as { result: unknown }).result
  }
  const name = () => "agent-" + crypto.randomUUID().slice(0, 8)
  const reservations = async (address: string) => (await f.db.query<{ n: number }>(
    "select count(*)::int as n from mail.sends s join mail.inboxes i on i.id = s.inbox_id where i.address = $1", [address]))[0]!.n

  it("keeps the Autumn config, the Worker's feature ids, and the plan catalog in step", async () => {
    const config = await readFile(new URL("../../../ops/autumn/autumn.config.ts", import.meta.url), "utf8")
    const featureIds = [...config.matchAll(/featureId: "([a-z_]+)"/g)].map(m => m[1]).sort()
    const planIds = [...config.matchAll(/planId: "([a-z_]+)"/g)].map(m => m[1]).sort()
    expect(featureIds).toEqual(Object.values(billingFeatures).sort())
    expect(planIds).toEqual([...billingPlans].sort())
    expect(pricingPlans.map(p => p.planId)).toEqual([...billingPlans])
    const variables: Record<keyof PlanView["included"], string> = { inboxes: "inboxes", sends: "sends", triage: "triage", customDomains: "customDomains", storageMb: "storage", seats: "seats" }
    for (const plan of pricingPlans) {
      const block = config.slice(config.indexOf(`planId: "${plan.planId}"`), config.indexOf("})", config.indexOf(`planId: "${plan.planId}"`)))
      expect(block, plan.planId).toContain(`name: "${plan.name}"`)
      if (plan.price) expect(block, plan.planId).toContain(`price: { amount: ${plan.price}, interval: "month" }`)
      else expect(block, plan.planId).not.toMatch(/\bprice: \{ amount/)
      for (const [feature, variable] of Object.entries(variables) as [keyof PlanView["included"], string][]) {
        const included = plan.included[feature]
        const item = new RegExp(`featureId: ${variable}\\.featureId, included: ([0-9_]+)`).exec(block)
        expect(item ? Number(item[1]!.replaceAll("_", "")) : 0, `${plan.planId} ${feature}`).toBe(included)
        const topUp = new RegExp(`featureId: ${variable}\\.featureId, included: [0-9_]+(, reset: monthly)?, price: topUp\\(`).test(block)
        expect(topUp, `${plan.planId} ${feature} top-up`).toBe(plan.topUps && ["inboxes", "sends", "triage", "customDomains"].includes(feature))
      }
    }
    expect(config).toContain(`amount: ${topUpPrice}, billingUnits`)
    // Autumn only locks consumable balances, so the Worker's allocated set must mirror the config's consumable flags.
    const consumable = Object.fromEntries([...config.matchAll(/featureId: "([a-z_]+)", name: "[^"]+", type: "metered", consumable: (true|false)/g)].map(m => [m[1], m[2] === "true"]))
    expect(Object.keys(consumable).sort()).toEqual(Object.values(billingFeatures).sort())
    for (const [feature, isConsumable] of Object.entries(consumable)) expect(allocatedFeatures.has(feature as never), feature).toBe(!isConsumable)
  })

  it("lets exactly one of two simultaneous inbox creations through on the last unit", async () => {
    const a = await account()
    await a.client.account.usage()
    autumn.grant(a.customer.id, "inboxes", 1)
    // Both requests see zero inboxes before either commits. Without the account lock the second would
    // read Autumn's usage as one too many, refund the first request's unit, and both would provision.
    const results = await Promise.allSettled(["left", "right"].map(suffix => a.client.inboxes.create({ username: `${name()}-${suffix}` })))
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1)
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { status: 402, code: "billing_limit" } })
    expect((await a.client.inboxes.list()).inboxes).toHaveLength(1)
    expect(autumn.usage(a.customer.id, "inboxes")).toBe(1)
    // Reading usage at the same time as a creation cannot refund the unit either.
    autumn.grant(a.customer.id, "inboxes", 2)
    const [created, usage] = await Promise.all([a.client.inboxes.create({ username: name() }), a.client.account.usage()])
    expect(created).toHaveProperty("inboxId")
    expect(usage.inboxes.count).toBe(usage.features.find(feature => feature.feature === "inboxes")!.used)
    expect(autumn.usage(a.customer.id, "inboxes")).toBe(2)
    expect((await a.client.inboxes.list()).inboxes).toHaveLength(2)
  })

  it("charges one unit when the same username is created twice at once, and keeps deletes in step with creates", async () => {
    const a = await account()
    await a.client.account.usage()
    autumn.grant(a.customer.id, "inboxes", 5)
    const username = name()
    const same = await Promise.all([1, 2].map(() => a.client.inboxes.create({ username })))
    expect(same[0]!.inboxId).toBe(same[1]!.inboxId)
    expect(autumn.usage(a.customer.id, "inboxes")).toBe(1)
    // A delete racing a create: whichever order the lock gives them, Autumn ends at the database count.
    const second = await a.client.inboxes.create({ username: name() })
    expect(autumn.usage(a.customer.id, "inboxes")).toBe(2)
    const [deleted] = await Promise.all([a.client.inboxes.delete({ inboxId: second.inboxId }), a.client.inboxes.create({ username: name() })])
    expect(deleted).toEqual({ deleted: true })
    const inboxes = (await a.client.inboxes.list()).inboxes
    expect(inboxes).toHaveLength(2)
    expect(autumn.usage(a.customer.id, "inboxes")).toBe(2)
    expect((await a.client.account.usage()).features.find(feature => feature.feature === "inboxes")).toMatchObject({ used: 2 })
  })

  it("recovers a lost inbox refund and backfills inboxes that predate billing", async () => {
    // A refund that never reached Autumn leaves usage one higher than the account's real inbox count.
    const a = await account(), foreign = await account()
    const taken = name()
    await foreign.client.inboxes.create({ username: taken })
    autumn.state.failTrack = true
    try { await expect(a.client.inboxes.create({ username: taken })).rejects.toMatchObject({ status: 409, code: "inbox_conflict" }) }
    finally { autumn.state.failTrack = false }
    expect(autumn.usage(a.customer.id, "inboxes")).toBe(1)
    expect((await a.client.inboxes.list()).inboxes).toHaveLength(0)
    // The database says zero inboxes, so the next creation corrects Autumn before deciding, and the cap still holds at two.
    await a.client.inboxes.create({ username: name() })
    expect(autumn.usage(a.customer.id, "inboxes")).toBe(1)
    await a.client.inboxes.create({ username: name() })
    expect(autumn.usage(a.customer.id, "inboxes")).toBe(2)
    await expect(a.client.inboxes.create({ username: name() })).rejects.toMatchObject({ status: 402, code: "billing_limit" })
    expect(autumn.usage(a.customer.id, "inboxes")).toBe(2)
    // Inboxes created before billing was switched on are counted the first time the account is metered.
    const legacy = await account()
    const unmetered = new GoshenEmailClient({ apiKey: legacy.key, baseUrl: f.service.config.publicUrl, fetch: async (input, init) => handleRequest(new Request(input, init), f.service) })
    await unmetered.inboxes.create({ username: name() }); await unmetered.inboxes.create({ username: name() })
    expect(autumn.has(legacy.customer.id)).toBe(false)
    await expect(legacy.client.inboxes.create({ username: name() })).rejects.toMatchObject({ status: 402, code: "billing_limit" })
    expect(autumn.usage(legacy.customer.id, "inboxes")).toBe(2)
    expect((await legacy.client.inboxes.list()).inboxes).toHaveLength(2)
    // getUsage reports the database count and repairs Autumn on the way.
    autumn.setUsage(legacy.customer.id, "inboxes", 7)
    const usage = await legacy.client.account.usage()
    expect(usage.inboxes.count).toBe(2)
    expect(usage.features.find(feature => feature.feature === "inboxes")).toMatchObject({ used: 2, remaining: 0 })
    expect(autumn.usage(legacy.customer.id, "inboxes")).toBe(2)
  })

  it("caps inboxes by plan, ignores retries of an existing username, and credits deletions", async () => {
    const a = await account()
    const first = await a.client.inboxes.create({ username: name() })
    expect(autumn.has(a.customer.id)).toBe(true)
    await a.client.inboxes.create({ username: name() })
    expect(autumn.usage(a.customer.id, "inboxes")).toBe(2)
    await expect(a.client.inboxes.create({ username: name() })).rejects.toMatchObject({ status: 402, code: "billing_limit", transient: false })
    expect(await a.client.inboxes.create({ username: first.inboxId.split("@")[0]! })).toMatchObject({ inboxId: first.inboxId })
    expect(autumn.usage(a.customer.id, "inboxes")).toBe(2)
    expect((await a.client.inboxes.list()).inboxes).toHaveLength(2)
    await a.client.inboxes.delete({ inboxId: first.inboxId })
    expect(autumn.usage(a.customer.id, "inboxes")).toBe(1)
    await expect(a.client.inboxes.create({ username: name() })).resolves.toHaveProperty("inboxId")
  })

  it("refuses sends past the monthly allowance without a reservation, then accepts the same key after a top-up", async () => {
    const a = await account(), inbox = await a.client.inboxes.create({ username: name() })
    const send = (idempotencyKey: string) => a.client.messages.send({ inboxId: inbox.inboxId, to: ["receiver@example.net"], subject: "Hi", text: "hello", idempotencyKey })
    await send("one"); await send("two")
    expect(autumn.usage(a.customer.id, "sends")).toBe(2)
    const before = f.send.mock.calls.length
    await expect(send("three")).rejects.toMatchObject({ status: 402, code: "billing_limit" })
    expect(f.send.mock.calls.length).toBe(before)
    expect(await reservations(inbox.inboxId)).toBe(2)
    // A completed send is returned on retry even though the allowance is spent.
    expect(await send("two")).toMatchObject({ deduplicated: true })
    expect(autumn.usage(a.customer.id, "sends")).toBe(2)
    autumn.grant(a.customer.id, "sends", 3)
    expect(await send("three")).not.toHaveProperty("deduplicated")
    expect(autumn.usage(a.customer.id, "sends")).toBe(3)
    // Replies draw from the same allowance.
    const received = await service.receive(inbox.inboxId, rawMail({ id: `<${crypto.randomUUID()}@example.net>` }))
    await expect(a.client.messages.reply({ inboxId: inbox.inboxId, messageId: received.messageId, text: "thanks", idempotencyKey: "reply" }))
      .rejects.toMatchObject({ status: 402, code: "billing_limit" })
  })

  it("lets exactly one of two simultaneous sends through on the last unit", async () => {
    const a = await account(), inbox = await a.client.inboxes.create({ username: name() })
    autumn.grant(a.customer.id, "sends", 1)
    const results = await Promise.allSettled(["left", "right"].map(idempotencyKey =>
      a.client.messages.send({ inboxId: inbox.inboxId, to: ["receiver@example.net"], subject: "Hi", text: "hello", idempotencyKey })))
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1)
    expect(results.find(r => r.status === "rejected")).toMatchObject({ reason: { status: 402, code: "billing_limit" } })
    expect(autumn.usage(a.customer.id, "sends")).toBe(1)
    expect(await reservations(inbox.inboxId)).toBe(1)
    expect(autumn.openLocks()).toBe(0)
    // Ten more in parallel with nothing left: none sent, no reservations.
    const burst = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
      a.client.messages.send({ inboxId: inbox.inboxId, to: ["receiver@example.net"], subject: "Hi", text: "hello", idempotencyKey: `burst-${i}` })))
    expect(burst.every(r => r.status === "rejected")).toBe(true)
    expect(await reservations(inbox.inboxId)).toBe(1)
  })

  it("checks the allowance again when a retriable failure is retried", async () => {
    const a = await account(), inbox = await a.client.inboxes.create({ username: name() })
    const send = (idempotencyKey: string, attachments?: { filename: string; contentType: string; content: string }[]) =>
      a.client.messages.send({ inboxId: inbox.inboxId, to: ["receiver@example.net"], subject: "Hi", text: "hello", idempotencyKey, ...(attachments ? { attachments } : {}) })
    const put = f.objects.put
    f.objects.put = async () => { throw new Error("storage down") }
    try {
      await expect(send("attached", [{ filename: "a.txt", contentType: "text/plain", content: Buffer.from("hi").toString("base64") }]))
        .rejects.toMatchObject({ status: 503, code: "attachment_storage_error" })
    } finally { f.objects.put = put }
    // The failed attempt released its hold and consumed nothing.
    expect(autumn.usage(a.customer.id, "sends")).toBe(0)
    expect(autumn.held(a.customer.id, "sends")).toBe(0)
    await send("one"); await send("two")
    await expect(send("attached", [{ filename: "a.txt", contentType: "text/plain", content: Buffer.from("hi").toString("base64") }]))
      .rejects.toMatchObject({ status: 402, code: "billing_limit" })
    expect(autumn.usage(a.customer.id, "sends")).toBe(2)
    autumn.grant(a.customer.id, "sends", 3)
    await expect(send("attached", [{ filename: "a.txt", contentType: "text/plain", content: Buffer.from("hi").toString("base64") }])).resolves.toHaveProperty("messageId")
    expect(autumn.usage(a.customer.id, "sends")).toBe(3)
  })

  it("does not charge for a send the provider rejected", async () => {
    const a = await account(), inbox = await a.client.inboxes.create({ username: name() })
    f.send.mockRejectedValueOnce(new MailError("Recipient rejected", "invalid_argument", 422))
    await expect(a.client.messages.send({ inboxId: inbox.inboxId, to: ["receiver@example.net"], subject: "Hi", text: "hello", idempotencyKey: "rejected" }))
      .rejects.toMatchObject({ status: 422 })
    expect(autumn.usage(a.customer.id, "sends")).toBe(0)
    expect(autumn.held(a.customer.id, "sends")).toBe(0)
    expect(autumn.state.finalized.at(-1)).toBe("release:sends")
  })

  it("meters sends made with a mailbox key", async () => {
    const a = await account(), inbox = await a.client.inboxes.create({ username: name() })
    const row = await service.store.inbox(inbox.inboxId)
    const credentials = await mailboxCredentials(service, row.id) as { apiKey: string }
    const mailbox = new GoshenEmailClient({ apiKey: credentials.apiKey, baseUrl: service.config.publicUrl, fetch: request })
    await mailbox.messages.send({ inboxId: inbox.inboxId, to: ["receiver@example.net"], subject: "Hi", text: "hello", idempotencyKey: "mailbox-1" })
    expect(autumn.usage(a.customer.id, "sends")).toBe(1)
    await expect(mailbox.account.usage()).rejects.toMatchObject({ status: 403 })
  })

  it("refuses metered operations while billing is unreachable and leaves nothing behind", async () => {
    const a = await account(), inbox = await a.client.inboxes.create({ username: name() })
    autumn.state.down = true
    try {
      await expect(a.client.messages.send({ inboxId: inbox.inboxId, to: ["receiver@example.net"], subject: "Hi", text: "hello", idempotencyKey: "outage" }))
        .rejects.toMatchObject({ status: 503, code: "billing_unavailable", transient: true })
      expect(await reservations(inbox.inboxId)).toBe(0)
      await expect(a.client.inboxes.create({ username: name() })).rejects.toMatchObject({ status: 503, code: "billing_unavailable" })
      expect((await a.client.inboxes.list()).inboxes).toHaveLength(1)
      await expect(a.client.account.usage()).rejects.toMatchObject({ status: 503, code: "billing_unavailable" })
    } finally { autumn.state.down = false }
    await expect(a.client.messages.send({ inboxId: inbox.inboxId, to: ["receiver@example.net"], subject: "Hi", text: "hello", idempotencyKey: "outage" })).resolves.not.toHaveProperty("deduplicated")
  })

  it("exempts platform administrators from every check", async () => {
    const a = await account(admin)
    const calls = autumn.state.calls.length
    for (let i = 0; i < 3; i++) await a.client.inboxes.create({ username: name() })
    const inbox = (await a.client.inboxes.list()).inboxes[0]!
    for (const key of ["a", "b", "c"]) await a.client.messages.send({ inboxId: inbox.inboxId, to: ["receiver@example.net"], subject: "Hi", text: "hello", idempotencyKey: key })
    expect(autumn.state.calls.length).toBe(calls)
    expect(autumn.has(a.customer.id)).toBe(false)
    expect(await a.client.account.usage()).toMatchObject({ billing: "exempt", plan: null, inboxes: { count: 3, limit: null }, features: [], plans: pricingPlans })
  })

  it("consumes a triage unit at receipt, skips triage once spent, and refunds a failed analysis", async () => {
    const a = await account(), inbox = await a.client.inboxes.create({ username: name() })
    // A burst arriving together cannot overspend: the unit is taken when the message is stored.
    const [first, second] = await Promise.all([
      service.receive(inbox.inboxId, rawMail({ id: "<first@example.net>", subject: "Duplicate charge" })),
      service.receive(inbox.inboxId, rawMail({ id: "<second@example.net>", subject: "Another charge" })),
    ])
    const statuses = await Promise.all([first, second].map(async m => (await a.client.messages.get({ inboxId: inbox.inboxId, messageId: m.messageId })).triage?.status))
    expect(statuses.filter(s => s === "pending")).toHaveLength(1)
    expect(statuses.filter(s => s === undefined)).toHaveLength(1)
    expect(autumn.usage(a.customer.id, "triage")).toBe(1)
    await service.processTriage()
    expect(autumn.usage(a.customer.id, "triage")).toBe(1)
    // An analysis that ends in failure hands the unit back.
    autumn.grant(a.customer.id, "triage", 2)
    const failing = await service.receive(inbox.inboxId, rawMail({ id: "<failing@example.net>", subject: "Unavailable analysis" }))
    expect(autumn.usage(a.customer.id, "triage")).toBe(2)
    await service.processTriage()
    expect(await a.client.messages.get({ inboxId: inbox.inboxId, messageId: failing.messageId })).toHaveProperty("triage.status", "failed")
    expect(autumn.usage(a.customer.id, "triage")).toBe(1)
    expect(autumn.openLocks()).toBe(0)
  })

  it("releases the triage hold when the message cannot be stored", async () => {
    const a = await account(), inbox = await a.client.inboxes.create({ username: name() })
    const commit = service.store.commitMessage.bind(service.store)
    service.store.commitMessage = async () => { throw new MailError("Inbox not found", "not_found", 404) }
    try {
      await expect(service.receive(inbox.inboxId, rawMail({ id: "<lost@example.net>" }))).rejects.toMatchObject({ status: 404 })
    } finally { service.store.commitMessage = commit }
    expect(autumn.usage(a.customer.id, "triage")).toBe(0)
    expect(autumn.held(a.customer.id, "triage")).toBe(0)
    // The same message arriving again is charged once, when it is stored.
    await service.receive(inbox.inboxId, rawMail({ id: "<lost@example.net>" }))
    expect(autumn.usage(a.customer.id, "triage")).toBe(1)
  })

  it("charges one delivery when the same message arrives twice at once", async () => {
    const a = await account(), inbox = await a.client.inboxes.create({ username: name() })
    autumn.grant(a.customer.id, "triage", 5)
    const [x, y] = await Promise.all([
      service.receive(inbox.inboxId, rawMail({ id: "<twice@example.net>" })),
      service.receive(inbox.inboxId, rawMail({ id: "<twice@example.net>" })),
    ])
    expect(x.messageId).toBe(y.messageId)
    expect((await f.db.query("select 1 from mail.messages where wire_id = '<twice@example.net>'")).length).toBe(1)
    expect(autumn.usage(a.customer.id, "triage")).toBe(1)
    expect(autumn.held(a.customer.id, "triage")).toBe(0)
    expect(autumn.openLocks()).toBe(0)
  })

  it("charges quarantined mail for triage only when it is released", async () => {
    const a = await account(), inbox = await a.client.inboxes.create({ username: name() })
    const quarantine = { ...cleanProtection(), status: "quarantined" as const, reasons: ["spam" as const] }
    const held = await service.receive(inbox.inboxId, rawMail({ id: "<held@example.net>", subject: "Suspicious" }), quarantine)
    expect(autumn.usage(a.customer.id, "triage")).toBe(0)
    // Two people release at once: one release happens, one unit is charged.
    autumn.grant(a.customer.id, "triage", 5)
    const release = () => service.releaseQuarantine({ inboxId: inbox.inboxId, messageId: held.messageId, reviewedBy: a.customer.id })
    const outcomes = await Promise.all([release(), release()])
    expect(outcomes.filter(Boolean)).toHaveLength(1)
    expect(autumn.usage(a.customer.id, "triage")).toBe(1)
    expect(autumn.openLocks()).toBe(0)
    // A message that vanished before release is not charged.
    const gone = await service.receive(inbox.inboxId, rawMail({ id: "<gone@example.net>", subject: "Suspicious" }), quarantine)
    const goneRow = await service.store.message((await service.store.inbox(inbox.inboxId)).id, gone.messageId)
    const message = service.store.message.bind(service.store)
    service.store.message = async () => goneRow
    await f.db.query("delete from mail.messages where id = $1", [goneRow.id])
    try {
      await expect(service.releaseQuarantine({ inboxId: inbox.inboxId, messageId: gone.messageId, reviewedBy: a.customer.id })).rejects.toMatchObject({ status: 404 })
    } finally { service.store.message = message }
    expect(autumn.usage(a.customer.id, "triage")).toBe(1)
    expect(autumn.held(a.customer.id, "triage")).toBe(0)
    // Two releases with one unit left: whichever caller wins, the message is analysed if and only if it was charged.
    autumn.grant(a.customer.id, "triage", 2)
    const contested = await service.receive(inbox.inboxId, rawMail({ id: "<contested@example.net>", subject: "Suspicious" }), quarantine)
    const attempts = await Promise.all([1, 2].map(() => service.releaseQuarantine({ inboxId: inbox.inboxId, messageId: contested.messageId, reviewedBy: a.customer.id })))
    expect(attempts.filter(Boolean)).toHaveLength(1)
    const charged = autumn.usage(a.customer.id, "triage") - 1
    const pending = (await a.client.messages.get({ inboxId: inbox.inboxId, messageId: contested.messageId })).triage?.status === "pending"
    expect(charged).toBe(pending ? 1 : 0)
    expect(autumn.held(a.customer.id, "triage")).toBe(0)
    const spent = autumn.usage(a.customer.id, "triage")
    autumn.grant(a.customer.id, "triage", spent)
    await service.processTriage()
    expect(await a.client.messages.get({ inboxId: inbox.inboxId, messageId: held.messageId })).toHaveProperty("triage.status", "complete")
    // With nothing left, a release drops the pending analysis instead of running it unpaid.
    const second = await service.receive(inbox.inboxId, rawMail({ id: "<held-2@example.net>", subject: "Suspicious" }), quarantine)
    await service.releaseQuarantine({ inboxId: inbox.inboxId, messageId: second.messageId, reviewedBy: a.customer.id })
    await service.processTriage()
    expect(await a.client.messages.get({ inboxId: inbox.inboxId, messageId: second.messageId })).not.toHaveProperty("triage")
    expect(autumn.usage(a.customer.id, "triage")).toBe(spent)
  })

  it("reports usage through REST, the client, CLI, and hosted MCP with the same shape", async () => {
    const a = await account()
    await a.client.inboxes.create({ username: name() })
    const usage = await a.client.account.usage()
    expect(developerOperations.getUsage.output.safeParse(usage).success).toBe(true)
    expect(usage).toMatchObject({ billing: "metered", plan: { planId: "free", status: "active" }, inboxes: { count: 1, limit: null } })
    expect(usage.plans.map(p => [p.planId, p.price])).toEqual([["free", 0], ["developer", 20], ["team", 99]])
    expect(usage.features.find(feature => feature.feature === "inboxes")).toMatchObject({ granted: 2, used: 1, remaining: 1, unlimited: false })
    expect(usage.features.find(feature => feature.feature === "sends")).toMatchObject({ granted: 2, used: 0, remaining: 2 })
    const response = await request(`${service.config.publicUrl}/v1/usage`, { headers: { authorization: `Bearer ${a.key}` } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(usage)
    const output: string[] = [], errors: string[] = []
    expect(await run(["account", "usage"], { env: { GOSHENEMAIL_API_KEY: a.key, GOSHENEMAIL_BASE_URL: service.config.publicUrl }, readStdin: async () => "",
      out: text => output.push(text), error: text => errors.push(text), fetch: request }), errors.join()).toBe(0)
    expect(JSON.parse(output[0]!)).toEqual(usage)
    const mcp = new Client({ name: "billing-test", version: "1.0.0" })
    try {
      await mcp.connect(new StreamableHTTPClientTransport(new URL("/mcp", service.config.publicUrl), { fetch: request, requestInit: { headers: { authorization: `Bearer ${a.key}` } } }))
      expect(await mcp.callTool({ name: "get_usage", arguments: {} })).toMatchObject({ structuredContent: { result: usage } })
    } finally { await mcp.close() }
    // getUsage is a read; a key without inboxes:read cannot use it.
    const { customer } = await store.invite({ email: `${crypto.randomUUID()}@example.net`, inboxLimit: null })
    const restricted = await manageApiKeys(f.db, customer, "createApiKey", { name: "Send only", scopes: ["messages:send"] }) as { apiKey: string }
    expect((await request(`${service.config.publicUrl}/v1/usage`, { headers: { authorization: `Bearer ${restricted.apiKey}` } })).status).toBe(403)
  })

  it("starts checkout from the dashboard only, for known plans, and never for administrators", async () => {
    const a = await account()
    expect(await dashboard(a.customer, "startCheckout", { planId: "developer" })).toEqual({ paymentUrl: "https://checkout.stripe.test/developer" })
    expect(autumn.state.checkouts.at(-1)).toEqual({ customerId: a.customer.id, planId: "developer" })
    await expect(dashboard(a.customer, "startCheckout", { planId: "enterprise" })).rejects.toMatchObject({ status: 400 })
    await expect(dashboard(a.customer, "startCheckout", { planId: "developer", extra: true })).rejects.toMatchObject({ status: 400 })
    const [ownerRow] = await f.db.query<{ id: string }>("select id from mail.customers where email = $1", [admin])
    const owner: Customer = { id: ownerRow!.id, email: admin, role: "admin", inboxLimit: null }
    await expect(dashboard(owner, "startCheckout", { planId: "developer" })).rejects.toMatchObject({ status: 403 })
    expect(await dashboard(a.customer, "openBillingPortal")).toEqual({ url: `https://billing.stripe.test/session/${a.customer.id}` })
    await expect(dashboard(owner, "openBillingPortal")).rejects.toMatchObject({ status: 403 })
    await expect(dashboard(a.customer, "openBillingPortal", { returnUrl: "https://evil.example" })).rejects.toMatchObject({ status: 400 })
    expect((await request(`${service.config.publicUrl}/v1/billing/portal`, { method: "POST", headers: { authorization: `Bearer ${a.key}`, "content-type": "application/json" }, body: "{}" })).status).toBe(404)
    expect((await request(`${service.config.publicUrl}/v1/checkout`, { method: "POST", headers: { authorization: `Bearer ${a.key}`, "content-type": "application/json" }, body: "{}" })).status).toBe(404)
    expect(Object.keys(developerOperations)).not.toContain("startCheckout")
  })

  it("runs unmetered when billing is not configured", async () => {
    const plain = new MailService({ ...f.service, triageAnalyzer: fixtureTriage })
    const unmetered: typeof fetch = async (input, init) => handleRequest(new Request(input, init), plain)
    const { customer } = await store.invite({ email: `${crypto.randomUUID()}@example.net`, inboxLimit: 3 })
    const key = await manageApiKeys(f.db, customer, "createApiKey", { name: "Agent", scopes: apiScopes }) as { apiKey: string }
    const client = new GoshenEmailClient({ apiKey: key.apiKey, baseUrl: plain.config.publicUrl, fetch: unmetered })
    for (let i = 0; i < 3; i++) await client.inboxes.create({ username: name() })
    await expect(client.inboxes.create({ username: name() })).rejects.toMatchObject({ status: 422, code: "inbox_limit" })
    expect(await client.account.usage()).toEqual({ billing: "disabled", plan: null, inboxes: { count: 3, limit: 3 }, features: [], plans: [] })
    await expect(executeCustomerRequest(new Request("https://dashboard.test/rpc", { method: "POST", body: JSON.stringify({ planId: "developer" }) }), plain, store, customer, "startCheckout"))
      .rejects.toMatchObject({ status: 503, code: "not_configured" })
    expect(autumn.has(customer.id)).toBe(false)
  })

  it("does not follow a redirect from Autumn", async () => {
    const request = vi.fn(workersFetch(async () => redirectResponse()))
    await expect(autumnBilling("am_sk_test_fixture", request).usage({ id: "redirected", email: "redirected@example.net" }))
      .rejects.toMatchObject({ code: "billing_unavailable" })
    expect(request.mock.calls[0]![1]?.redirect).toBe("manual")
  })
})
