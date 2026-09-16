import { describe, expect, it, vi } from "vitest"
import { cloudflareTransport } from "../src/cloudflare.js"

const config = {
  token: "private-cloudflare-token",
  accountId: "a".repeat(32),
  domains: { "example.com": "b".repeat(32) },
  workerName: "bezalel-email"
}
const sendInput = {
  from: "agent@example.com",
  to: ["customer@example.net"],
  cc: [],
  bcc: [],
  subject: "Hello",
  text: "Hi",
  headers: { "In-Reply-To": "<parent@example.net>" }
}
const response = (result: unknown) => Response.json({ success: true, result })

describe("Cloudflare wire contract", () => {
  const subdomain = "agents.example.com"
  const subdomainConfig = { ...config, domains: { [subdomain]: "b".repeat(32) }, addressRoutingDomains: [subdomain] }
  it("verifies subdomain sending and MX without replacing the apex catch-all", async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response([{ name: subdomain, enabled: true }]))
      .mockResolvedValueOnce(response({ name: "example.com", enabled: true }))
      .mockResolvedValueOnce(Response.json({ Status: 0, Answer: [{ type: 15, data: "10 route1.mx.cloudflare.net." }] }))
    expect(await cloudflareTransport(subdomainConfig, request).verifyDomain(subdomain)).toMatchObject({ status: "VERIFIED" })
    expect(request.mock.calls.some(([url]) => String(url).includes("catch_all"))).toBe(false)
    expect(request.mock.calls[2]?.[1]?.headers).toEqual({ accept: "application/dns-json" })
  })
  it("keeps subdomains pending when MX points elsewhere or the parent is unrelated", async () => {
    for (const parent of ["example.com", "foreign.example"]) {
      const request = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(response([{ name: subdomain, enabled: true }]))
        .mockResolvedValueOnce(response({ name: parent, enabled: true }))
        .mockResolvedValueOnce(Response.json({ Status: 0, Answer: [{ type: 15, data: "10 mx.other.example." }] }))
      expect(await cloudflareTransport(subdomainConfig, request).verifyDomain(subdomain)).toMatchObject({ status: "PENDING" })
    }
  })
  it("creates exact address rules and treats retries as already configured", async () => {
    const address = `owner@${subdomain}`
    const rule = { enabled: true, matchers: [{ type: "literal", field: "to", value: address }], actions: [{ type: "worker", value: [config.workerName] }] }
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response([])).mockResolvedValueOnce(response(rule)).mockResolvedValueOnce(response([rule]))
    const transport = cloudflareTransport(subdomainConfig, request)
    await transport.ensureInboxRoute!(address)
    await transport.ensureInboxRoute!(address)
    const writes = request.mock.calls.filter(([, init]) => init?.method === "POST")
    expect(writes).toHaveLength(1)
    expect(JSON.parse(String(writes[0]?.[1]?.body))).toMatchObject(rule)
    expect(writes[0]?.[0]).toBe(`https://api.cloudflare.com/client/v4/zones/${"b".repeat(32)}/email/routing/rules`)
  })
  it("does not overwrite another Worker's address rules or route unconfigured domains", async () => {
    const address = `owner@${subdomain}`
    const request = vi.fn<typeof fetch>().mockResolvedValue(response([{ enabled: true, matchers: [{ type: "literal", field: "to", value: address }], actions: [{ type: "worker", value: ["original-bezalel"] }] }]))
    const transport = cloudflareTransport(subdomainConfig, request)
    await expect(transport.ensureInboxRoute!(address)).rejects.toMatchObject({ code: "routing_conflict" })
    await transport.ensureInboxRoute!("owner@example.com")
    expect(request).toHaveBeenCalledTimes(1)
  })
  it("finds address rules on later pages before creating a rule", async () => {
    const address = `owner@${subdomain}`
    const unrelated = { enabled: true, matchers: [{ type: "literal", field: "to", value: `other@${subdomain}` }], actions: [{ type: "worker", value: [config.workerName] }] }
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response(Array(50).fill(unrelated)))
      .mockResolvedValueOnce(response([{ ...unrelated, matchers: [{ type: "literal", field: "to", value: address }] }]))
    await cloudflareTransport(subdomainConfig, request).ensureInboxRoute!(address)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true)
  })
  it("checks later pages for conflicts even when an owned rule was already found", async () => {
    const address = `owner@${subdomain}`
    const owned = { enabled: true, matchers: [{ type: "literal", field: "to", value: address }], actions: [{ type: "worker", value: [config.workerName] }] }
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response(Array(50).fill(owned)))
      .mockResolvedValueOnce(response([{ ...owned, actions: [{ type: "worker", value: ["other-worker"] }] }]))
    await expect(cloudflareTransport(subdomainConfig, request).ensureInboxRoute!(address)).rejects.toMatchObject({ code: "routing_conflict" })
    expect(request).toHaveBeenCalledTimes(2)
  })
  it("maps file attachments to the documented Cloudflare fields", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(response({ message_id: "sent", delivered: sendInput.to, queued: [], permanent_bounces: [] }))
    await cloudflareTransport(config, request).send({ ...sendInput, attachments: [{ filename: "report.txt", contentType: "text/plain", content: "cmVwb3J0" }] })
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body))
    expect(body.attachments).toEqual([{ filename: "report.txt", type: "text/plain", content: "cmVwb3J0", disposition: "attachment" }])
  })
  it("sends through the documented API and retains Cloudflare's message ID", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({
          message_id: "<sent@cloudflare.net>",
          delivered: sendInput.to,
          queued: [],
          permanent_bounces: [],
          suppressed_recipients: []
        })
      )
    const result = await cloudflareTransport(config, request).send(sendInput)
    expect(result.messageId).toBe("<sent@cloudflare.net>")
    expect(request).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email/sending/send`,
      expect.objectContaining({
        method: "POST",
        redirect: "manual",
        body: JSON.stringify(sendInput),
        headers: expect.objectContaining({
          authorization: `Bearer ${config.token}`
        })
      })
    )
  })
  it("requires sending, receiving, and a route to this Worker before declaring readiness", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([{ name: "example.com", enabled: true }]))
      .mockResolvedValueOnce(response({ name: "example.com", enabled: true }))
      .mockResolvedValueOnce(
        response({
          enabled: true,
          actions: [{ type: "worker", value: ["some-other-worker"] }]
        })
      )
    expect(
      await cloudflareTransport(config, request).verifyDomain("example.com")
    ).toMatchObject({ status: "PENDING" })
    await expect(
      cloudflareTransport(config, request).verifyDomain("foreign.example")
    ).rejects.toMatchObject({ code: "domain_not_configured" })
    expect(request).toHaveBeenCalledTimes(3)
  })
  it("marks successful responses without message IDs as uncertain", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({ delivered: sendInput.to, queued: [], permanent_bounces: [] })
      )
    await expect(
      cloudflareTransport(config, request).send(sendInput)
    ).rejects.toMatchObject({ code: "delivery_uncertain", transient: true })
  })
  it("rejects provider redirects without forwarding credentials or accepting a receipt", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: "https://attacker.example/collect" }
      })
    )
    await expect(
      cloudflareTransport(config, request).send(sendInput)
    ).rejects.toMatchObject({ code: "provider_error", transient: false })
    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0]![1]?.redirect).toBe("manual")
  })
  it("redacts provider errors and distinguishes rate limits from uncertain sends", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("secret provider data", { status: 429 })
      )
      .mockResolvedValueOnce(
        new Response("secret provider data", { status: 500 })
      )
    await expect(
      cloudflareTransport(config, request).send(sendInput)
    ).rejects.toMatchObject({
      message: "Cloudflare email request failed (429)",
      code: "rate_limited",
      transient: false
    })
    await expect(
      cloudflareTransport(config, request).send(sendInput)
    ).rejects.toMatchObject({ transient: true })
  })
})
