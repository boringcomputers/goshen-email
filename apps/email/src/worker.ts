import { handleClientAdmin, handleInboxRequest } from "./mail-clients.js"
import { ingestDelivery } from "./delivery.js"
import { z } from "zod"
import { cloudflareTransport } from "./cloudflare.js"
import {
  domainName,
  inputs,
  MailError,
  type MailConfig,
  type Operation
} from "./contracts.js"
import { postgresDatabase } from "./database.js"
import { MailService } from "./mail-service.js"
import { MailboxStore } from "./mailbox-store.js"
import { CustomDomains, type GatewayConfig } from "./custom-domains.js"
import { gatewayScanner, gatewayTransport, handleGatewayRequest } from "./gateway.js"
import {
  equalSecret,
  readBytes,
  signDownload,
  validateUrl
} from "./security.js"

export interface Env {
  HYPERDRIVE: Hyperdrive
  MAIL_API_TOKEN: string
  MAIL_WEBHOOK_SECRET: string
  CLOUDFLARE_API_TOKEN: string
  CLOUDFLARE_ACCOUNT_ID: string
  EMAIL_DOMAINS: string
  DEFAULT_EMAIL_DOMAIN: string
  PUBLIC_EMAIL_URL: string
  MAIL_EVENTS_URL?: string
  BEZALEL_EVENTS_URL?: string
  WORKER_NAME: string
  MAIL_OBJECTS: R2Bucket
  MAIL_GATEWAY_URL?: string
  MAIL_GATEWAY_TOKEN?: string
  MAIL_GATEWAY_HOSTNAME?: string
  MAIL_GATEWAY_IPV4?: string
  MAIL_DOMAIN_ENCRYPTION_KEY?: string
  MAIL_INBOUND_SCAN_ENABLED?: string
  MAIL_FEEDBACK_SIGNERS?: string
}

const configuration = z.object({
  HYPERDRIVE: z.object({ connectionString: z.string().min(1) }),
  MAIL_API_TOKEN: z.string().min(32),
  MAIL_WEBHOOK_SECRET: z.string().regex(/^whsec_[A-Za-z0-9+/]{32,}={0,2}$/),
  CLOUDFLARE_API_TOKEN: z.string().min(1),
  CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/),
  DEFAULT_EMAIL_DOMAIN: domainName,
  PUBLIC_EMAIL_URL: z.url(),
  MAIL_EVENTS_URL: z.url().optional(),
  BEZALEL_EVENTS_URL: z.url().optional(),
  WORKER_NAME: z.string().min(1)
})

export const serviceFor = (env: Env): MailService => {
  const parsed = configuration.safeParse(env)
  let domains
  try {
    domains = z
      .record(domainName, z.string().regex(/^[a-f0-9]{32}$/))
      .safeParse(JSON.parse(env.EMAIL_DOMAINS))
  } catch {
    /* Report one redacted configuration error below. */
  }
  if (
    !parsed.success ||
    !domains?.success ||
    !domains.data[env.DEFAULT_EMAIL_DOMAIN]
  )
    throw new MailError(
      "Email Worker configuration is incomplete",
      "not_configured",
      503
    )
  validateUrl(env.PUBLIC_EMAIL_URL)
  const eventsUrl = env.MAIL_EVENTS_URL ?? env.BEZALEL_EVENTS_URL
  if (eventsUrl) validateUrl(eventsUrl)
  const config: MailConfig = {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    defaultDomain: env.DEFAULT_EMAIL_DOMAIN,
    domains: domains.data,
    publicUrl: env.PUBLIC_EMAIL_URL,
    eventsUrl,
    apiToken: env.MAIL_API_TOKEN,
    webhookSecret: env.MAIL_WEBHOOK_SECRET
  }
  const store = new MailboxStore(postgresDatabase(env.HYPERDRIVE.connectionString))
  let gateway: GatewayConfig | undefined
  if (env.MAIL_GATEWAY_URL) {
    const result = z.object({
      url: z.url().refine((value) => new URL(value).protocol === "https:" && !new URL(value).username && !new URL(value).password),
      token: z.string().min(32), hostname: domainName, ipv4: z.ipv4(),
      encryptionKey: z.string().regex(/^[a-f0-9]{64}$/),
      feedbackSigners: z.array(domainName).max(20),
    }).safeParse({ url: env.MAIL_GATEWAY_URL, token: env.MAIL_GATEWAY_TOKEN,
      hostname: env.MAIL_GATEWAY_HOSTNAME, ipv4: env.MAIL_GATEWAY_IPV4, encryptionKey: env.MAIL_DOMAIN_ENCRYPTION_KEY,
      feedbackSigners: (env.MAIL_FEEDBACK_SIGNERS ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean) })
    if (!result.success) throw new MailError("Mail gateway configuration is incomplete", "not_configured", 503)
    gateway = result.data
  }
  const customDomains = gateway ? new CustomDomains(store.db, gateway, Object.keys(domains.data)) : undefined
  if (env.MAIL_INBOUND_SCAN_ENABLED && !["true", "false"].includes(env.MAIL_INBOUND_SCAN_ENABLED))
    throw new MailError("MAIL_INBOUND_SCAN_ENABLED must be true or false", "not_configured", 503)
  if (env.MAIL_INBOUND_SCAN_ENABLED === "true" && !gateway)
    throw new MailError("Incoming mail scanning requires the gateway", "not_configured", 503)
  const transport = cloudflareTransport({
    token: env.CLOUDFLARE_API_TOKEN, accountId: env.CLOUDFLARE_ACCOUNT_ID,
    domains: domains.data, workerName: env.WORKER_NAME
  })
  return new MailService({
    config,
    store,
    objects: env.MAIL_OBJECTS,
    transport: customDomains ? gatewayTransport(transport, customDomains) : transport,
    customDomains,
    ...(env.MAIL_INBOUND_SCAN_ENABLED === "true" && gateway ? { scanner: gatewayScanner(gateway) } : {})
  })
}

