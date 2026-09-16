import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { generateKeyPair, SignJWT } from "jose"
import { handleRequest } from "../src/worker.js"
import { accessConfig, type AccessConfig } from "../src/access-auth.js"
import { migrate } from "../src/database.js"
import { fixture, rawMail, cleanProtection } from "./support.js"

const access: AccessConfig = { teamDomain: "fixture.cloudflareaccess.com", audience: "a".repeat(64), adminEmails: ["owner@example.net"] }
const keys = await generateKeyPair("RS256")
const token = (email: string, claims = {}) => new SignJWT({ email, type: "app", ...claims })
  .setProtectedHeader({ alg: "RS256" }).setIssuer(`https://${access.teamDomain}`)
  .setAudience(access.audience).setSubject(email).setIssuedAt().setExpirationTime("1h").sign(keys.privateKey)
const tokens = { owner: await token("owner@example.net"), a: await token("a@example.net"), b: await token("b@example.net") }

describe("Customer dashboard authorization", () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeAll(async () => { f = await fixture() })
  afterAll(async () => { await f.pg.close() })
  beforeEach(async () => {
    await f.pg.exec("truncate mail.customers, mail.inboxes, mail.domains cascade")
    f.send.mockClear(); f.request.mockClear()
  })
  const request = (operation: string, input: unknown = {}, jwt = tokens.owner, prefix = "/dashboard-rpc/") =>
    handleRequest(new Request(`https://mail.example.com${prefix}${operation}`, { method: "POST",
      headers: { authorization: `Bearer ${jwt}` }, body: JSON.stringify(input) }), f.service, access, async () => keys.publicKey)
  const result = async (operation: string, input = {}, jwt = tokens.owner) => {
    const response = await request(operation, input, jwt)
    const body = await response.json() as any
    expect(response.status, JSON.stringify(body)).toBe(200)
    return body.result
  }
  const invite = (email: string, inboxLimit = 5) => result("inviteCustomer", { email, inboxLimit })
  const customers = async () => { await invite("a@example.net"); await invite("b@example.net") }
  const inbox = (name: "a" | "b") => result("createInbox", { username: name }, tokens[name])

  it("preserves existing routed inboxes and pending reservations when migrations rerun", async () => {
    await customers(); const a = await inbox("a")
    await f.pg.exec("alter table mail.customer_inboxes drop column route_ready")
    await migrate(f.db)
    expect((await result("listInboxes", {}, tokens.a)).inboxes[0]).toMatchObject({ inboxId: a.inboxId, deliveryStatus: "ready" })
    const route = f.service.transport.ensureInboxRoute
    f.service.transport.ensureInboxRoute = vi.fn().mockRejectedValue(new Error("routing unavailable"))
    try {
      expect((await request("createInbox", { username: "pending" }, tokens.a)).status).toBe(503)
      await migrate(f.db)
      const rows = (await result("listInboxes", {}, tokens.a)).inboxes
      expect(rows.find((i: any) => i.inboxId === a.inboxId).deliveryStatus).toBe("ready")
      expect(rows.find((i: any) => i.inboxId.startsWith("pending@")).deliveryStatus).toBe("pending")
    } finally { f.service.transport.ensureInboxRoute = route }
  })

  it("requires a verified invitation and derives the owner role only from server configuration", async () => {
    expect((await request("session", {}, tokens.a)).status).toBe(403)
    expect((await result("session")).customer.role).toBe("admin")
    await invite("a@example.net")
    expect((await result("session", { role: "admin", email: access.adminEmails[0] }, tokens.a)).customer.role).toBe("customer")
    for (const op of ["inviteCustomer", "listCustomers", "setCustomerAccess", "createDomain", "listDomains", "verifyDomain", "deleteDomain"])
      expect((await request(op, {}, tokens.a)).status, op).toBe(403)
    expect((await request("inviteCustomer", { email: "c@example.net", role: "admin" })).status).toBe(400)
    expect((await request("session", {}, await new SignJWT({ email: "a@example.net", type: "app" }).setProtectedHeader({ alg: "RS256" })
      .setIssuer(`https://${access.teamDomain}`).setAudience(access.audience).setSubject("changed-subject").setIssuedAt().setExpirationTime("1h").sign(keys.privateKey))).status).toBe(403)
  })

  it("rejects forged, expired, incorrectly scoped, incomplete, and service JWTs before accessing customer records", async () => {
    const cases = ["", tokens.owner + "x", await token("owner@example.net", { type: "service" })]
    for (const overrides of [{ iss: "https://attacker.example" }, { aud: "b".repeat(64) }, { exp: 1 }, { email: null }, { sub: null }]) {
      cases.push(await new SignJWT({ email: "owner@example.net", type: "app", sub: "owner@example.net",
        iss: `https://${access.teamDomain}`, aud: access.audience, iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600, ...overrides } as any).setProtectedHeader({ alg: "RS256" }).sign(keys.privateKey))
    }
    cases.push(await new SignJWT({ email: "owner@example.net" }).setProtectedHeader({ alg: "HS256" }).sign(new Uint8Array(32)))
    for (const jwt of cases) expect((await request("session", {}, jwt)).status).toBe(401)
    expect(await f.db.query("select * from mail.customers")).toHaveLength(0)
    expect(accessConfig({})).toBeUndefined()
    expect(accessConfig({ DASHBOARD_ADMIN_EMAILS: "owner@example.net" })).toBeUndefined()
    expect(() => accessConfig({ ACCESS_TEAM_DOMAIN: "evil.example" })).toThrow()
    expect(() => accessConfig({ ACCESS_TEAM_DOMAIN: access.teamDomain, DASHBOARD_ADMIN_EMAILS: "owner@example.net" })).toThrow()
    expect(() => accessConfig({ ACCESS_AUD: access.audience, DASHBOARD_ADMIN_EMAILS: "owner@example.net" })).toThrow()
    expect(accessConfig({ ACCESS_TEAM_DOMAIN: access.teamDomain, ACCESS_AUD: access.audience, DASHBOARD_ADMIN_EMAILS: "OWNER@example.net" })).toEqual(access)
  })

  it("isolates two customers across reads, writes, sends, credentials, and all mailbox operations", async () => {
    await customers(); const a = await inbox("a"), b = await inbox("b")
    expect((await result("listInboxes", {}, tokens.a)).inboxes.map((i: any) => i.inboxId)).toEqual([a.inboxId])
    expect((await result("listInboxes", {}, tokens.b)).inboxes.map((i: any) => i.inboxId)).toEqual([b.inboxId])
    expect((await result("listInboxes")).inboxes).toHaveLength(2)
    expect(await result("inboxQuota", { inboxId: a.inboxId }, tokens.a)).toEqual({ count: 1, limit: 5 })
    for (const op of ["deleteInbox", "inboxQuota", "listMessages", "getMessage", "listThreads", "getThread", "reviewThread",
      "searchMessages", "send", "reply", "updateMessageLabels", "updateThreadLabels", "getAttachment", "releaseQuarantine", "getCredentials", "rotateCredentials", "finishInboxSetup", "setupStatus"])
      expect((await request(op, { inboxId: b.inboxId }, tokens.a)).status, op).toBe(404)
    expect(f.send).not.toHaveBeenCalled()
    const mail = await f.service.receive(b.inboxId, rawMail({ attachment: true }), cleanProtection())
    const message = await result("getMessage", { inboxId: b.inboxId, messageId: mail.messageId }, tokens.b)
    for (const op of ["getMessage", "updateMessageLabels", "getAttachment", "reply", "releaseQuarantine"])
      expect((await request(op, { inboxId: a.inboxId, messageId: mail.messageId, attachmentId: message.attachments[0].attachmentId, text: "hello", idempotencyKey: "foreign" }, tokens.a)).status, op).toBe(404)
    expect((await request("getThread", { inboxId: a.inboxId, threadId: mail.threadId }, tokens.a)).status).toBe(404)
    expect((await request("createInbox", { username: "b" }, tokens.a)).status).toBe(409)
    expect((await request("createInbox", { username: "x", domain: "other.example" }, tokens.a)).status).toBe(403)
    expect((await request("createInbox", { username: "x", customerId: "forged" }, tokens.a)).status).toBe(400)
    expect((await request("listInboxes", {}, tokens.a, "/rpc/")).status).toBe(401)
    const credentials = await result("getCredentials", { inboxId: a.inboxId }, tokens.a)
    expect((await request("getInbox", {}, credentials.apiKey, "/inbox-rpc/")).status).toBe(200)
    expect((await request("getInbox", { inboxId: b.inboxId }, credentials.apiKey, "/inbox-rpc/")).status).toBe(403)
  })

  it("confirms only a successful mailbox-key connection and resets after rotation", async () => {
    await customers(); const a = await inbox("a")
    const status = () => result("setupStatus", { inboxId: a.inboxId }, tokens.a)
    expect(a.setupAvailable).toBe(true)
    expect(await status()).toEqual({ inboxId: a.inboxId, deliveryReady: true, connectedAt: null, receivedAt: null })
    const first = await result("getCredentials", { inboxId: a.inboxId }, tokens.a)
    await result("listThreads", { inboxId: a.inboxId }, tokens.a)
    expect((await status()).connectedAt).toBeNull()
    expect((await request("getInbox", {}, first.apiKey + "x", "/inbox-rpc/")).status).toBe(401)
    expect((await request("getInbox", { inboxId: "wrong@example.com" }, first.apiKey, "/inbox-rpc/")).status).toBe(403)
    expect((await status()).connectedAt).toBeNull()
    expect((await request("getInbox", {}, first.apiKey, "/inbox-rpc/")).status).toBe(200)
    const connected = await status()
    expect(connected.connectedAt).toEqual(expect.any(String))
    expect(JSON.stringify(connected)).not.toContain(first.apiKey)
    expect((await request("getInbox", {}, first.apiKey, "/inbox-rpc/")).status).toBe(200)
    expect((await status()).connectedAt).toBe(connected.connectedAt)
    const next = await result("rotateCredentials", { inboxId: a.inboxId }, tokens.a)
    expect((await status()).connectedAt).toBeNull()
    expect((await request("getInbox", {}, first.apiKey, "/inbox-rpc/")).status).toBe(401)
    expect((await status()).connectedAt).toBeNull()
    expect((await request("getInbox", {}, next.apiKey, "/inbox-rpc/")).status).toBe(200)
    expect((await status()).connectedAt).toEqual(expect.any(String))
    await migrate(f.db)
    expect((await status()).connectedAt).toEqual(expect.any(String))
  })

  it("resumes reserved addresses and confirms incoming mail without exposing quarantined messages", async () => {
    await customers()
    const route = f.service.transport.ensureInboxRoute
    f.service.transport.ensureInboxRoute = vi.fn().mockRejectedValue(new Error("routing unavailable"))
    let a: any
    try {
      expect((await request("createInbox", { username: "pending" }, tokens.a)).status).toBe(503)
      a = (await result("listInboxes", {}, tokens.a)).inboxes[0]
      expect(await result("setupStatus", { inboxId: a.inboxId }, tokens.a)).toMatchObject({ deliveryReady: false, connectedAt: null, receivedAt: null })
    } finally { f.service.transport.ensureInboxRoute = route }
    await result("finishInboxSetup", { inboxId: a.inboxId }, tokens.a)
    expect((await result("listInboxes", {}, tokens.a)).inboxes).toHaveLength(1)
    expect((await result("setupStatus", { inboxId: a.inboxId }, tokens.a)).deliveryReady).toBe(true)
    await f.service.receive(a.inboxId, rawMail(), { ...cleanProtection(), status: "quarantined", reasons: ["spam"] })
    expect((await result("setupStatus", { inboxId: a.inboxId }, tokens.a)).receivedAt).toBeNull()
    await f.service.receive(a.inboxId, rawMail({ id: "<clean-setup@example.net>" }), cleanProtection())
    const status = await result("setupStatus", { inboxId: a.inboxId }, tokens.a)
    expect(status.receivedAt).toEqual(expect.any(String))
    expect(Object.keys(status).sort()).toEqual(["connectedAt", "deliveryReady", "inboxId", "receivedAt"])
  })

  it("revokes dashboard access and keys, and re-enabling never restores old keys", async () => {
    const { customer } = await invite("a@example.net")
    const a = await inbox("a")
    const first = await result("getCredentials", { inboxId: a.inboxId }, tokens.a)
    const rotated = await result("rotateCredentials", { inboxId: a.inboxId }, tokens.a)
    expect((await request("getInbox", {}, first.apiKey, "/inbox-rpc/")).status).toBe(401)
    await result("setCustomerAccess", { customerId: customer.id, enabled: false })
    expect((await request("session", {}, tokens.a)).status).toBe(403)
    expect((await request("getInbox", {}, rotated.apiKey, "/inbox-rpc/")).status).toBe(401)
    await result("setCustomerAccess", { customerId: customer.id, enabled: true })
    expect((await request("session", {}, tokens.a)).status).toBe(200)
    expect((await request("getInbox", {}, rotated.apiKey, "/inbox-rpc/")).status).toBe(401)
    const owner = (await result("session")).customer
    expect((await request("setCustomerAccess", { customerId: owner.id, enabled: false })).status).toBe(403)
  })

  it("atomically limits concurrent inbox creation, retries safely, and keeps customer mail out of the shared webhook", async () => {
    await invite("a@example.net", 1)
    const responses = await Promise.all(["one", "two"].map((username) => request("createInbox", { username }, tokens.a)))
    expect(responses.map((r) => r.status).sort()).toEqual([200, 422])
    const a = (await result("listInboxes", {}, tokens.a)).inboxes[0]
    expect((await result("createInbox", { username: a.inboxId.split("@")[0] }, tokens.a)).inboxId).toBe(a.inboxId)
    expect(await f.db.query("select * from mail.customer_inboxes")).toHaveLength(1)
    await f.service.receive(a.inboxId, rawMail(), cleanProtection())
    await f.service.flushEvents()
    expect(f.request).not.toHaveBeenCalled()
    await migrate(f.db)
    expect((await result("listInboxes", {}, tokens.a)).inboxes).toHaveLength(1)
  })

  it("reserves ownership before routing and lets the owner finish failed setup without using another slot", async () => {
    await invite("a@example.net", 1)
    const route = vi.fn().mockImplementation(async (address: string) => {
      expect(await f.db.query("select 1 from mail.customer_inboxes c join mail.inboxes i on i.id=c.inbox_id where i.address=$1", [address])).toHaveLength(1)
      throw new Error("provider unavailable")
    })
    f.service.transport.ensureInboxRoute = route
    try {
      const response = await request("createInbox", { username: "a" }, tokens.a)
      expect(response.status).toBe(503)
      expect((await response.json() as any).error.message).toContain("reserved")
      const pending = (await result("listInboxes", {}, tokens.a)).inboxes
      expect(pending).toMatchObject([{ inboxId: "a@example.com", deliveryStatus: "pending" }])
      expect((await request("createInbox", { username: "overflow" }, tokens.a)).status).toBe(422)
      expect(route).toHaveBeenCalledTimes(1)
      route.mockResolvedValue(undefined)
      expect(await result("finishInboxSetup", { inboxId: "a@example.com" })).toMatchObject({ deliveryStatus: "ready" })
      expect((await inbox("a")).deliveryStatus).toBe("ready")
      expect(await f.db.query("select * from mail.customer_inboxes")).toHaveLength(1)
      expect((await result("listInboxes", {}, tokens.a)).inboxes).toMatchObject([{ deliveryStatus: "ready" }])
    } finally { delete f.service.transport.ensureInboxRoute }
  })

  it("never creates a route for the loser of a capacity race or an address conflict", async () => {
    await invite("a@example.net", 1); await invite("b@example.net", 1)
    const routes: string[] = []
    f.service.transport.ensureInboxRoute = async (address) => {
      expect(await f.db.query("select 1 from mail.customer_inboxes c join mail.inboxes i on i.id=c.inbox_id where i.address=$1", [address])).toHaveLength(1)
      routes.push(address)
    }
    try {
      const responses = await Promise.all(["one", "two"].map((username) => request("createInbox", { username }, tokens.a)))
      expect(responses.map((r) => r.status).sort()).toEqual([200, 422])
      expect(routes).toHaveLength(1)
      const winner = routes[0]!
      expect((await request("createInbox", { username: winner.split("@")[0] }, tokens.b)).status).toBe(409)
      expect(routes).toHaveLength(1)
      expect((await result("listInboxes", {}, tokens.a)).inboxes).toMatchObject([{ inboxId: winner }])
    } finally { delete f.service.transport.ensureInboxRoute }
  })

  it("lets configured owners create more than five inboxes while customers keep their limits", async () => {
    expect((await result("session")).customer.inboxLimit).toBeNull()
    for (let i = 0; i < 7; i++) await result("createInbox", { username: `owner-${i}` })
    expect((await result("listInboxes")).inboxes).toHaveLength(7)
    await invite("a@example.net", 1)
    await inbox("a")
    expect((await request("createInbox", { username: "a-extra", p_owner: true }, tokens.a)).status).toBe(400)
    expect((await request("createInbox", { username: "a-extra" }, tokens.a)).status).toBe(422)
    expect((await result("listInboxes", {}, tokens.a)).inboxes).toHaveLength(1)
  })
})
