import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { GoshenEmailClient } from "@goshenemail/client"
import { createMailMcp } from "./index.js"
export async function handleMailMcp(request: Request, client: GoshenEmailClient, scopes: readonly string[]) {
  const server = createMailMcp(client, scopes)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  await server.connect(transport)
  try {
    const response = await transport.handleRequest(request)
    // Consume the JSON response before closing this request's stateless transport.
    return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers })
  } finally { await server.close() }
}
