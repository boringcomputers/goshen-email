import { z } from "zod"
import { address, domainName, MailError, type DomainInfo } from "./contracts.js"
import type { Database } from "./database.js"
import { readBytes } from "./security.js"

export interface GatewayConfig {
  url: string
  token: string
  hostname: string
  ipv4: string
  encryptionKey: string
  feedbackSigners?: string[]
}

interface Credentials {
  challenge: string
  selector: string
  publicKey: string
  encryptedKey: string
}
interface DomainRow {
  info: DomainInfo
  credentials: Credentials | null
  verified_at: string | null
  client_id: string | null
  client_address: string | null
}
interface DomainClient { id: string; address: string }
type Lookup = (name: string, type: "TXT" | "MX") => Promise<string[]>
const dnsResponse = z.object({
  Status: z.number().int(),
  Answer: z.array(z.object({ type: z.number(), data: z.string().max(8192) })).max(100).optional()
})

export const dnsLookup = (request: typeof fetch = fetch): Lookup => async (name, type) => {
  try {
    const url = new URL("https://cloudflare-dns.com/dns-query")
    url.searchParams.set("name", name)
    url.searchParams.set("type", type)
    const response = await request(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(5000), redirect: "manual"
    })
    if (!response.ok) throw new Error()
    const parsed = dnsResponse.parse(JSON.parse(new TextDecoder().decode(await readBytes(response.body, 64 * 1024))))
    if (parsed.Status === 3) return []
    if (parsed.Status !== 0) throw new Error()
    return (parsed.Answer ?? []).filter((r) => r.type === (type === "TXT" ? 16 : 15))
      .map((r) => type === "TXT" ? decodeTxt(r.data) : r.data)
  } catch {
    throw new MailError("DNS could not be checked. Try again shortly.", "dns_unavailable", 503)
  }
}

// DNS-over-HTTPS returns TXT chunks in presentation format, including escapes.
export const decodeTxt = (value: string): string => {
  const parts = value.match(/"(?:[^"\\]|\\(?:\d{3}|.))*"/g)
  if (!parts || parts.join(" ") !== value.trim()) return value
  return parts.map((part) => part.slice(1, -1).replace(/\\(\d{3}|.)/g,
    (_, escaped: string) => /^\d{3}$/.test(escaped) ? String.fromCharCode(Number(escaped)) : escaped)).join("")
}

const tags = (value: string): Map<string, string> => new Map(value.split(";")
  .map((part) => part.trim().split(/=(.*)/s).slice(0, 2))
  .filter((pair): pair is [string, string] => pair.length === 2)
  .map(([key, value]) => [key.trim().toLowerCase(), value.trim()]))

export function spfAllows(values: string[], ipv4: string): boolean {
  const records = values.filter((value) => /^v=spf1(?:\s|$)/i.test(value))
  if (records.length !== 1) return false
  for (const term of records[0]!.trim().split(/\s+/).slice(1)) {
    if (/^[+?~-]?all$/i.test(term)) return false
    if (term.toLowerCase() === `ip4:${ipv4}` || term.toLowerCase() === `+ip4:${ipv4}`) return true
  }
  return false
}

const pem = (label: string, bytes: ArrayBuffer): string =>
  `-----BEGIN ${label}-----\n${Buffer.from(bytes).toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`

export class CustomDomains {
  constructor(
    readonly db: Database,
    readonly config: GatewayConfig,
    readonly managedDomains: string[],
    readonly lookup: Lookup = dnsLookup()
  ) {}

  private async row(domain: string): Promise<DomainRow> {
    const [row] = await this.db.query<DomainRow>(
      `select info, credentials, verified_at, client_id, client_address from mail.domains
       where domain = $1 and info->>'status' <> 'DELETED'`, [domain])
    if (!row?.credentials) throw new MailError("Custom domain not found", "not_found", 404)
    return row
  }

  private key() {
    return crypto.subtle.importKey("raw", Buffer.from(this.config.encryptionKey, "hex"), "AES-GCM", false, ["encrypt", "decrypt"])
  }

