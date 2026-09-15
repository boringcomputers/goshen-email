import { afterEach, describe, expect, it } from "vitest"
import { handleRequest } from "../src/worker.js"
import { fixture, rawMail } from "./support.js"

let f: Awaited<ReturnType<typeof fixture>>
afterEach(async () => { await f?.pg.close() })

describe("operator test mailboxes", () => {
  it("keeps normal and test RPCs in separate partitions", async () => {
    f = await fixture()
    const rpc = async (testing: boolean, operation: string, input: unknown) => {
      const response = await handleRequest(new Request(
        `https://mail.example.com/${testing ? "test-rpc" : "rpc"}/${operation}`,
        { method: "POST", headers: { authorization: `Bearer ${f.service.config.apiToken}` }, body: JSON.stringify(input) }
      ), f.service)
      return { status: response.status, body: await response.json() }
    }
    expect((await rpc(false, "createInbox", { username: "regular" })).status).toBe(200)
    expect((await rpc(true, "createInbox", { username: "testing" })).status).toBe(200)
    expect((await rpc(false, "listInboxes", {})).body).toMatchObject({ result: { inboxes: [{ address: "regular@example.com" }] } })
    expect((await rpc(true, "listInboxes", {})).body).toMatchObject({ result: { inboxes: [{ address: "testing@example.com" }] } })
    expect((await rpc(false, "inboxQuota", {})).body).toEqual({ result: { count: 1, limit: null } })
    for (const [testing, inboxId] of [[false, "testing@example.com"], [true, "regular@example.com"]] as const) {
      expect((await rpc(testing, "listMessages", { inboxId })).status).toBe(404)
      expect((await rpc(testing, "send", { inboxId, to: ["you@example.net"], text: "test", idempotencyKey: "key" })).status).toBe(404)
      expect((await rpc(testing, "deleteInbox", { inboxId })).body).toEqual({ result: false })
      expect((await rpc(testing, "inboxExists", { inboxId })).body).toEqual({ result: false })
    }
    expect(f.send).not.toHaveBeenCalled()
    expect((await rpc(false, "inboxExists", { inboxId: "regular@example.com" })).body).toEqual({ result: true })
    expect((await rpc(true, "inboxExists", { inboxId: "testing@example.com" })).body).toEqual({ result: true })
  })

  it("receives test mail and protects its text without scheduling agent events", async () => {
    f = await fixture()
    await f.service.execute("createInbox", { username: "agent" }, true)
    await f.service.acceptIncoming("agent@example.com", rawMail())
    await f.service.processIncoming()
    const page = await f.service.execute("listMessages", { inboxId: "agent@example.com" }, true)
    expect(page).toMatchObject({ messages: [{ subject: "Invoice question" }] })
    expect(await f.service.store.pendingEvents()).toEqual([])
    const result = await f.service.execute("send", { inboxId: "agent@example.com", to: ["you@example.net"], text: "hello", idempotencyKey: "test-key" }, true)
    const replay = await f.service.execute("send", { inboxId: "agent@example.com", to: ["you@example.net"], text: "hello", idempotencyKey: "test-key" }, true)
    expect(replay).toMatchObject({ ...result as object, deduplicated: true })
    expect(f.send).toHaveBeenCalledOnce()
  })

  it("requires the Worker bearer on test RPCs", async () => {
    f = await fixture()
    const response = await handleRequest(new Request("https://mail.example.com/test-rpc/createInbox", {
      method: "POST", body: JSON.stringify({ username: "not-authorized" })
    }), f.service)
    expect(response.status).toBe(401)
    expect(await f.service.store.listInboxes(true)).toEqual([])
  })
})
