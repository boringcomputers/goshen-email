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
