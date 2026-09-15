import worker, { type Env } from "../../src/worker.js"

// Only the provider API is simulated. Requests use the production handlers,
// a real local Hyperdrive binding, PostgreSQL sockets, and Wrangler's local R2.
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input))
  if (url.hostname !== "api.cloudflare.com") throw new Error("Unexpected external request in test")
  const result = url.pathname.endsWith("/subdomains")
    ? [{ name: "example.com", enabled: true }]
    : url.pathname.endsWith("/catch_all")
      ? { enabled: true, actions: [{ type: "worker", value: ["postgres-runtime-test"] }] }
      : url.pathname.endsWith("/send")
        ? { message_id: `<${crypto.randomUUID()}@provider.test>`,
            delivered: JSON.parse(String(init?.body)).to, queued: [], permanent_bounces: [] }
        : { name: "example.com", enabled: true }
  return Response.json({ success: true, result })
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url)
    if (url.pathname === "/__test/receive") {
      let rejection: string | undefined
      const raw = new Uint8Array(await request.arrayBuffer())
      await worker.email({
        from: "customer@example.net", to: "runtime@example.com",
        raw: new Response(raw).body!, rawSize: raw.byteLength,
        setReject: (reason: string) => { rejection = reason },
      } as ForwardableEmailMessage, env, ctx)
      return Response.json({ accepted: !rejection, rejection })
    }
    if (url.pathname === "/__test/scheduled") {
      await worker.scheduled({} as ScheduledController, env, ctx)
      return Response.json({ scheduled: true })
    }
    return worker.fetch(request, env)
  }
} satisfies ExportedHandler<Env>
