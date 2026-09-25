import { createHmac } from "node:crypto"
import { magicLink, emailOTP } from "better-auth/plugins"
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

// An empty allowedEmails list, from an unset AUTH_ALLOWED_EMAILS, keeps sign-up public. Any entry restricts
// sign-in to the listed addresses. A set but blank AUTH_ALLOWED_EMAILS is a configuration error.
export interface AccountConfig { publicUrl: string; secret: string; proxySecret: string; from: string; adminEmails: string[]; allowedEmails: string[] }
const emailList = (value: string | undefined) => z.array(z.email()).safeParse((value ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean))
export function accountConfig(env: { AUTH_PUBLIC_URL?: string; AUTH_SECRET?: string; AUTH_PROXY_SECRET?: string; AUTH_FROM?: string; DASHBOARD_ADMIN_EMAILS?: string; AUTH_ALLOWED_EMAILS?: string }): AccountConfig {
  const parsed = z.object({ publicUrl: z.url(), secret: z.string().min(32), proxySecret: z.string().min(32), from: z.email() }).safeParse({
    publicUrl: env.AUTH_PUBLIC_URL, secret: env.AUTH_SECRET, proxySecret: env.AUTH_PROXY_SECRET, from: env.AUTH_FROM,
  })
  if (!parsed.success) throw new MailError("Account sign-in is not configured", "not_configured", 503)
  const url = new URL(parsed.data.publicUrl)
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) || url.origin !== parsed.data.publicUrl || url.username || url.password)
    throw new MailError("Account sign-in is not configured", "not_configured", 503)
  const admins = emailList(env.DASHBOARD_ADMIN_EMAILS), allowed = emailList(env.AUTH_ALLOWED_EMAILS)
  if (!admins.success || !allowed.success || (env.AUTH_ALLOWED_EMAILS !== undefined && !allowed.data.length))
    throw new MailError("Account sign-in is not configured", "not_configured", 503)
  return { ...parsed.data, adminEmails: admins.data, allowedEmails: allowed.data }
}
const maySignIn = (config: AccountConfig, email: string) => !config.allowedEmails.length || config.allowedEmails.includes(email.toLowerCase())

const linkHash = (token: string, secret: string) => createHmac("sha256", secret).update(token).digest("hex")

