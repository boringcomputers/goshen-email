import { authenticateApiKey } from "./api-keys.js"
import { MailError } from "./contracts.js"
import { CustomerStore } from "./customer-store.js"
import { executeCustomerRequest } from "./customer-api.js"
import { developerOperations, inputJsonSchema, openApiDocument } from "./developer-contract.js"
import { handleInboxRequest } from "./mail-clients.js"
import type { MailService } from "./mail-service.js"
import { readBytes } from "./security.js"

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } })
export async function handleDeveloperRequest(request: Request, service: MailService): Promise<Response> {
  try {
    const url = new URL(request.url)
    if (url.pathname === "/openapi.json" && request.method === "GET") return json(openApiDocument(service.config.publicUrl))
    const match = Object.entries(developerOperations).map(([id, operation]) => ({ id, operation,
      match: new RegExp("^" + operation.path.replace(/\{\w+\}/g, "([^/]+)") + "$", "u").exec(url.pathname) }))
      .find(row => row.match && row.operation.method === request.method)
    if (!match) throw new MailError("Not found", "not_found", 404)
    const { id, operation } = match
    const authorization = request.headers.get("authorization") ?? ""
    const mailbox = authorization.startsWith("Bearer gme_")
    const identity = mailbox ? null : await authenticateApiKey(service.store.db, authorization)
    if (identity && !identity.scopes.includes(operation.scope)) throw new MailError(`This key requires ${operation.scope}`, "insufficient_scope", 403)
    const pathNames = [...operation.path.matchAll(/\{(\w+)\}/g)].map(value => value[1]!)
    const path: Record<string, string> = {}
    try { pathNames.forEach((name, i) => { path[name] = decodeURIComponent(match.match![i + 1]!) }) }
    catch { throw new MailError("Invalid URL encoding") }
    const schema = inputJsonSchema(operation.input)
    const data: Record<string, unknown> = Object.create(null)
    if (request.method === "GET") {
      for (const [name, value] of url.searchParams) {
        if (pathNames.includes(name) || !Object.hasOwn(schema.properties ?? {}, name)) throw new MailError("Unknown query parameter")
        const property = schema.properties![name] as { type?: string }
        if (property.type === "array") { (data[name] ??= [] as string[]); (data[name] as string[]).push(value) }
        else {
          if (Object.hasOwn(data, name)) throw new MailError("Repeated query parameter")
          if (property.type === "number" || property.type === "integer") {
            if (!/^\d+$/.test(value)) throw new MailError("Invalid numeric query parameter")
            data[name] = Number(value)
          } else if (property.type === "boolean") {
            if (value !== "true" && value !== "false") throw new MailError("Invalid boolean query parameter")
            data[name] = value === "true"
          } else data[name] = value
        }
      }
    } else {
      if (url.search) throw new MailError("This operation does not accept query parameters")
      const bytes = await readBytes(request.body, 5 * 1024 * 1024)
      if (bytes.length) {
        if (!request.headers.get("content-type")?.startsWith("application/json")) throw new MailError("Expected application/json", "invalid_request", 415)
        let body: unknown
        try { body = JSON.parse(new TextDecoder().decode(bytes)) } catch { throw new MailError("Invalid JSON") }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new MailError("Expected an object")
        if (pathNames.some(name => Object.hasOwn(body!, name))) throw new MailError("Path identifiers must not be repeated in the body")
        Object.assign(data, body)
      }
    }
    Object.assign(data, path)
    if (id === "send" || id === "reply") {
      const key = request.headers.get("idempotency-key")
      if (key && data.idempotencyKey !== undefined && data.idempotencyKey !== key) throw new MailError("Conflicting idempotency keys")
      if (key) data.idempotencyKey = key
    }
    const parsed = operation.input.strict().safeParse(data)
    if (!parsed.success) throw new MailError("Invalid email request. Check the operation schema and required fields.")
    const input = parsed.data
    let result: unknown
    if (mailbox) {
      if (id === "listInboxes" && ("group" in input || "pageToken" in input))
        throw new MailError("Use an account key to filter or paginate inboxes", "forbidden", 403)
      const rpcId = id === "listInboxes" ? "getInbox" : id
      const response = await handleInboxRequest(new Request(new URL(`/inbox-rpc/${rpcId}`, url), {
        method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify(input),
      }), service)
      result = ((await response.json()) as { result: unknown }).result
      if (id === "listInboxes") result = { inboxes: [result] }
    } else {
      const store = new CustomerStore(service.store.db, [])
      const response = await executeCustomerRequest(new Request(url, { method: "POST", body: JSON.stringify(input) }), service, store, identity!.customer, id)
      result = ((await response.json()) as { result: unknown }).result
    }
    if (id === "deleteInbox") result = { deleted: result }
    return json(result)
  } catch (error) {
    return json({ error: { message: error instanceof MailError ? error.message : "Email operation failed",
      code: error instanceof MailError ? error.code : "internal_error", transient: error instanceof MailError ? error.transient : true } }, error instanceof MailError ? error.status : 500)
  }
}
