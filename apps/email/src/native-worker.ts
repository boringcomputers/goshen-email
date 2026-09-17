import worker, { type Env } from "./worker.js"
import { MailError } from "./contracts.js"

const standaloneSettings = [
  "TYPESAFE_API_KEY", "TYPESAFE_MODEL", "AUTH_PUBLIC_URL", "AUTH_SECRET",
  "AUTH_PROXY_SECRET", "AUTH_FROM", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD",
  "DASHBOARD_ADMIN_EMAILS",
] as const

export function nativeEnvironment(env: Env): Env {
  const eventsUrl = env.MAIL_EVENTS_URL ?? env.BEZALEL_EVENTS_URL
  if (
    env.WORKER_NAME !== "bezalel-email" ||
    env.DEFAULT_EMAIL_DOMAIN !== "goshenemail.com" ||
    env.PUBLIC_EMAIL_URL !== "https://bezalel-email.michaelwasihun96.workers.dev" ||
    eventsUrl !== "https://mcp.bezalel.sh/events/cloudflare" ||
    (env.MAIL_EVENTS_URL && env.BEZALEL_EVENTS_URL && env.MAIL_EVENTS_URL !== env.BEZALEL_EVENTS_URL) ||
    standaloneSettings.some((name) => Boolean(env[name]))
  ) {
    throw new MailError("Native email configuration does not match the migration profile", "not_configured", 503)
  }
  return env
}

const allowedPath = (path: string) => path === "/healthz" ||
  ["/rpc/", "/test-rpc/", "/clients/", "/inbox-rpc/", "/attachments/", "/gateway/"]
    .some((prefix) => path.startsWith(prefix))

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!allowedPath(new URL(request.url).pathname)) {
      return Response.json({ error: { message: "Not found", code: "not_found", transient: false } },
        { status: 404, headers: { "cache-control": "no-store" } })
    }
    try {
      return await worker.fetch(request, nativeEnvironment(env))
    } catch {
      return Response.json({ error: {
        message: "Native email is not configured", code: "not_configured", transient: false,
      } }, { status: 503, headers: { "cache-control": "no-store" } })
    }
  },
  async email(message: ForwardableEmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
    await worker.email(message, nativeEnvironment(env), ctx)
  },
  async queue(batch: MessageBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    await worker.queue(batch, nativeEnvironment(env), ctx)
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    await worker.scheduled(controller, nativeEnvironment(env), ctx)
  },
} satisfies ExportedHandler<Env>
