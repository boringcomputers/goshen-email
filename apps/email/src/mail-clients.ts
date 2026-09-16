import { createHmac } from "node:crypto"
import { clientDomainRequest } from "./client-domains.js"
import { z } from "zod"
import { address, inputs, MailError, type Operation } from "./contracts.js"
import type { MailService } from "./mail-service.js"
import { equalSecret, readBytes, validateUrl } from "./security.js"

interface Client {
  client_id: string
  inbox_id: string
  address: string
  custom_address: string | null
  display_name: string | null
  created_at: string
  deleted_at: string | null
  webhook_url: string
  token_version: number
  daily_send_limit: number
}
const clientId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9._-]+$/)
const provisionInput = z.object({
  clientId,
  username: inputs.createInbox.shape.username.unwrap(),
  displayName: inputs.createInbox.shape.displayName,
  webhookUrl: z.url().max(2048),
  dailySendLimit: z.number().int().min(1).max(10000).default(250)
})
const clientQuery = `select c.*, i.address, i.custom_address, i.display_name, i.created_at, i.deleted_at
  from mail.clients c join mail.inboxes i on i.id = c.inbox_id`
const digest = (secret: string, value: string) =>
  createHmac("sha256", secret).update(value).digest("base64url")
const apiKey = (service: MailService, client: Client) =>
  `gme_${client.inbox_id}.${digest(service.config.apiToken, `inbox:${client.inbox_id}:${client.token_version}`)}`
const webhookSecret = (service: MailService, inboxId: string) =>
  `whsec_${createHmac("sha256", service.config.webhookSecret).update(`inbox:${inboxId}`).digest("base64")}`
const inboxView = (client: Client) => ({
  inboxId: client.address,
  address: client.custom_address ?? client.address,
  displayName: client.display_name ?? undefined,
  createdAt: new Date(client.created_at).toISOString()
})
const credentials = (service: MailService, client: Client) => ({
  ...inboxView(client),
  clientId: client.client_id,
  apiKey: apiKey(service, client),
  webhookUrl: client.webhook_url,
  webhookSecret: webhookSecret(service, client.inbox_id),
  dailySendLimit: client.daily_send_limit
})
const json = (result: unknown) =>
  Response.json({ result }, { headers: { "cache-control": "no-store" } })
const body = async (request: Request): Promise<unknown> => {
  try {
    return JSON.parse(
      new TextDecoder().decode(await readBytes(request.body, 5 * 1024 * 1024))
    )
  } catch (error) {
    if (error instanceof MailError) throw error
    throw new MailError("Invalid JSON")
  }
}
const decode = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value)
  if (!result.success) throw new MailError("Invalid email request")
  return result.data
}
const activeClient = async (service: MailService, id: string) => {
  const [client] = await service.store.db.query<Client>(
    `${clientQuery} where c.client_id = $1`,
    [id]
  )
  if (!client) throw new MailError("Client not found", "not_found", 404)
  if (client.deleted_at)
    throw new MailError("This mailbox has been deleted", "inbox_retired", 410)
  return client
}

/** Only the platform credential may assign an inbox or its webhook destination. */
export async function handleClientAdmin(
  request: Request,
  service: MailService
): Promise<Response> {
  if (
    !equalSecret(
      request.headers.get("authorization") ?? "",
      `Bearer ${service.config.apiToken}`
    )
  )
    throw new MailError("Unauthorized", "unauthorized", 401)
  const path = new URL(request.url).pathname
  if (
    request.method !== "POST" ||
    !["/clients/provision", "/clients/rotate", "/clients/delete"].includes(path)
  )
    throw new MailError("Not found", "not_found", 404)
  const raw = await body(request)
  if (path === "/clients/provision") {
    const input = decode(provisionInput, raw)
    const url = validateUrl(input.webhookUrl)
    const domain = service.config.defaultDomain
    if (!domain) throw new MailError("Configure a default email domain before provisioning clients", "domain_not_configured", 422)
    const inboxAddress = decode(
      address,
      `${input.username.toLowerCase()}@${domain}`
    )
    const info = await service.transport.verifyDomain(domain)
    if (info.status !== "VERIFIED")
      throw new MailError("Email domain is not ready", "domain_not_ready", 422)
    await service.store.saveDomain(info)
    try {
      await service.store.db.query(
        "select mail.provision_client($1, $2, $3, $4, $5, $6)",
        [
          input.clientId,
          inboxAddress,
          domain,
          input.displayName ?? null,
          url.href,
          input.dailySendLimit
        ]
      )
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes("MAIL_CLIENT_CONFLICT") ||
          ("code" in error && error.code === "23505"))
      )
        throw new MailError(
          "Client or address already belongs to another mailbox",
          "inbox_conflict",
          409
        )
      throw error
    }
    return json(
      credentials(service, await activeClient(service, input.clientId))
    )
  }
  const input = decode(z.object({ clientId }), raw)
  if (path === "/clients/delete") {
    const [client] = await service.store.db.query<Client>(
      `${clientQuery} where c.client_id = $1`,
      [input.clientId]
    )
    if (client) await service.store.deleteInbox(client.address)
    // Already absent is also a confirmed deletion, so teardown retries can finish.
    return json({ deleted: true })
  }
  await activeClient(service, input.clientId)
  await service.store.db.query(
    "update mail.clients set token_version = token_version + 1 where client_id = $1",
    [input.clientId]
  )
  return json(credentials(service, await activeClient(service, input.clientId)))
}

