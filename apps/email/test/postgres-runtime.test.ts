import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { unstable_dev, type Unstable_DevWorker } from "wrangler"
import { migrate, postgresDatabase } from "../src/database.js"
import { postgresFixture } from "./database.js"
import { config, rawMail } from "./support.js"

it("the migration command preserves postgres ownership and application grants for temporary logins", async () => {
  const database = await postgresFixture()
  const suffix = randomUUID().replaceAll("-", "")
  const migrator = `migrator_${suffix}`
  const application = `application_${suffix}`
  const password = randomUUID()
  const connection = new URL(database.connectionString)
  const roles: string[] = []
  try {
    await database.db.query(`create role ${migrator} login noinherit password '${password}'`)
    roles.push(migrator)
    await database.db.query(`create role ${application}`)
    roles.push(application)
    await database.db.query(`grant postgres to ${migrator}`)
    await database.db.query(`grant create on database ${connection.pathname.slice(1)} to ${migrator}`)
    await database.db.query(`alter default privileges for role postgres grant select, insert, update, delete on tables to ${application}`)
    await database.db.query("alter default privileges for role postgres revoke execute on functions from public")
    await database.db.query(`alter default privileges for role postgres grant execute on functions to ${application}`)
    connection.username = migrator
    connection.password = password
    const result = await promisify(execFile)("pnpm", ["migrate"], {
      env: { ...process.env, DATABASE_URL: connection.href }, timeout: 20_000
    })
    expect(result.stdout).toContain("Email schema is ready")
    const tables = await database.db.query<{ owner: string; readable: boolean; writable: boolean }>(
      `select pg_get_userbyid(c.relowner) as owner,
        has_table_privilege($1,c.oid,'SELECT') as readable,
        has_table_privilege($1,c.oid,'INSERT') and has_table_privilege($1,c.oid,'UPDATE')
          and has_table_privilege($1,c.oid,'DELETE') as writable
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='mail' and c.relkind='r'`, [application])
    expect(tables).toHaveLength(17)
    for (const table of tables) expect(table).toEqual({ owner: "postgres", readable: true, writable: true })
    const functions = await database.db.query<{ owner: string; executable: boolean }>(
      `select pg_get_userbyid(p.proowner) as owner, has_function_privilege($1,p.oid,'EXECUTE') as executable
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='mail'`, [application])
    expect(functions).toHaveLength(11)
    for (const routine of functions) expect(routine).toEqual({ owner: "postgres", executable: true })
  } finally {
    await database.pg.close()
    const admin = postgresDatabase(process.env.TEST_DATABASE_URL!)
    for (const role of roles.reverse()) await admin.query(`drop role ${role}`)
  }
})

