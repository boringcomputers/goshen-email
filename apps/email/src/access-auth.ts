import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose"
import { z } from "zod"
import { MailError } from "./contracts.js"

export interface AccessConfig {
  teamDomain: string
  audience: string
  adminEmails: string[]
}
export interface AccessIdentity { subject: string; email: string }
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>()

export function accessConfig(env: {
  ACCESS_TEAM_DOMAIN?: string; ACCESS_AUD?: string; DASHBOARD_ADMIN_EMAILS?: string
}): AccessConfig | undefined {
  if (!env.ACCESS_TEAM_DOMAIN && !env.ACCESS_AUD) return undefined
  const result = z.object({
    teamDomain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.cloudflareaccess\.com$/),
    audience: z.string().regex(/^[a-f0-9]{64}$/),
    adminEmails: z.array(z.email()).min(1).max(20),
  }).safeParse({ teamDomain: env.ACCESS_TEAM_DOMAIN, audience: env.ACCESS_AUD,
    adminEmails: (env.DASHBOARD_ADMIN_EMAILS ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean) })
  if (!result.success) throw new MailError("Customer sign-in is not configured", "not_configured", 503)
  return result.data
}

export async function accessIdentity(token: string, config: AccessConfig, key?: JWTVerifyGetKey): Promise<AccessIdentity> {
  if (!token || token.length > 8192) throw new MailError("Sign in to continue", "unauthorized", 401)
  const issuer = `https://${config.teamDomain}`
  if (!key) {
    if (!keySets.has(issuer)) {
      if (keySets.size >= 4) keySets.delete(keySets.keys().next().value!)
      keySets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5000 }))
    }
    key = keySets.get(issuer)!
  }
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer, audience: config.audience, algorithms: ["RS256"], requiredClaims: ["sub", "email", "exp", "iat"],
    })
    const identity = z.object({ sub: z.string().min(1).max(256), email: z.email().max(254), type: z.literal("app") }).parse(payload)
    return { subject: identity.sub, email: identity.email.toLowerCase() }
  } catch {
    throw new MailError("Your sign-in expired or could not be verified", "unauthorized", 401)
  }
}