const json = (data: unknown, status = 200): Response =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } })

export const handleRequest = async (
  request: Request,
  service: MailService
): Promise<Response> => {
  const url = new URL(request.url)
  try {
    if (request.method === "GET" && url.pathname === "/healthz")
      return json({ status: "ok", service: "bezalel-email" })
    if (request.method === "GET" && url.pathname.startsWith("/attachments/")) {
      const match =
        /^\/attachments\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/.exec(
          url.pathname
        )
      const expires = url.searchParams.get("expires") ?? ""
      const now = Math.floor(Date.now() / 1000)
      if (
        !match ||
        !/^\d{10}$/.test(expires) ||
        Number(expires) <= now ||
        Number(expires) > now + 300 ||
        !equalSecret(
          url.searchParams.get("signature") ?? "",
          signDownload(service.config.webhookSecret, url.pathname, expires)
        )
      )
        return json({ error: { message: "Invalid download link" } }, 401)
      const [row] = await service.store.db.query<{
        data: {
          attachments: Array<{
            attachmentId: string
            objectKey: string
            filename: string
          }>
        }
      }>(
        `select m.data from mail.messages m join mail.inboxes i on i.id = m.inbox_id
          where m.inbox_id = $1 and m.id = $2 and i.deleted_at is null
          and coalesce(m.protection->>'status', '') <> 'quarantined'
          and coalesce(m.protection->'antivirus'->>'status', 'clean') = 'clean'`,
        [match[1], match[2]]
      )
      const attachment = row?.data.attachments.find(
        (a) => a.attachmentId === match[3]
      )
      const object = attachment
        ? await service.objects.get(attachment.objectKey)
        : null
      if (!object || !attachment)
        return json({ error: { message: "Attachment not found" } }, 404)
      return new Response(object.body, {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename).replace(/'/g, "%27")}`,
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          "cache-control": "private, no-store"
        }
      })
    }
    if (url.pathname.startsWith("/clients/")) return await handleClientAdmin(request, service)
    if (url.pathname.startsWith("/inbox-rpc/")) return await handleInboxRequest(request, service)
    const authorization = request.headers.get("authorization") ?? ""
    if (url.pathname.startsWith("/gateway/")) return await handleGatewayRequest(request, service)
    if (!equalSecret(authorization, `Bearer ${service.config.apiToken}`))
      return json(
        {
          error: {
            message: "Unauthorized",
            code: "unauthorized",
            transient: false
          }
        },
        401
      )
    const testing = url.pathname.startsWith("/test-rpc/")
    const operation = url.pathname.replace(/^\/(?:test-)?rpc\//, "")
    if (
      request.method !== "POST" ||
      (!url.pathname.startsWith("/rpc/") && !testing) ||
      !Object.hasOwn(inputs, operation)
    )
      return json(
        {
          error: { message: "Not found", code: "not_found", transient: false }
        },
        404
      )
    const bytes = await readBytes(request.body, 5 * 1024 * 1024)
    let input: unknown
    try {
      input = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new MailError("Invalid JSON")
    }
    const result = await service.execute(operation as Operation, input, testing)
    return json({ result })
  } catch (error) {
    if (error instanceof MailError)
      return json(
        {
          error: {
            message: error.message,
            code: error.code,
            transient: error.transient
          }
        },
        error.status
      )
    return json(
      {
        error: {
          message: "Email operation failed",
          code: "internal_error",
          transient: true
        }
      },
      500
    )
  }
}

export async function consumeDeliveryBatch(
  batch: MessageBatch<unknown>,
  store: MailboxStore,
  config: MailConfig,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      await ingestDelivery(store, config, message.body)
      message.ack()
    } catch {
      message.retry({ delaySeconds: 60 })
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, serviceFor(env))
    } catch {
      return json(
        {
          error: {
            message: "Email Worker is not configured",
            code: "not_configured",
            transient: false
          }
        },
        503
      )
    }
  },
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const service = serviceFor(env)
    try {
      const raw = await readBytes(message.raw, 25 * 1024 * 1024)
      await service.acceptIncoming(message.to, raw, message.from)
      ctx.waitUntil(service.processIncoming())
    } catch (error) {
      if (error instanceof MailError && [404, 413].includes(error.status)) {
        message.setReject(
          error.status === 404 ? "Unknown recipient" : "Message too large"
        )
        return
      }
      throw new Error("Email could not be stored")
    }
  },
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    const service = serviceFor(env)
    await consumeDeliveryBatch(batch, service.store, service.config)
    ctx.waitUntil(service.flushEvents())
  },
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const service = serviceFor(env)
    ctx.waitUntil(service.processIncoming().then(() => service.flushEvents()))
    ctx.waitUntil(service.collectGarbage())
  }
} satisfies ExportedHandler<Env>
