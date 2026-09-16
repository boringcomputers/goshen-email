import { importJWK } from "jose"
import { accessIdentity } from "../../src/access-auth.js"
import { cloudflareTransport } from "../../src/cloudflare.js"
import { type Transport } from "../../src/contracts.js"
import { MailService } from "../../src/mail-service.js"
import { type MailboxStore } from "../../src/mailbox-store.js"

export default {
  async fetch(request: Request, env: { MOCK_URL: string; ACCESS_PUBLIC_JWK: string }) {
    if (new URL(request.url).pathname === "/auth") {
      try {
        const key = await importJWK(JSON.parse(env.ACCESS_PUBLIC_JWK), "RS256")
        return Response.json(await accessIdentity(request.headers.get("authorization") ?? "",
          { teamDomain: "fixture.cloudflareaccess.com", audience: "a".repeat(64), adminEmails: [] }, async () => key))
      } catch { return new Response("Unauthorized", { status: 401 }) }
    }
    if (new URL(request.url).pathname === "/domain") {
      const transport = cloudflareTransport({
        token: "runtime-test-token",
        accountId: "a".repeat(32),
        domains: { "example.com": "b".repeat(32) },
        workerName: "runtime-test"
      }, (url, init) => fetch(new URL(new URL(String(url)).pathname, env.MOCK_URL), init))
      return Response.json(await transport.verifyDomain("example.com"))
    }
    const settlements: Array<{ id: string; delivered: boolean }> = []
    const store = {
      db: { query: async () => [{ webhook_url: null, deleted_at: null }] },
      pendingEvents: async () => [{ id: "runtime-event", inbox_id: "11111111-1111-4111-8111-111111111111", payload: { type: "email.received" }, attempts: 0 }],
      settleEvent: async (id: string, delivered: boolean) => { settlements.push({ id, delivered }) }
    } as unknown as MailboxStore
    const service = new MailService({
      config: {
        defaultDomain: "example.com", domains: {},
        publicUrl: "https://example.com", eventsUrl: `${env.MOCK_URL}/events/cloudflare`,
        apiToken: "test-only-token".repeat(3), webhookSecret: `whsec_${"a".repeat(43)}=`
      },
      store,
      transport: {} as Transport,
      objects: {} as R2Bucket
    })
    await service.flushEvents()
    return Response.json({ settlements })
  }
}
