import { z } from "zod"
import {
  MailError,
  type DeliveryResult,
  type DomainInfo,
  type Transport
} from "./contracts.js"

const delivery = z.object({
  message_id: z.string().min(1),
  delivered: z.array(z.string()),
  queued: z.array(z.string()),
  permanent_bounces: z.array(z.string()),
  suppressed_recipients: z.array(z.string()).default([])
})
const sendingDomain = z.object({ name: z.string(), enabled: z.boolean() })
const routing = z.object({ enabled: z.boolean(), name: z.string() })
const catchAll = z.object({
  enabled: z.boolean(),
  actions: z.array(
    z.object({ type: z.string(), value: z.array(z.string()).optional() })
  )
})

export const cloudflareTransport = (
  config: {
    token: string
    accountId: string
    domains: Record<string, string>
    workerName: string
  },
  request: typeof fetch = fetch
): Transport => {
  const call = async (path: string, body?: unknown): Promise<unknown> => {
    if (!config.token) throw new MailError("Cloudflare email access is not configured", "not_configured", 503)
    let response: Response
    try {
      response = await request(`https://api.cloudflare.com/client/v4${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json"
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(25_000),
        redirect: "manual"
      })
    } catch {
      throw new MailError(
        "Cloudflare request did not complete; delivery may have occurred",
        "provider_unavailable",
        502,
        body !== undefined
      )
    }
    // A 429 confirms that no send was accepted. Keep that distinct from an
    // uncertain delivery so the reservation can be retried after the limit clears.
    if (!response.ok)
      throw new MailError(
        `Cloudflare email request failed (${response.status})`,
        response.status === 429 ? "rate_limited" : "provider_error",
        response.status === 429 ? 429 : 502,
        body !== undefined && response.status >= 500
      )
    const parsed = z
      .object({ success: z.literal(true), result: z.unknown() })
      .safeParse(await response.json().catch(() => null))
    if (!parsed.success)
      throw new MailError(
        "Cloudflare returned an unreadable response",
        "provider_response",
        502,
        body !== undefined
      )
    return parsed.data.result
  }
  return {
    async send(input): Promise<DeliveryResult> {
      const { trackingId: _, ...message } = input
      const parsed = delivery.safeParse(
        await call(
          `/accounts/${encodeURIComponent(config.accountId)}/email/sending/send`,
          { ...message, ...(input.attachments?.length ? { attachments: input.attachments.map((file) => ({
            filename: file.filename, type: file.contentType, content: file.content, disposition: "attachment"
          })) } : {}) }
        )
      )
      if (!parsed.success)
        throw new MailError(
          "Cloudflare accepted the send but its receipt is unreadable",
          "delivery_uncertain",
          502,
          true
        )
      return {
        messageId: parsed.data.message_id,
        delivered: parsed.data.delivered,
        queued: parsed.data.queued,
        bounced: parsed.data.permanent_bounces,
        suppressed: parsed.data.suppressed_recipients
      }
    },
    async verifyDomain(domain): Promise<DomainInfo> {
      const zone = config.domains[domain]
      if (!zone)
        throw new MailError(
          "Onboard this domain in Cloudflare and add its zone ID to EMAIL_DOMAINS",
          "domain_not_configured",
          422
        )
      const base = `/zones/${encodeURIComponent(zone)}`
      const [sendValue, routeValue, ruleValue] = await Promise.all([
        call(`${base}/email/sending/subdomains`),
        call(`${base}/email/routing`),
        call(`${base}/email/routing/rules/catch_all`)
      ])
      const send = z.array(sendingDomain).safeParse(sendValue)
      const route = routing.safeParse(routeValue)
      const rule = catchAll.safeParse(ruleValue)
      if (!send.success || !route.success || !rule.success)
        throw new MailError(
          "Cloudflare returned unreadable domain settings",
          "provider_response",
          502
        )
      const ready =
        send.data.some((d) => d.name === domain && d.enabled) &&
        route.data.enabled &&
        route.data.name === domain &&
        rule.data.enabled &&
        rule.data.actions.some(
          (a) => a.type === "worker" && a.value?.includes(config.workerName)
        )
      return {
        domainId: domain,
        domain,
        status: ready ? "VERIFIED" : "PENDING",
        records: []
      }
    }
  }
}
