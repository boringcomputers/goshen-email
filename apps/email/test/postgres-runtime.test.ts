import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { unstable_dev, type Unstable_DevWorker } from "wrangler"
import { migrate } from "../src/database.js"
import { postgresFixture } from "./database.js"
import { config, rawMail } from "./support.js"

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