  private async encrypt(domain: string, value: ArrayBuffer): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(domain) }, await this.key(), value)
    return `${Buffer.from(iv).toString("base64")}.${Buffer.from(encrypted).toString("base64")}`
  }

  private async decrypt(domain: string, value: string): Promise<string> {
    const [iv, ciphertext] = value.split(".")
    try {
      return pem("PRIVATE KEY", await crypto.subtle.decrypt({ name: "AES-GCM", iv: Buffer.from(iv!, "base64"), additionalData: new TextEncoder().encode(domain) }, await this.key(), Buffer.from(ciphertext!, "base64")))
    } catch {
      throw new MailError("Domain signing key is unavailable", "not_configured", 503)
    }
  }

  async create(domain: string, client?: DomainClient): Promise<DomainInfo> {
    if (!domainName.safeParse(domain).success || domain.length > 220)
      throw new MailError("Enter a valid domain with at most 220 characters", "invalid_argument", 422)
    if (this.managedDomains.some((managed) => domain === managed || domain.endsWith(`.${managed}`)))
      throw new MailError("That domain is reserved for managed inboxes", "invalid_argument", 422)
    if (client && (!address.safeParse(client.address).success || !client.address.endsWith(`@${domain}`)))
      throw new MailError("Enter a valid email name for this domain", "invalid_argument", 422)
    const owned = (row: DomainRow) => {
      if (row.client_id !== (client?.id ?? null))
        throw new MailError("This domain is already connected to another account", "domain_conflict", 409)
      if (row.client_address !== (client?.address ?? null))
        throw new MailError("Disconnect this domain before changing its email name", "domain_conflict", 409)
      return row.info
    }
    const [existing] = await this.db.query<DomainRow>("select info, credentials, client_id, client_address from mail.domains where domain = $1", [domain])
    if (existing && existing.info.status !== "DELETED") {
      if (!existing.credentials) throw new MailError("That domain is managed by the operator", "conflict", 409)
      return owned(existing)
    }
    const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])
    if (!("privateKey" in pair)) throw new MailError("Could not generate domain keys", "internal_error", 500)
    const credentials: Credentials = {
      challenge: `bezalel-domain=${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")}`,
      selector: `bzl-${crypto.randomUUID().slice(0, 8)}`,
      publicKey: Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64"),
      encryptedKey: await this.encrypt(domain, await crypto.subtle.exportKey("pkcs8", pair.privateKey) as ArrayBuffer)
    }
    const info: DomainInfo = { domainId: domain, domain, status: "PENDING", records: [
      { type: "TXT", name: `_bezalel.${domain}`, value: credentials.challenge },
      { type: "MX", name: domain, value: this.config.hostname, priority: 10 },
      { type: "TXT", name: domain, value: `v=spf1 ip4:${this.config.ipv4} ~all` },
      { type: "TXT", name: `${credentials.selector}._domainkey.${domain}`, value: `v=DKIM1; k=rsa; p=${credentials.publicKey}` },
      { type: "TXT", name: `_dmarc.${domain}`, value: "v=DMARC1; p=none" }
    ].map((record) => ({ ...record, status: "pending" as const })) }
    try {
      const [created] = await this.db.query<{ info: DomainInfo }>(
        `with active as (select i.id from mail.inboxes i join mail.clients c on c.inbox_id = i.id
           where c.client_id = $4 and i.deleted_at is null for update of i)
         insert into mail.domains(domain, info, credentials, client_id, client_address)
         select $1, $2::jsonb, $3::jsonb, $4, $5 where $4::text is null or exists(select 1 from active)
         on conflict (domain) do update set info = excluded.info, credentials = excluded.credentials,
           client_id = excluded.client_id, client_address = excluded.client_address, verified_at = null, verification_token = null
         where mail.domains.info->>'status' = 'DELETED' returning info`,
        [domain, JSON.stringify(info), JSON.stringify(credentials), client?.id ?? null, client?.address ?? null])
      return created?.info ?? owned(await this.row(domain))
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23505")
        throw new MailError("Disconnect your current domain before connecting another", "domain_conflict", 409)
      throw error
    }
  }

  async verify(domain: string): Promise<DomainInfo> {
    // Fence the entire DNS observation, including concurrent checks of the
    // same registration. Only the most recently started check may persist.
    const verification = crypto.randomUUID()
    const [row] = await this.db.query<DomainRow>(
      `update mail.domains set verification_token = $2
       where domain = $1 and info->>'status' <> 'DELETED' and credentials is not null
       returning info, credentials, verified_at, client_id, client_address`, [domain, verification])
    if (!row?.credentials) throw new MailError("Custom domain not found", "not_found", 404)
    const credentials = row.credentials
    const [proof, mx, spf, dkim, dmarc] = await Promise.all([
      this.lookup(`_bezalel.${domain}`, "TXT"), this.lookup(domain, "MX"), this.lookup(domain, "TXT"),
      this.lookup(`${credentials.selector}._domainkey.${domain}`, "TXT"), this.lookup(`_dmarc.${domain}`, "TXT")
    ])
    const dmarcPolicies = dmarc.map(tags).filter((record) => record.get("v") === "DMARC1")
    const checks = [proof.includes(credentials.challenge), mx.length > 0 && mx.every((value) =>
      /^\d+\s+\S+$/.test(value) && value.split(/\s+/)[1]!.replace(/\.$/, "").toLowerCase() === this.config.hostname) &&
      mx.every((value) => Number(value.split(/\s+/)[0]) <= 65535),
      spfAllows(spf, this.config.ipv4), dkim.length === 1 && tags(dkim[0]!).get("p") === credentials.publicKey &&
      (tags(dkim[0]!).get("v") ?? "DKIM1") === "DKIM1" && (tags(dkim[0]!).get("k") ?? "rsa") === "rsa" &&
      (tags(dkim[0]!).get("h") ?? "sha256").split(":").includes("sha256"),
      dmarcPolicies.length === 1 && ["none", "quarantine", "reject"].includes(dmarcPolicies[0]!.get("p")?.toLowerCase() ?? "")]
    const ready = checks.every(Boolean)
    const info: DomainInfo = { ...row.info, status: ready ? "VERIFIED" : "PENDING",
      records: row.info.records.map((record, index) => ({ ...record, status: checks[index] ? "verified" : "pending" })) }
    let updated: { info: DomainInfo | null } | undefined
    try {
      [updated] = row.client_id
      ? await this.db.query<{ info: DomainInfo | null }>(
        `select mail.verify_client_domain($1, $2, $3, $4::jsonb, $5, $6) as info`,
        [row.client_id, domain, credentials.challenge, JSON.stringify(info), ready, verification])
      : await this.db.query<{ info: DomainInfo | null }>(
      `update mail.domains set info = $2::jsonb, verified_at = case when $4 then now() else null end
       where domain = $1 and credentials->>'challenge' = $3 and verification_token = $5 and info->>'status' <> 'DELETED' returning info`,
      [domain, JSON.stringify(info), credentials.challenge, ready, verification])
    } catch (error) {
      if (error instanceof Error && (error.message.includes("MAIL_ADDRESS_CONFLICT") || (error as { code?: string }).code === "23505"))
        throw new MailError("That email address is already used by another mailbox", "domain_conflict", 409)
      throw error
    }
    if (updated?.info) return updated.info
    const current = await this.row(domain)
    if (current.credentials?.challenge !== credentials.challenge) throw new MailError("Custom domain not found", "not_found", 404)
    return current.info
  }

  async ready(domain: string): Promise<DomainRow> {
    let row = await this.row(domain)
    const recent = row.verified_at && Date.now() - Date.parse(row.verified_at) < 5 * 60_000
    if (row.info.status !== "VERIFIED" || !recent) {
      await this.verify(domain)
      row = await this.row(domain)
    }
    if (row.info.status !== "VERIFIED") throw new MailError("Verify this domain's DNS records before using it", "domain_not_ready", 422)
    return row
  }

  async signingKey(domain: string): Promise<{ domainName: string; keySelector: string; privateKey: string }> {
    const row = await this.ready(domain)
    return { domainName: domain, keySelector: row.credentials!.selector, privateKey: await this.decrypt(domain, row.credentials!.encryptedKey) }
  }
}
