import { betterAuth, type BetterAuthOptions } from "better-auth"
import { PostgresDialect, type Dialect } from "kysely"
import { Pool } from "pg"
import { isIP } from "node:net"
import { z } from "zod"
import { MailError } from "./contracts.js"
import { equalSecret, readBytes } from "./security.js"
import { CustomerStore } from "./customer-store.js"
import { executeCustomerRequest } from "./customer-api.js"
import type { MailService } from "./mail-service.js"

export interface AccountConfig { publicUrl: string; secret: string; proxySecret: string; from: string; adminEmails: string[] }
export function accountConfig(env: { AUTH_PUBLIC_URL?: string; AUTH_SECRET?: string; AUTH_PROXY_SECRET?: string; AUTH_FROM?: string; DASHBOARD_ADMIN_EMAILS?: string }): AccountConfig {
  const parsed = z.object({ publicUrl: z.url(), secret: z.string().min(32), proxySecret: z.string().min(32), from: z.email() }).safeParse({
    publicUrl: env.AUTH_PUBLIC_URL, secret: env.AUTH_SECRET, proxySecret: env.AUTH_PROXY_SECRET, from: env.AUTH_FROM,
  })
  if (!parsed.success) throw new MailError("Account sign-in is not configured", "not_configured", 503)
  const url = new URL(parsed.data.publicUrl)
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.origin !== parsed.data.publicUrl || url.username || url.password)
    throw new MailError("Account sign-in is not configured", "not_configured", 503)
  const admins = z.array(z.email()).safeParse((env.DASHBOARD_ADMIN_EMAILS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean))
  if (!admins.success) throw new MailError("Account sign-in is not configured", "not_configured", 503)
  return { ...parsed.data, adminEmails: admins.data }
}

export function accountOptions(config: AccountConfig, dialect: Dialect, service: MailService): BetterAuthOptions {
  const send = async (email: string, url: string, reset = false) => {
    await service.transport.send({ from: { address: config.from, name: "Bezalel Email" }, to: [email], cc: [], bcc: [], headers: {},
      subject: reset ? "Reset your Bezalel Email password" : "Verify your Bezalel Email address",
      text: `${reset ? "Choose a new password" : "Verify your email address to finish creating your account"}:\n\n${url}\n\nThis link expires in one hour. If you didn't request this, you can ignore this email.`,
    })
  }
  return {
    appName: "Bezalel Email", baseURL: config.publicUrl, basePath: "/api/auth", secret: config.secret,
    trustedOrigins: [config.publicUrl], database: { dialect, type: "postgres", schemaName: "mail" },
    user: { modelName: "auth_users" }, account: { modelName: "auth_accounts" },
    verification: { modelName: "auth_verifications" },
    session: { modelName: "auth_sessions", expiresIn: 7 * 24 * 60 * 60, cookieCache: { enabled: false } },
    emailAndPassword: { enabled: true, minPasswordLength: 12, maxPasswordLength: 128, requireEmailVerification: true,
      autoSignIn: false, revokeSessionsOnPasswordReset: true, resetPasswordTokenExpiresIn: 3600,
      sendResetPassword: async ({ user, url }) => send(user.email, url, true) },
    emailVerification: { sendOnSignUp: true, sendOnSignIn: true, autoSignInAfterVerification: true, expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }) => send(user.email, url) },
    advanced: { database: { generateId: "uuid" }, cookiePrefix: "bezalel", useSecureCookies: config.publicUrl.startsWith("https:"),
      ipAddress: { ipAddressHeaders: ["x-bezalel-client-ip"] }, defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" } },
    rateLimit: { enabled: true, storage: "database", modelName: "auth_rate_limits", window: 60, max: 100,
      customRules: { "/sign-in/email": { window: 60, max: 5 }, "/sign-up/email": { window: 600, max: 5 },
        "/request-password-reset": { window: 600, max: 3 }, "/send-verification-email": { window: 600, max: 3 } } },
    telemetry: { enabled: false }, logger: { disabled: true },
  }
}
export const createAccountAuth = (config: AccountConfig, dialect: Dialect, service: MailService) => betterAuth(accountOptions(config, dialect, service))
export type AccountAuth = ReturnType<typeof createAccountAuth>
export function postgresAccountAuth(config: AccountConfig, connectionString: string, service: MailService) {
  const pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000 })
  pool.on("error", () => {})
  return { auth: createAccountAuth(config, new PostgresDialect({ pool }), service), close: () => pool.end() }
}
const authRoutes = new Map([
  ["/api/auth/sign-up/email", "POST"], ["/api/auth/sign-in/email", "POST"], ["/api/auth/sign-out", "POST"],
  ["/api/auth/send-verification-email", "POST"], ["/api/auth/verify-email", "GET"],
  ["/api/auth/request-password-reset", "POST"], ["/api/auth/reset-password", "POST"],
])

