import { readFile } from "node:fs/promises"
import { URL } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { BezalelEmail } from "@bezalel/email-sdk"
import { run } from "@bezalel/email-cli"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { apiScopes, manageApiKeys } from "../src/api-keys.js"
import { autumnBilling, billingFeatures, billingPlans } from "../src/billing.js"
import { MailError } from "../src/contracts.js"
import { executeCustomerRequest } from "../src/customer-api.js"
import { CustomerStore, type Customer } from "../src/customer-store.js"
import { developerOperations } from "../src/developer-contract.js"
import { mailboxCredentials } from "../src/mail-clients.js"
import { MailService } from "../src/mail-service.js"
import { Metering } from "../src/metering.js"
import { handleRequest } from "../src/worker.js"
import { fakeAutumn } from "./autumn-fixture.js"
import { cleanProtection, fixture, rawMail } from "./support.js"
import { fixtureTriage } from "./triage-fixture.js"

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
    return { customer, key: key.apiKey, client: new BezalelEmail({ apiKey: key.apiKey, baseUrl: service.config.publicUrl, fetch: request }) }
  }
  const dashboard = async (customer: Customer, operation: string, body: unknown = {}) => {
    const response = await executeCustomerRequest(new Request("https://dashboard.test/rpc", { method: "POST", body: JSON.stringify(body) }), service, store, customer, operation)
    return ((await response.json()) as { result: unknown }).result
  }
  const name = () => "agent-" + crypto.randomUUID().slice(0, 8)
  const reservations = async (address: string) => (await f.db.query<{ n: number }>(
    "select count(*)::int as n from mail.sends s join mail.inboxes i on i.id = s.inbox_id where i.address = $1", [address]))[0]!.n

  it("keeps the Autumn config and the Worker's feature ids in step", async () => {
    const config = await readFile(new URL("../../../ops/autumn/autumn.config.ts", import.meta.url), "utf8")
    const featureIds = [...config.matchAll(/featureId: "([a-z_]+)"/g)].map(m => m[1]).sort()
    const planIds = [...config.matchAll(/planId: "([a-z_]+)"/g)].map(m => m[1]).sort()
    expect(featureIds).toEqual(Object.values(billingFeatures).sort())
    expect(planIds).toEqual([...billingPlans].sort())
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
    const mailbox = new BezalelEmail({ apiKey: credentials.apiKey, baseUrl: service.config.publicUrl, fetch: request })
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
    expect(await a.client.account.usage()).toMatchObject({ billing: "exempt", plan: null, inboxes: { count: 3, limit: null }, features: [] })
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
  })

  it("charges quarantined mail for triage only when it is released", async () => {
    const a = await account(), inbox = await a.client.inboxes.create({ username: name() })
    const quarantine = { ...cleanProtection(), status: "quarantined" as const, reasons: ["spam" as const] }
    const held = await service.receive(inbox.inboxId, rawMail({ id: "<held@example.net>", subject: "Suspicious" }), quarantine)
    expect(autumn.usage(a.customer.id, "triage")).toBe(0)
    await service.releaseQuarantine({ inboxId: inbox.inboxId, messageId: held.messageId, reviewedBy: a.customer.id })
    expect(autumn.usage(a.customer.id, "triage")).toBe(1)
    await service.processTriage()
    expect(await a.client.messages.get({ inboxId: inbox.inboxId, messageId: held.messageId })).toHaveProperty("triage.status", "complete")
    // With nothing left, a release drops the pending analysis instead of running it unpaid.
    const second = await service.receive(inbox.inboxId, rawMail({ id: "<held-2@example.net>", subject: "Suspicious" }), quarantine)
    await service.releaseQuarantine({ inboxId: inbox.inboxId, messageId: second.messageId, reviewedBy: a.customer.id })
    await service.processTriage()
    expect(await a.client.messages.get({ inboxId: inbox.inboxId, messageId: second.messageId })).not.toHaveProperty("triage")
    expect(autumn.usage(a.customer.id, "triage")).toBe(1)
  })

  it("reports usage through REST, SDK, CLI, and hosted MCP with the same shape", async () => {
    const a = await account()
    await a.client.inboxes.create({ username: name() })
    const usage = await a.client.account.usage()
    expect(developerOperations.getUsage.output.safeParse(usage).success).toBe(true)
    expect(usage).toMatchObject({ billing: "metered", plan: { planId: "free", status: "active" }, inboxes: { count: 1, limit: null } })
    expect(usage.features.find(feature => feature.feature === "inboxes")).toMatchObject({ granted: 2, used: 1, remaining: 1, unlimited: false })
    expect(usage.features.find(feature => feature.feature === "sends")).toMatchObject({ granted: 2, used: 0, remaining: 2 })
    const response = await request(`${service.config.publicUrl}/v1/usage`, { headers: { authorization: `Bearer ${a.key}` } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(usage)
    const output: string[] = [], errors: string[] = []
    expect(await run(["account", "usage"], { env: { BEZALEL_API_KEY: a.key, BEZALEL_BASE_URL: service.config.publicUrl }, readStdin: async () => "",
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
    expect((await request(`${service.config.publicUrl}/v1/checkout`, { method: "POST", headers: { authorization: `Bearer ${a.key}`, "content-type": "application/json" }, body: "{}" })).status).toBe(404)
    expect(Object.keys(developerOperations)).not.toContain("startCheckout")
  })

  it("runs unmetered when billing is not configured", async () => {
    const plain = new MailService({ ...f.service, triageAnalyzer: fixtureTriage })
    const unmetered: typeof fetch = async (input, init) => handleRequest(new Request(input, init), plain)
    const { customer } = await store.invite({ email: `${crypto.randomUUID()}@example.net`, inboxLimit: 3 })
    const key = await manageApiKeys(f.db, customer, "createApiKey", { name: "Agent", scopes: apiScopes }) as { apiKey: string }
    const client = new BezalelEmail({ apiKey: key.apiKey, baseUrl: plain.config.publicUrl, fetch: unmetered })
    for (let i = 0; i < 3; i++) await client.inboxes.create({ username: name() })
    await expect(client.inboxes.create({ username: name() })).rejects.toMatchObject({ status: 422, code: "inbox_limit" })
    expect(await client.account.usage()).toEqual({ billing: "disabled", plan: null, inboxes: { count: 3, limit: 3 }, features: [] })
    await expect(executeCustomerRequest(new Request("https://dashboard.test/rpc", { method: "POST", body: JSON.stringify({ planId: "developer" }) }), plain, store, customer, "startCheckout"))
      .rejects.toMatchObject({ status: 503, code: "not_configured" })
    expect(autumn.has(customer.id)).toBe(false)
  })
})
