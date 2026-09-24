import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { GoshenEmailClient } from "@goshenemail/client"
import { run } from "goshenemail-cli"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { apiScopes, manageApiKeys } from "../src/api-keys.js"
import { CustomerStore } from "../src/customer-store.js"
import { developerOperations } from "../src/developer-contract.js"
import { MailService } from "../src/mail-service.js"
import { handleRequest } from "../src/worker.js"
import { fixture, rawMail } from "./support.js"
import { fixtureTriage } from "./triage-fixture.js"

describe("triage through developer clients", () => {
  let f: Awaited<ReturnType<typeof fixture>>, service: MailService
  beforeAll(async () => { f = await fixture(); service = new MailService({ ...f.service, triageAnalyzer: fixtureTriage }) })
  afterAll(async () => { await f?.pg.close() })
  const request: typeof fetch = async (input, init) => handleRequest(new Request(input, init), service)
  async function account(scopes: readonly string[] = apiScopes) {
    const { customer } = await new CustomerStore(f.db, []).invite({ email: `${crypto.randomUUID()}@example.net`, inboxLimit: null })
    const key = await manageApiKeys(f.db, customer, "createApiKey", { name: "Triage", scopes }) as { apiKey: string }
    return { key: key.apiKey, client: new GoshenEmailClient({ apiKey: key.apiKey, baseUrl: service.config.publicUrl, fetch: request }) }
  }

  it("shares filtered results and complete probability metadata across REST, the client, CLI, and hosted MCP", async () => {
    const a = await account(), inbox = await a.client.inboxes.create({ username: "triage-api" })
    const received = await service.receive(inbox.inboxId, rawMail({ subject: "Duplicate charge" }))
    await service.receive(inbox.inboxId, rawMail({ id: "<news@example.net>", subject: "A newsletter" }))
    expect(await a.client.messages.get({ inboxId: inbox.inboxId, messageId: received.messageId })).toHaveProperty("triage.status", "pending")
    await service.processTriage()
    const filter = { inboxId: inbox.inboxId, category: "billing" as const, needsReply: "yes" as const, urgency: "normal" as const }
    const result = await a.client.messages.list(filter)
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toHaveProperty("triage.category.probabilities.billing", 1)
    expect(developerOperations.listMessages.output.safeParse(result).success).toBe(true)
    expect(await a.client.messages.search({ ...filter, query: "invoice" })).toMatchObject({ messages: [expect.objectContaining({ messageId: received.messageId })] })
    const output: string[] = [], errors: string[] = []
    expect(await run(["messages", "list", "--inbox-id", inbox.inboxId, "--category", "billing", "--needs-reply", "yes", "--urgency", "normal"], {
      env: { GOSHENEMAIL_API_KEY: a.key, GOSHENEMAIL_BASE_URL: service.config.publicUrl }, readStdin: async () => "", out: text => output.push(text), error: text => errors.push(text), fetch: request,
    }), errors.join()).toBe(0)
    expect(JSON.parse(output[0]!)).toEqual(result)
    const mcp = new Client({ name: "triage-test", version: "1.0.0" })
    try {
      await mcp.connect(new StreamableHTTPClientTransport(new URL("/mcp", service.config.publicUrl), { fetch: request, requestInit: { headers: { authorization: `Bearer ${a.key}` } } }))
      expect(await mcp.callTool({ name: "list_messages", arguments: filter })).toMatchObject({ structuredContent: { result } })
      expect(await mcp.callTool({ name: "list_threads", arguments: filter })).toMatchObject({ structuredContent: { result: { threads: [expect.objectContaining({ triage: result.messages[0]!.triage })] } } })
    } finally { await mcp.close() }
  })

  it("keeps triage behind inbox ownership and messages:read and rejects invalid filters", async () => {
    const a = await account(), foreign = await account(), restricted = await account(["inboxes:read", "inboxes:write"])
    const inbox = await a.client.inboxes.create({ username: "triage-private" })
    const received = await service.receive(inbox.inboxId, rawMail()); await service.processTriage()
    await expect(foreign.client.messages.list({ inboxId: inbox.inboxId, category: "billing" })).rejects.toMatchObject({ status: 404 })
    await expect(foreign.client.messages.get({ inboxId: inbox.inboxId, messageId: received.messageId })).rejects.toMatchObject({ status: 404 })
    const own = await restricted.client.inboxes.create({ username: "triage-restricted" })
    await expect(restricted.client.messages.list({ inboxId: own.inboxId })).rejects.toMatchObject({ status: 403 })
    for (const query of ["category=bogus", "needsReply=true", "urgency=5", "category=billing&category=support"]) {
      const response = await request(`${service.config.publicUrl}/v1/inboxes/${inbox.inboxId}/messages?${query}`, { headers: { authorization: `Bearer ${a.key}` } })
      expect(response.status, query).toBe(400)
    }
  })
})