describe("Hyperdrive in the Workers runtime with PostgreSQL", () => {
  let database: Awaited<ReturnType<typeof postgresFixture>>
  let worker: Unstable_DevWorker
  let directory: string
  beforeAll(async () => {
    database = await postgresFixture()
    await migrate(database.db)
    await migrate(database.db)
    directory = await mkdtemp(join(tmpdir(), "bezalel-hyperdrive-"))
    const configuration = join(directory, "wrangler.json")
    await writeFile(configuration, JSON.stringify({
      name: "postgres-runtime-test",
      main: resolve("test/fixtures/postgres-worker.ts"),
      compatibility_date: "2026-09-06", compatibility_flags: ["nodejs_compat"],
      hyperdrive: [{ binding: "HYPERDRIVE", id: "0".repeat(32), localConnectionString: database.connectionString }],
      r2_buckets: [{ binding: "MAIL_OBJECTS", bucket_name: "postgres-runtime-test" }],
      vars: {
        AUTH_PUBLIC_URL: 'https://accounts.example.com', AUTH_SECRET: 'runtime-account-secret-'.repeat(3),
        AUTH_PROXY_SECRET: 'runtime-proxy-secret-'.repeat(3), AUTH_FROM: 'accounts@example.com',
        MAIL_API_TOKEN: config.apiToken, MAIL_WEBHOOK_SECRET: config.webhookSecret,
        CLOUDFLARE_API_TOKEN: "test-token", CLOUDFLARE_ACCOUNT_ID: config.accountId,
        EMAIL_DOMAINS: JSON.stringify(config.domains), DEFAULT_EMAIL_DOMAIN: config.defaultDomain,
        PUBLIC_EMAIL_URL: config.publicUrl, WORKER_NAME: "postgres-runtime-test",
      }
    }), { mode: 0o600 })
    worker = await unstable_dev("test/fixtures/postgres-worker.ts", {
      config: configuration, local: true, ip: "127.0.0.1", port: 0, inspectorPort: 0,
      logLevel: "error", experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
    })
  })
  afterAll(async () => {
    await worker?.stop()
    await database?.pg.close()
    if (directory) await rm(directory, { recursive: true, force: true })
  })
  const rpc = async (operation: string, input: unknown) => {
    const response = await worker.fetch(`http://localhost/rpc/${operation}`, {
      method: "POST", headers: { authorization: `Bearer ${config.apiToken}` }, body: JSON.stringify(input)
    })
    const body = await response.json() as any
    expect(response.status, JSON.stringify(body)).toBe(200)
    return body.result
  }
  it("runs passwordless links, codes, sessions, and revocation inside workerd", async () => {
    const headers = { authorization: 'Bearer ' + 'runtime-proxy-secret-'.repeat(3), origin: 'https://accounts.example.com',
      'content-type': 'application/json', 'x-bezalel-client-ip': '192.0.2.1' }
    expect((await worker.fetch('http://localhost/healthz', { signal: AbortSignal.timeout(5000) })).status).toBe(200)
    const signup = await worker.fetch('http://localhost/api/auth/sign-in/magic-link', { method: 'POST', headers,
      body: JSON.stringify({ email: 'runtime@example.net', name: 'Runtime', callbackURL: 'https://accounts.example.com/app' }) })
    expect(signup.status, await signup.clone().text()).toBe(200)
    const sent = await (await worker.fetch('http://localhost/__test/auth-email')).json() as { text: string }
    const verification = new URL(sent.text.match(/https:\/\/\S+/)![0])
    const fragment = new URLSearchParams(verification.hash.slice(1))
    const verified = await worker.fetch('http://localhost/api/auth/magic-link/verify', { method: 'POST', headers,
      body: JSON.stringify({ token: fragment.get('token'), email: fragment.get('email') }) })
    expect(verified.status, await verified.clone().text()).toBe(200)
    const cookie = verified.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ')
    expect(cookie).toContain('session_token=')
    const session = await worker.fetch('http://localhost/account-rpc/session', { method: 'POST', headers: { ...headers, cookie }, body: '{}' })
    expect(session.status, await session.clone().text()).toBe(200)
    const signedOut = await worker.fetch('http://localhost/api/auth/sign-out', { method: 'POST', headers: { ...headers, cookie }, body: '{}' })
    expect(signedOut.status).toBe(200)
    const denied = await worker.fetch('http://localhost/account-rpc/session', { method: 'POST', headers: { ...headers, cookie }, body: '{}' })
    expect(denied.status).toBe(401)
    const sendCode = await worker.fetch('http://localhost/api/auth/email-otp/send-verification-otp', { method: 'POST', headers,
      body: JSON.stringify({ email: 'runtime@example.net', type: 'sign-in' }) })
    expect(sendCode.status).toBe(200)
    const email = await (await worker.fetch('http://localhost/__test/auth-email')).json() as { text: string }
    const code = email.text.match(/\b\d{6}\b/)![0]
    const codeSignIn = await worker.fetch('http://localhost/api/auth/sign-in/email-otp', { method: 'POST', headers,
      body: JSON.stringify({ email: 'runtime@example.net', otp: code }) })
    expect(codeSignIn.status, await codeSignIn.clone().text()).toBe(200)
    expect(codeSignIn.headers.get('set-cookie')).toContain('session_token=')

  })
  it("creates an inbox and reads it from independent concurrent requests", async () => {
    const created = await rpc("createInbox", { username: "runtime" })
    expect(created).toMatchObject({ inboxId: "runtime@example.com", createdAt: expect.any(String) })
    const responses = await Promise.all(Array.from({ length: 8 }, () => rpc("listInboxes", {})))
    for (const response of responses) expect(response.inboxes).toContainEqual(created)
  })
  it("preserves send idempotency across requests and immediate reads", async () => {
    const input = { inboxId: "runtime@example.com", to: ["recipient@example.net"],
      subject: "Hyperdrive send", text: "A message", idempotencyKey: "runtime-send" }
    const first = await rpc("send", input)
    const replay = await rpc("send", input)
    expect(replay).toMatchObject({ messageId: first.messageId, deduplicated: true })
    const [row] = await database.db.query<{ count: number }>("select count(*)::int as count from mail.sends")
    expect(row?.count).toBe(1)
    expect(await rpc("getMessage", { inboxId: input.inboxId, messageId: first.messageId }))
      .toMatchObject({ subject: input.subject, text: input.text, labels: expect.arrayContaining(["sent"]) })
  })
  it("receives MIME, finishes background processing, and searches the stored mail", async () => {
    const response = await worker.fetch("http://localhost/__test/receive", { method: "POST", body: rawMail() })
    expect(await response.json()).toMatchObject({ accepted: true })
    await expect.poll(async () => {
      const result = await rpc("searchMessages", { inboxId: "runtime@example.com", query: "invoice" })
      return result.messages.length
    }).toBe(1)
    expect(await rpc("getMessage", { inboxId: "runtime@example.com", messageId: "<incoming@example.net>" }))
      .toMatchObject({ subject: "Invoice question", text: expect.stringContaining("invoice number 42") })
    expect((await worker.fetch("http://localhost/__test/scheduled")).status).toBe(200)
  })
})