export function accountOptions(config: AccountConfig, dialect: Dialect, service: MailService): BetterAuthOptions {
  const send = async (email: string, subject: string, text: string) => {
    await service.transport.send({ from: { address: config.from, name: "Goshen Email" }, to: [email], cc: [], bcc: [], headers: {}, subject, text })
  }
  return {
    appName: "Goshen Email", baseURL: config.publicUrl, basePath: "/api/auth", secret: config.secret,
    trustedOrigins: [config.publicUrl], database: { dialect, type: "postgres", schemaName: "mail" },
    user: { modelName: "auth_users" }, account: { modelName: "auth_accounts" },
    verification: { modelName: "auth_verifications" },
    session: { modelName: "auth_sessions", expiresIn: 7 * 24 * 60 * 60, cookieCache: { enabled: false } },
    emailAndPassword: { enabled: false },
    plugins: [
      magicLink({ expiresIn: 600, storeToken: { type: "custom-hasher", hash: async (token) => linkHash(token, config.secret) }, disableSignUp: false,
        sendMagicLink: async ({ email, token }) => {
          // The confirmation page keeps email scanners from consuming a sign-in link.
          const url = `${config.publicUrl}/magic-link#token=${encodeURIComponent(token)}&email=${encodeURIComponent(email)}`
          await send(email, "Your Goshen Email sign-in link", `Sign in to Goshen Email:\n\n${url}\n\nThis link works once and expires in 10 minutes. If you didn't request it, you can ignore this email.`)
        } }),
      emailOTP({ otpLength: 6, expiresIn: 600, allowedAttempts: 5, storeOTP: "hashed", disableSignUp: false,
        sendVerificationOTP: async ({ email, otp, type }) => {
          if (type !== "sign-in") throw new MailError("Use passwordless sign-in", "invalid_request", 400)
          await send(email, "Your Goshen Email sign-in code", `Your sign-in code is:\n\n${otp}\n\nEnter this code on Goshen Email. It works once and expires in 10 minutes. If you didn't request it, you can ignore this email.`)
        } }),
    ],
    advanced: { database: { generateId: "uuid" }, cookiePrefix: "bezalel", useSecureCookies: config.publicUrl.startsWith("https:"),
      ipAddress: { ipAddressHeaders: ["x-bezalel-client-ip"] }, defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" } },
    rateLimit: { enabled: true, storage: "database", modelName: "auth_rate_limits", window: 60, max: 100,
      customRules: { "/sign-in/magic-link": { window: 600, max: 3 }, "/magic-link/verify": { window: 60, max: 10 },
        "/email-otp/send-verification-otp": { window: 600, max: 3 }, "/sign-in/email-otp": { window: 60, max: 10 } } },
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
  ["/api/auth/sign-in/magic-link", "POST"], ["/api/auth/magic-link/verify", "POST"],
  ["/api/auth/email-otp/send-verification-otp", "POST"], ["/api/auth/sign-in/email-otp", "POST"],
  ["/api/auth/sign-out", "POST"],
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
    let confirmationToken: string | undefined
    if (url.pathname.startsWith("/api/auth/")) {
      if (authRoutes.get(url.pathname) !== request.method) throw new MailError("Not found", "not_found", 404)
      let input: Record<string, unknown> = {}
      if (bytes) {
        try { input = JSON.parse(new TextDecoder().decode(bytes)) }
        catch { throw new MailError("Invalid JSON") }
        if (!input || typeof input !== "object" || Array.isArray(input)) throw new MailError("Invalid account request")
      }
      for (const callback of [input.callbackURL, input.newUserCallbackURL, input.errorCallbackURL, ...["callbackURL", "newUserCallbackURL", "errorCallbackURL"].map((key) => url.searchParams.get(key))]) {
        if (callback == null) continue
        let valid = false
        try { valid = typeof callback === "string" && new URL(callback, config.publicUrl).origin === config.publicUrl }
        catch { /* Reject malformed redirects. */ }
        if (!valid) throw new MailError("Invalid redirect URL", "forbidden", 403)
      }
      if (request.method === "POST" && url.pathname !== "/api/auth/sign-out") {
        if (!z.email().max(254).safeParse(input.email).success || (input.name !== undefined && !z.string().trim().min(1).max(200).safeParse(input.name).success))
          throw new MailError("Enter a valid name and email address")
        // Refuse before Better Auth runs, so a refused address never receives a link or code.
        if (!maySignIn(config, String(input.email))) throw new MailError("Sign-in is limited to approved email addresses.", "forbidden", 403)
        if (url.pathname === "/api/auth/magic-link/verify") {
          const token = z.string().regex(/^[A-Za-z0-9_-]{20,256}$/).safeParse(input.token)
          if (!token.success) throw new MailError("Invalid or expired sign-in link", "invalid_token", 401)
          const context = await auth.$context
          const record = await context.internalAdapter.findVerificationValue(linkHash(token.data, config.secret))
          let email: unknown
          try { email = record && JSON.parse(record.value).email } catch { /* Invalid verification record. */ }
          if (!record || new Date(record.expiresAt).getTime() <= Date.now() || typeof email !== "string" || email.toLowerCase() !== String(input.email).toLowerCase())
            throw new MailError("This sign-in link is invalid, expired, or already used. Request a new one.", "invalid_token", 401)
          confirmationToken = token.data
        }
        if (url.pathname === "/api/auth/email-otp/send-verification-otp" && input.type !== "sign-in")
          throw new MailError("Use passwordless sign-in", "invalid_request", 400)
      }

    }
    const authRequest = new Request(new URL(url.pathname + url.search, config.publicUrl), {
      method: request.method, headers, ...(bytes ? { body: bytes } : {}),
    })
    if (url.pathname.startsWith("/account-rpc/")) {
      if (request.method !== "POST") throw new MailError("Not found", "not_found", 404)
      const { response: session, headers: sessionHeaders } = await auth.api.getSession({ headers, returnHeaders: true })
      // Sessions for addresses outside the allowlist, such as ones issued before it was set, count as signed out.
      if (!session?.user.emailVerified || !maySignIn(config, session.user.email)) throw new MailError("Sign in to continue", "unauthorized", 401)
      const store = new CustomerStore(service.store.db, config.adminEmails)
      const customer = await store.resolveAccount(session.user)
      const response = await executeCustomerRequest(authRequest, service, store, customer, url.pathname.slice("/account-rpc/".length))
      for (const cookie of sessionHeaders.getSetCookie()) response.headers.append("set-cookie", cookie)
      return response
    }
    if (authRoutes.get(url.pathname) !== request.method) throw new MailError("Not found", "not_found", 404)
    const response = await auth.handler(confirmationToken ? new Request(
      `${config.publicUrl}/api/auth/magic-link/verify?token=${encodeURIComponent(confirmationToken)}`, { headers }) : authRequest)
    const outgoing = new Headers(response.headers)
    outgoing.set("cache-control", "no-store")
    outgoing.delete("content-length")
    if (confirmationToken && response.status >= 300 && response.status < 400) {
      outgoing.delete("location")
      return Response.json({ message: "This sign-in link is invalid, expired, or already used. Request a new one." }, { status: 401, headers: outgoing })
    }
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
