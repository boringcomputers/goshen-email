import { createHash, randomBytes, randomUUID } from "node:crypto"
import { z } from "zod"
import type { Database } from "./database.js"
import type { Customer } from "./customer-store.js"
import { MailError } from "./contracts.js"
import { equalSecret } from "./security.js"

export const apiScopes = ["inboxes:read", "inboxes:write", "messages:read", "messages:write", "messages:send"] as const
export type ApiScope = typeof apiScopes[number]
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const createInput = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(apiScopes)).min(1).max(apiScopes.length),
  expiresInDays: z.number().int().min(1).max(365).default(30),
}).strict()
interface KeyRow {
  id: string; name: string; prefix: string; scopes: ApiScope[];
  created_at: string; expires_at: string | null; revoked_at: string | null; last_used_at: string | null
}
const iso = (value: string | null) => value ? new Date(value).toISOString() : null
const view = (row: KeyRow) => ({ keyId: row.id, name: row.name, prefix: row.prefix, scopes: row.scopes,
  createdAt: iso(row.created_at), expiresAt: iso(row.expires_at), revokedAt: iso(row.revoked_at), lastUsedAt: iso(row.last_used_at) })

export async function manageApiKeys(db: Database, customer: Customer, operation: string, raw: unknown) {
  if (operation === "listApiKeys") {
    const rows = await db.query<KeyRow>("select * from mail.api_keys where customer_id = $1 order by (revoked_at is null and (expires_at is null or expires_at > now())) desc, created_at desc, id desc limit 100", [customer.id])
    return { keys: rows.map(view) }
  }
  if (operation === "revokeApiKey") {
    const input = z.object({ keyId: z.uuid() }).strict().safeParse(raw)
    if (!input.success) throw new MailError("Choose an API key")
    const rows = await db.query("update mail.api_keys set revoked_at = coalesce(revoked_at, now()) where customer_id = $1 and id = $2 returning id", [customer.id, input.data.keyId])
    if (!rows.length) throw new MailError("API key not found", "not_found", 404)
    return { revoked: true }
  }
  const input = createInput.safeParse(raw)
  if (!input.success) throw new MailError("Enter a key name, permissions, and a valid expiration")
  const id = randomUUID(), token = `bze_${id}.${Buffer.from(randomBytes(32)).toString("base64url")}`
  const expires = new Date(Date.now() + input.data.expiresInDays * 86400_000).toISOString()
  const [created] = await db.query<{ created: boolean }>("select mail.create_api_key($1, $2, $3, $4, $5, $6, $7) as created",
    [customer.id, id, input.data.name, hash(token), token.slice(0, 12), [...new Set(input.data.scopes)], expires])
  if (!created?.created) throw new MailError("Revoke an unused key before creating another", "key_limit", 422)
  const [row] = await db.query<KeyRow>("select * from mail.api_keys where id = $1", [id])
  if (!row) throw new MailError("API key creation failed", "internal_error", 500)
  return { ...view(row), apiKey: token }
}

export async function authenticateApiKey(db: Database, authorization: string) {
  const token = /^Bearer (bze_([a-f0-9-]{36})\.[A-Za-z0-9_-]{43})$/.exec(authorization)
  if (!token || !z.uuid().safeParse(token[2]).success) throw new MailError("Unauthorized", "unauthorized", 401)
  const [row] = await db.query<KeyRow & { token_hash: string; customer_id: string; email: string; inbox_limit: number | null }>(
    `select k.*, c.email, c.inbox_limit from mail.api_keys k join mail.customers c on c.id = k.customer_id
     where k.id = $1 and k.revoked_at is null and (k.expires_at is null or k.expires_at > now()) and c.disabled_at is null`, [token[2]])
  if (!row || !equalSecret(hash(token[1]!), row.token_hash)) throw new MailError("Unauthorized", "unauthorized", 401)
  await db.query("update mail.api_keys set last_used_at = now() where id = $1 and (last_used_at is null or last_used_at < now() - interval '5 minutes')", [row.id])
  // API keys never inherit the dashboard owner's platform administrator access.
  const customer: Customer = { id: row.customer_id, email: row.email, role: "customer", inboxLimit: row.inbox_limit }
  return { customer, scopes: row.scopes }
}
