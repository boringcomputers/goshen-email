import { GoshenEmailClient } from "@goshenemail/client"
import { handleMailMcp } from "goshenemail-mcp/http"
import { authenticateApiKey } from "./api-keys.js"
import { handleDeveloperRequest } from "./developer-api.js"
import { MailError } from "./contracts.js"
import type { MailService } from "./mail-service.js"
import { readBytes } from "./security.js"
export async function handleDeveloperMcp(request: Request, service: MailService) {
  if (request.headers.has("origin") && request.headers.get("origin") !== new URL(service.config.publicUrl).origin)
    throw new MailError("Invalid request origin", "forbidden", 403)
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } })
  const authorization = request.headers.get("authorization") ?? ""
  const identity = await authenticateApiKey(service.store.db, authorization)
  const client = new GoshenEmailClient({ apiKey: authorization.slice(7), baseUrl: service.config.publicUrl,
    fetch: async (input, init) => handleDeveloperRequest(new Request(input, init), service) })
  const body = await readBytes(request.body, 5 * 1024 * 1024)
  const response = await handleMailMcp(new Request(request.url, { method: request.method, headers: request.headers, body }), client, identity.scopes)
  response.headers.set("cache-control", "no-store")
  return response
}