const allowed = new Set<Operation>([
  "send",
  "reply",
  "listMessages",
  "getMessage",
  "listThreads",
  "getThread",
  "searchMessages",
  "getAttachment",
  "updateThreadLabels",
  "updateMessageLabels"
])

export async function handleInboxRequest(
  request: Request,
  service: MailService
): Promise<Response> {
  const token = (request.headers.get("authorization") ?? "").replace(
    /^Bearer /,
    ""
  )
  const match = /^gme_([a-f0-9-]{36})\.[A-Za-z0-9_-]{43}$/.exec(token)
  const [client] =
    match && z.uuid().safeParse(match[1]).success
      ? await service.store.db.query<Client>(
          `${clientQuery} where c.inbox_id = $1 and i.deleted_at is null and i.testing = false`,
          [match[1]]
        )
      : []
  if (!client || !equalSecret(token, apiKey(service, client)))
    throw new MailError("Unauthorized", "unauthorized", 401)
  if (request.method !== "POST")
    throw new MailError("Not found", "not_found", 404)
  const operation = new URL(request.url).pathname.slice("/inbox-rpc/".length)
  const input = decode(z.record(z.string(), z.unknown()), await body(request))
  if (input.inboxId !== undefined && input.inboxId !== client.address)
    throw new MailError(
      "This credential cannot access that inbox",
      "forbidden",
      403
    )
  if (operation === "getInbox") return json(inboxView(client))
  if (["getCustomDomain", "connectCustomDomain", "disconnectCustomDomain"].includes(operation))
    return json(await clientDomainRequest(service, client.client_id, operation, input))
  if (operation === "ensureWebhook" || operation === "webhookStatus") {
    if (
      operation === "ensureWebhook" &&
      decode(inputs.ensureWebhook, input).url !== client.webhook_url
    )
      throw new MailError(
        "The platform must update this inbox's webhook URL",
        "webhook_url_mismatch",
        422
      )
    return json({
      webhookId: client.inbox_id,
      url: client.webhook_url,
      secret: webhookSecret(service, client.inbox_id),
      configured: true
    })
  }
  if (!allowed.has(operation as Operation))
    throw new MailError(
      "Operation is not permitted for mailbox credentials",
      "forbidden",
      403
    )
  return json(
    await service.execute(operation as Operation, {
      ...input,
      inboxId: client.address
    })
  )
}

/** Product mailbox webhooks take precedence over the shared destination. */
export async function clientEventTarget(
  service: MailService,
  inboxId: string
): Promise<{ url: string; secret: string } | null> {
  const [inbox] = await service.store.db.query<{
    webhook_url: string | null
    deleted_at: string | null
  }>(
    `select c.webhook_url, i.deleted_at from mail.inboxes i
      left join mail.clients c on c.inbox_id = i.id where i.id = $1`,
    [inboxId]
  )
  if (!inbox || inbox.deleted_at) return null
  return inbox.webhook_url
    ? { url: inbox.webhook_url, secret: webhookSecret(service, inboxId) }
    : service.config.eventsUrl
      ? { url: service.config.eventsUrl, secret: service.config.webhookSecret }
      : null
}