export async function handleAccountRequest(request: Request, service: MailService, config: AccountConfig, auth: AccountAuth): Promise<Response> {
  try {
    // The dashboard replaces this header and the client IP. Direct API traffic cannot spoof either.
    if (!equalSecret(request.headers.get("authorization") ?? "", `Bearer ${config.proxySecret}`))
      throw new MailError("Unauthorized", "unauthorized", 401)
    const url = new URL(request.url)
    const headers = new Headers(request.headers)
    headers.delete("authorization")
    if (request.method !== "GET") {
      if (headers.get("origin") !== config.publicUrl) throw new MailError("Invalid request origin", "forbidden", 403)
      if (!headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new MailError("Expected application/json", "invalid_request", 415)
    }
    const ip = headers.get("x-bezalel-client-ip") ?? ""
    if (!isIP(ip)) throw new MailError("Client address unavailable", "invalid_request", 400)
    const bytes = request.body ? await readBytes(request.body, url.pathname.startsWith("/api/auth/") ? 16 * 1024 : 5 * 1024 * 1024) : undefined
    if (url.pathname.startsWith("/api/auth/")) {
      let input: Record<string, unknown> = {}
      if (bytes) {
        try { input = JSON.parse(new TextDecoder().decode(bytes)) }
        catch { throw new MailError("Invalid JSON") }
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new MailError("Invalid account request")
      }
      for (const callback of [input.callbackURL, input.redirectTo, url.searchParams.get("callbackURL")]) {
        if (callback == null) continue
        let valid = false
        try { valid = typeof callback === "string" && new URL(callback, config.publicUrl).origin === config.publicUrl }
        catch { /* Reject malformed redirects. */ }
        if (!valid) throw new MailError("Invalid redirect URL", "forbidden", 403)
      }
      if (url.pathname === "/api/auth/sign-up/email" && (!z.string().trim().min(1).max(200).safeParse(input.name).success || !z.email().max(254).safeParse(input.email).success))
        throw new MailError("Enter a valid name and email address")
    }
    const authRequest = new Request(new URL(url.pathname + url.search, config.publicUrl), {
      method: request.method, headers, ...(bytes ? { body: bytes } : {}),
    })
    if (url.pathname.startsWith("/account-rpc/")) {
      if (request.method !== "POST") throw new MailError("Not found", "not_found", 404)
      const { response: session, headers: sessionHeaders } = await auth.api.getSession({ headers, returnHeaders: true })
      if (!session?.user.emailVerified) throw new MailError("Sign in to continue", "unauthorized", 401)
      const store = new CustomerStore(service.store.db, config.adminEmails)
      const customer = await store.resolveAccount(session.user)
      const response = await executeCustomerRequest(authRequest, service, store, customer, url.pathname.slice("/account-rpc/".length))
      for (const cookie of sessionHeaders.getSetCookie()) response.headers.append("set-cookie", cookie)
      return response
    }
    const resetLink = request.method === "GET" && /^\/api\/auth\/reset-password\/[A-Za-z0-9_-]+$/.test(url.pathname)
    if (!resetLink && authRoutes.get(url.pathname) !== request.method) throw new MailError("Not found", "not_found", 404)
    const response = await auth.handler(authRequest)
    const outgoing = new Headers(response.headers)
    outgoing.set("cache-control", "no-store")
    outgoing.delete("content-length")
    // Only HTTP-only cookies carry sessions; never expose the library's session token in JSON.
    if ((response.status < 300 || response.status >= 400) && response.headers.get("content-type")?.includes("application/json")) {
      const body = await response.json() as Record<string, unknown>
      delete body.token
      delete body.session
      delete body.user
      return Response.json(body, { status: response.status, headers: outgoing })
    }
    return new Response(response.body, { status: response.status, headers: outgoing })
  } catch (error) {
    return Response.json({ error: { message: error instanceof MailError ? error.message : "Account request failed" } }, {
      status: error instanceof MailError ? error.status : 500, headers: { "cache-control": "no-store" },
    })
  }
}

export async function collectAccountGarbage(service: MailService): Promise<void> {
  await service.store.db.query('delete from mail.auth_sessions where "expiresAt" < now()')
  await service.store.db.query('delete from mail.auth_verifications where "expiresAt" < now()')
  await service.store.db.query('delete from mail.auth_rate_limits where "lastRequest" < $1', [Date.now() - 24 * 60 * 60 * 1000])
}
