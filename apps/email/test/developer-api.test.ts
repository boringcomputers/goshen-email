import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { BezalelEmail, BezalelError } from "@bezalel/email-sdk"
import { run } from "@bezalel/email-cli"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { apiScopes, manageApiKeys } from "../src/api-keys.js"
import { CustomerStore, type Customer } from "../src/customer-store.js"
import { developerOperations } from "../src/developer-contract.js"
import { handleRequest } from "../src/worker.js"
import { mailboxCredentials } from "../src/mail-clients.js"
import { fixture, rawMail, cleanProtection } from "./support.js"

describe("developer API, SDK, CLI, and hosted MCP", () => {
  let f: Awaited<ReturnType<typeof fixture>>, store: CustomerStore
  beforeAll(async () => { f = await fixture(); store = new CustomerStore(f.db, []) })
  afterAll(async () => { await f?.pg.close() })
  const request: typeof fetch = async (input, init) => handleRequest(new Request(input, init), f.service)
  async function account(scopes: readonly string[] = apiScopes) {
    const { customer } = await store.invite({ email: `${crypto.randomUUID()}@example.net`, inboxLimit: null })
    const key = await manageApiKeys(f.db, customer, "createApiKey", { name: "Agent", scopes }) as { apiKey: string; keyId: string }
    const client = new BezalelEmail({ apiKey: key.apiKey, baseUrl: f.service.config.publicUrl, fetch: request })
    return { customer, key, client }
  }
  async function api(key: string, path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) {
    return request(new URL(path, f.service.config.publicUrl), { method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  }
  const name = () => "agent-" + crypto.randomUUID().slice(0, 8)

  it("stores only key hashes, returns secrets once, scopes lists and revocations to the owner", async () => {
    const a = await account(), b = await account()
    const rows = await f.db.query<{ token_hash: string; expires_at: string }>("select * from mail.api_keys where id=$1", [a.key.keyId])
    expect(rows[0]!.token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(new Date(rows[0]!.expires_at).getTime() - Date.now()).toBeGreaterThan(29 * 86400_000)
    expect(new Date(rows[0]!.expires_at).getTime() - Date.now()).toBeLessThanOrEqual(30 * 86400_000)
    expect(JSON.stringify(rows)).not.toContain(a.key.apiKey)
    const listed = JSON.stringify(await manageApiKeys(f.db, a.customer, "listApiKeys", {}))
    expect(listed).toContain(a.key.keyId); expect(listed).not.toContain(a.key.apiKey); expect(listed).not.toContain("token_hash"); expect(listed).not.toContain(b.key.keyId)
    await expect(manageApiKeys(f.db, b.customer, "revokeApiKey", { keyId: a.key.keyId })).rejects.toMatchObject({ status: 404 })
    expect((await api(a.key.apiKey, "/v1/inboxes")).status).toBe(200)
    await manageApiKeys(f.db, a.customer, "revokeApiKey", { keyId: a.key.keyId })
    expect((await api(a.key.apiKey, "/v1/inboxes")).status).toBe(401)
  })

  it("caps concurrent key creation and allows replacement after revocation", async () => {
    const a = await account()
    for (let i = 0; i < 18; i++) await manageApiKeys(f.db, a.customer, "createApiKey", { name: `Agent ${i}`, scopes: ["inboxes:read"] })
    const attempted = await Promise.allSettled([1, 2].map(i => manageApiKeys(f.db, a.customer, "createApiKey", { name: `Last ${i}`, scopes: ["inboxes:read"] })))
    expect(attempted.filter(result => result.status === "fulfilled")).toHaveLength(1)
    expect(attempted.filter(result => result.status === "rejected")).toHaveLength(1)
    await manageApiKeys(f.db, a.customer, "revokeApiKey", { keyId: a.key.keyId })
    await expect(manageApiKeys(f.db, a.customer, "createApiKey", { name: "Replacement", scopes: ["inboxes:read"] })).resolves.toHaveProperty("apiKey")
  })

  it("creates multiple inboxes with stable retries and rejects another account's reads and mutations", async () => {
    const a = await account(), b = await account()
    const username = name(), first = await a.client.inboxes.create({ username }), second = await a.client.inboxes.create({ username: name() })
    expect(await a.client.inboxes.create({ username })).toMatchObject({ inboxId: first.inboxId })
    expect(await a.client.inboxes.get({ inboxId: first.inboxId.toUpperCase() })).toMatchObject({ inboxId: first.inboxId })
    expect((await a.client.inboxes.list()).inboxes.map(i => i.inboxId)).toEqual([first.inboxId, second.inboxId])
    expect((await b.client.inboxes.list()).inboxes).toHaveLength(0)
    for (const action of [() => b.client.inboxes.get({ inboxId: first.inboxId }), () => b.client.inboxes.delete({ inboxId: first.inboxId }),
      () => b.client.messages.list({ inboxId: first.inboxId }), () => b.client.messages.send({ inboxId: first.inboxId, to: ["receiver@example.net"], text: "hello", idempotencyKey: "cross-account" })])
      await expect(action()).rejects.toMatchObject({ status: 404 })
    expect((await api(a.key.apiKey, "/v1/inboxes", "POST", { username: name(), role: "admin" })).status).toBe(400)
    expect((await api(a.key.apiKey, "/v1/inboxes", "POST", {})).status).toBe(400)
  })

  it("enforces permissions, expiry, disabled accounts, and keeps platform keys out of the public API", async () => {
    const a = await account(["inboxes:read"])
    await expect(a.client.inboxes.create({ username: name() })).rejects.toMatchObject({ status: 403, code: "insufficient_scope" })
    await expect(a.client.inboxes.update({ inboxId: "anything@example.com", group: "research" })).rejects.toMatchObject({ status: 403, code: "insufficient_scope" })
    expect((await api(f.service.config.apiToken, "/v1/inboxes")).status).toBe(401)
    expect((await api(a.key.apiKey + "x", "/v1/inboxes")).status).toBe(401)
    await f.db.query("update mail.api_keys set expires_at = now() - interval '1 second' where id=$1", [a.key.keyId])
    await expect(a.client.inboxes.list()).rejects.toMatchObject({ status: 401 })
    const b = await account()
    await store.setAccess(b.customer.id, false)
    await expect(b.client.inboxes.list()).rejects.toMatchObject({ status: 401 })
    await store.setAccess(b.customer.id, true)
    await expect(b.client.inboxes.list()).rejects.toMatchObject({ status: 401 })
  })

  it("uses one account key beyond five inboxes and groups them across SDK, CLI, REST, and MCP", async () => {
    const a = await account(), b = await account(), created = []
    expect(a.customer.inboxLimit).toBeNull()
    for (let i = 0; i < 7; i++) created.push(await a.client.inboxes.create({ username: name(), group: i < 4 ? "research" : "support" }))
    const foreign = await b.client.inboxes.create({ username: name(), group: "research" })
    const pages = []; for await (const page of a.client.pages("listInboxes", { limit: 2, group: "research" })) pages.push(page)
    expect(pages).toHaveLength(2)
    expect(pages.flatMap(page => page.inboxes.map(i => i.inboxId))).toEqual(created.slice(0, 4).map(i => i.inboxId))
    const first = created[0]!, token = pages[0]!.nextPageToken!
    expect(await a.client.inboxes.create({ username: first.inboxId.split("@")[0]!, group: "other" })).toMatchObject({ inboxId: first.inboxId, group: "research" })
    await expect(b.client.inboxes.list({ group: "research", pageToken: token })).rejects.toMatchObject({ status: 400 })
    await expect(a.client.inboxes.list({ group: "support", pageToken: token })).rejects.toMatchObject({ status: 400 })
    await expect(a.client.inboxes.update({ inboxId: foreign.inboxId, group: "research" })).rejects.toMatchObject({ status: 404 })
    const output: string[] = [], errors: string[] = []
    const io = { env: { BEZALEL_API_KEY: a.key.apiKey, BEZALEL_BASE_URL: f.service.config.publicUrl }, readStdin: async () => "", out: (text: string) => output.push(text), error: (text: string) => errors.push(text), fetch: request }
    expect(await run(["inboxes", "update", "--inbox-id", first.inboxId, "--group", "support"], io), errors.join()).toBe(0)
    expect(JSON.parse(output.pop()!)).toMatchObject({ group: "support" })
    expect(await run(["inboxes", "list", "--group", "support", "--limit", "2"], io)).toBe(0)
    expect(JSON.parse(output.pop()!)).toMatchObject({ inboxes: [expect.objectContaining({ group: "support" }), expect.objectContaining({ group: "support" })], nextPageToken: expect.any(String) })
    const client = new Client({ name: "account-groups", version: "1.0.0" })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", f.service.config.publicUrl), { fetch: request, requestInit: { headers: { authorization: `Bearer ${a.key.apiKey}` } } }))
      expect(await client.callTool({ name: "update_inbox", arguments: { inboxId: first.inboxId, group: null } })).toMatchObject({ structuredContent: { result: { inboxId: first.inboxId, group: null } } })
      expect(await client.callTool({ name: "list_inboxes", arguments: { group: "research", limit: 1 } })).toMatchObject({ structuredContent: { result: { inboxes: [expect.objectContaining({ group: "research" })], nextPageToken: expect.any(String) } } })
    } finally { await client.close() }
    expect((await a.client.inboxes.list()).inboxes).toHaveLength(7)
    expect((await a.client.inboxes.get({ inboxId: first.inboxId })).group).toBeNull()
    for (const query of ["limit=0", "limit=101", "group=", "group=Research", "pageToken=garbage"])
      expect((await api(a.key.apiKey, `/v1/inboxes?${query}`)).status, query).toBe(400)
  })

  it("paginates equal timestamps without duplicates and gets inboxes beyond the first page", async () => {
    const a = await account()
    await f.service.store.saveDomain(await f.service.transport.verifyDomain("example.com"))
    // Exercise the default page boundary without making 51 provider calls.
    for (let i = 0; i < 51; i++) await store.provision(a.customer, `${name()}@example.com`, "example.com")
    await f.db.query("update mail.inboxes set created_at = '2026-01-01T01:02:03.123456Z' where id in (select inbox_id from mail.customer_inboxes where customer_id=$1)", [a.customer.id])
    const first = await a.client.inboxes.list()
    expect(first.inboxes).toHaveLength(50)
    const second = await a.client.inboxes.list({ pageToken: first.nextPageToken })
    expect(second.inboxes).toHaveLength(1); expect(second.nextPageToken).toBeUndefined()
    expect(new Set([...first.inboxes, ...second.inboxes].map(i => i.inboxId)).size).toBe(51)
    expect(await a.client.inboxes.get({ inboxId: second.inboxes[0]!.inboxId })).toMatchObject(second.inboxes[0]!)
    await a.client.inboxes.delete({ inboxId: first.inboxes.at(-1)!.inboxId })
    expect(await a.client.inboxes.list({ pageToken: first.nextPageToken })).toEqual(second)
  })

  it("does not give an owner's API key platform-wide access", async () => {
    const other = await account(), owner = await account()
    const inbox = await other.client.inboxes.create({ username: name() })
    const admin: Customer = { ...owner.customer, role: "admin", inboxLimit: null }
    const key = await manageApiKeys(f.db, admin, "createApiKey", { name: "Owner agent", scopes: apiScopes }) as { apiKey: string }
    expect(await (await api(key.apiKey, "/v1/inboxes")).json()).toEqual({ inboxes: [] })
    expect((await api(key.apiKey, `/v1/inboxes/${inbox.inboxId}`)).status).toBe(404)
  })

  it("keeps inbox capacity and routing retries in the existing customer service", async () => {
    const a = await account()
    await f.db.query("update mail.customers set inbox_limit=1 where id=$1", [a.customer.id])
    const username = name()
    const original = f.service.transport.ensureInboxRoute
    f.service.transport.ensureInboxRoute = async () => { throw new Error("simulated provider outage") }
    try { await expect(a.client.inboxes.create({ username })).rejects.toMatchObject({ status: 503, code: "route_pending" }) }
    finally { f.service.transport.ensureInboxRoute = original }
    const inbox = (await a.client.inboxes.list()).inboxes[0]!
    expect(inbox.deliveryStatus).toBe("pending")
    expect(await a.client.inboxes.finishSetup({ inboxId: inbox.inboxId })).toMatchObject({ deliveryStatus: "ready" })
    await expect(a.client.inboxes.create({ username: name() })).rejects.toMatchObject({ status: 422, code: "inbox_limit" })
  })

  it("preserves send and reply idempotency across SDK, CLI, and REST, with real storage and simulated transport", async () => {
    const a = await account(), inbox = await a.client.inboxes.create({ username: name() })
    const body = { inboxId: inbox.inboxId, to: ["receiver@example.net"], subject: "Developer probe", text: "One intended message", idempotencyKey: crypto.randomUUID() }
    const before = f.send.mock.calls.length, first = await a.client.messages.send(body), second = await a.client.messages.send(body)
    expect(second).toMatchObject({ ...first, deduplicated: true }); expect(f.send.mock.calls.length - before).toBe(1)
    const output: string[] = [], errors: string[] = []
    expect(await run(["messages", "send", "--json", JSON.stringify(body)], { env: { BEZALEL_API_KEY: a.key.apiKey, BEZALEL_BASE_URL: f.service.config.publicUrl }, readStdin: async () => "", out: text => output.push(text), error: text => errors.push(text), fetch: request })).toBe(0)
    expect(errors).toEqual([]); expect(JSON.parse(output[0]!)).toMatchObject({ messageId: first.messageId, deduplicated: true }); expect(f.send.mock.calls.length - before).toBe(1)
    expect(await a.client.messages.get({ inboxId: inbox.inboxId, messageId: first.messageId })).toMatchObject({ text: body.text })
    expect((await api(a.key.apiKey, `/v1/inboxes/${inbox.inboxId}/messages/send`, "POST", { ...body, inboxId: undefined }, { "idempotency-key": "different" })).status).toBe(400)
    const reply = { inboxId: inbox.inboxId, messageId: first.messageId, text: "A reply", idempotencyKey: crypto.randomUUID() }
    const replyOne = await a.client.messages.reply(reply)
    expect(await a.client.messages.reply(reply)).toMatchObject({ messageId: replyOne.messageId, deduplicated: true })
  })

  it("supports typed pagination, labels, search, threads and attachments and matches response schemas", async () => {
    const a = await account(), inbox = await a.client.inboxes.create({ username: name() })
    for (let i = 0; i < 3; i++) await a.client.messages.send({ inboxId: inbox.inboxId, to: ["receiver@example.net"], subject: `Probe ${i}`, text: "needle", idempotencyKey: crypto.randomUUID() })
    const pages = []; for await (const page of a.client.pages("listMessages", { inboxId: inbox.inboxId, limit: 1 })) pages.push(page)
    expect(pages).toHaveLength(3); expect(new Set(pages.flatMap(page => page.messages.map(m => m.messageId))).size).toBe(3)
    const message = pages[0]!.messages[0]!
    await a.client.messages.updateLabels({ inboxId: inbox.inboxId, messageId: message.messageId, addLabels: ["reviewed"] })
    expect((await a.client.messages.list({ inboxId: inbox.inboxId, labels: ["reviewed"] })).messages).toHaveLength(1)
    expect((await a.client.messages.search({ inboxId: inbox.inboxId, query: "needle" })).messages).toHaveLength(3)
    expect(developerOperations.listThreads.output.safeParse(await a.client.threads.list({ inboxId: inbox.inboxId })).success).toBe(true)
    expect(developerOperations.getThread.output.safeParse(await a.client.threads.get({ inboxId: inbox.inboxId, threadId: message.threadId, includeBodies: true })).success).toBe(true)
    await f.service.receive(inbox.inboxId, rawMail({ id: `<${crypto.randomUUID()}@example.net>`, attachment: true }), cleanProtection())
    const received = (await a.client.messages.list({ inboxId: inbox.inboxId, labels: ["received"] })).messages[0]!
    const attachment = await a.client.messages.getAttachment({ inboxId: inbox.inboxId, messageId: received.messageId, attachmentId: received.attachments[0]!.attachmentId })
    expect(developerOperations.getAttachment.output.safeParse(attachment).success).toBe(true)
  })

  it("does not let API keys release quarantine or read held bodies", async () => {
    const a = await account(), inbox = await a.client.inboxes.create({ username: name() })
    const protection = { ...cleanProtection(), status: "quarantined" as const, reasons: ["spam" as const] }
    await f.service.receive(inbox.inboxId, rawMail({ id: `<${crypto.randomUUID()}@example.net>`, attachment: true }), protection)
    const held = (await a.client.messages.list({ inboxId: inbox.inboxId, labels: ["quarantined"] })).messages[0]!
    expect(await a.client.messages.get({ inboxId: inbox.inboxId, messageId: held.messageId, includeHtml: true })).not.toHaveProperty("text")
    await expect(a.client.messages.updateLabels({ inboxId: inbox.inboxId, messageId: held.messageId, removeLabels: ["quarantined"] })).rejects.toMatchObject({ status: 403 })
    await expect(a.client.messages.getAttachment({ inboxId: inbox.inboxId, messageId: held.messageId, attachmentId: held.attachments[0]!.attachmentId })).rejects.toMatchObject({ status: 403 })
    expect((await api(a.key.apiKey, "/v1/releaseQuarantine", "POST", {})).status).toBe(404)
  })

  it("accepts existing mailbox keys without expanding their scope", async () => {
    const a = await account(), first = await a.client.inboxes.create({ username: name() }), second = await a.client.inboxes.create({ username: name() })
    const row = await f.service.store.inbox(first.inboxId), key = await mailboxCredentials(f.service, row.id)
    const scoped = new BezalelEmail({ apiKey: key.apiKey, baseUrl: f.service.config.publicUrl, fetch: request })
    expect((await scoped.inboxes.list()).inboxes.map(i => i.inboxId)).toEqual([first.inboxId])
    await expect(scoped.messages.list({ inboxId: second.inboxId })).rejects.toMatchObject({ status: 403 })
    await expect(scoped.inboxes.create({ username: name() })).rejects.toMatchObject({ status: 403 })
    await expect(scoped.inboxes.delete({ inboxId: first.inboxId })).rejects.toMatchObject({ status: 403 })
    await expect(scoped.inboxes.update({ inboxId: first.inboxId, group: "research" })).rejects.toMatchObject({ status: 403 })
    await expect(scoped.inboxes.list({ group: "research" })).rejects.toMatchObject({ status: 403 })
  })

  it("rejects malformed and conflicting parameters without sends", async () => {
    const a = await account(), inbox = await a.client.inboxes.create({ username: name() }), base = `/v1/inboxes/${inbox.inboxId}`
    for (const query of ["limit=bad", "limit=0", "limit=101", "limit=2&limit=3", "unknown=x", "inboxId=other@example.com"])
      expect((await api(a.key.apiKey, `${base}/messages?${query}`)).status, query).toBe(400)
    expect((await api(a.key.apiKey, `${base}/threads?includeTrash=no`)).status).toBe(400)
    expect((await api(a.key.apiKey, `${base}/messages/send`, "POST", { inboxId: inbox.inboxId, to: ["r@example.net"], text: "x", idempotencyKey: "1" })).status).toBe(400)
    expect((await api(a.key.apiKey, "/v1/inboxes/%ZZ")).status).toBe(400)
  })

  it("serves OpenAPI and real MCP discovery/tool calls with per-request auth and scoped tools", async () => {
    const a = await account(["inboxes:read"]), endpoint = new URL("/mcp", f.service.config.publicUrl)
    const spec = await request(new URL("/openapi.json", endpoint))
    expect(spec.status).toBe(200)
    expect(await spec.json()).toMatchObject({ servers: [{ url: f.service.config.publicUrl }] })
    const transport = new StreamableHTTPClientTransport(endpoint, { fetch: request, requestInit: { headers: { authorization: `Bearer ${a.key.apiKey}` } } })
    const client = new Client({ name: "developer-verification", version: "1.0.0" })
    try {
      await client.connect(transport)
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(["list_inboxes", "get_inbox", "get_usage"])
      expect(await client.callTool({ name: "list_inboxes", arguments: {} })).toMatchObject({ structuredContent: { result: { inboxes: [] } } })
      await manageApiKeys(f.db, a.customer, "revokeApiKey", { keyId: a.key.keyId })
      await expect(client.listTools()).rejects.toBeDefined()
    } finally { await client.close() }
    expect((await api("", "/mcp", "POST", {})).status).toBe(401)
    expect((await api(a.key.apiKey, "/mcp", "POST", {}, { origin: "https://attacker.example" })).status).toBe(403)
  })
})
