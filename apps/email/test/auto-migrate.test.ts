import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ensureSchema, migrate, type Database, type DatabaseQueries } from "../src/database.js"
import type { Env } from "../src/worker.js"
import { testDatabase } from "./database.js"
import { config } from "./support.js"

// The Worker reaches each test database through its Hyperdrive connection string.
const hyperdrive = vi.hoisted(() => new Map<string, Database>())
vi.mock("../src/database.js", async (original) => {
  const actual = await original<typeof import("../src/database.js")>()
  return { ...actual, postgresDatabase: (url: string) => hyperdrive.get(url) ?? actual.postgresDatabase(url) }
})

const closers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const close of closers.splice(0)) await close()
})

// Records every statement and can fail the ones a test picks.
const database = async () => {
  const { db, pg } = await testDatabase()
  closers.push(() => pg.close())
  const statements: string[] = []
  const state = { transactions: 0, fail: undefined as ((text: string) => boolean) | undefined }
  const queries = (target: DatabaseQueries): DatabaseQueries => ({
    async query<T>(text: string, parameters?: unknown[]) {
      statements.push(text)
      if (state.fail?.(text)) throw new Error("database unavailable")
      return target.query<T>(text, parameters)
    },
  })
  const tracked: Database = {
    ...queries(db),
    transaction: task => {
      state.transactions++
      return db.transaction(tx => task(queries(tx)))
    },
  }
  const url = `postgres://hyperdrive.test/${randomUUID()}`
  hyperdrive.set(url, tracked)
  return { db: tracked, statements, state, url }
}

// A fresh module graph stands in for a new isolate with nothing memoized.
const isolate = async () => {
  vi.resetModules()
  return (await import("../src/worker.js")).default
}

const environment = (url: string, setting?: string): Env => ({
  HYPERDRIVE: { connectionString: url } as Hyperdrive,
  MAIL_API_TOKEN: config.apiToken, MAIL_WEBHOOK_SECRET: config.webhookSecret,
  CLOUDFLARE_API_TOKEN: "test-token", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  EMAIL_DOMAINS: JSON.stringify(config.domains), DEFAULT_EMAIL_DOMAIN: config.defaultDomain,
  PUBLIC_EMAIL_URL: config.publicUrl, WORKER_NAME: "auto-migrate-test", MAIL_OBJECTS: {} as R2Bucket,
  MAIL_AUTO_MIGRATE_ENABLED: setting,
})
const context = () => ({ waitUntil: vi.fn(), passThroughOnException: vi.fn() }) as unknown as ExecutionContext
const listInboxes = (authorized = true) => new Request("https://mail.example.com/rpc/listInboxes", {
  method: "POST", headers: authorized ? { authorization: `Bearer ${config.apiToken}` } : {}, body: "{}",
})
const schemaObjects = (db: DatabaseQueries) => db.query(`
  select c.relname as name, c.relkind::text as kind from pg_class c
    join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'mail'
  union all select p.proname, 'function' from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'mail'
  order by 1, 2`)
const markers = (db: DatabaseQueries) => db.query("select id from mail.schema_migrations order by id")
const markerLookup = "select exists(select 1 from mail.schema_migrations where id = $1) as recorded"

describe("MAIL_AUTO_MIGRATE_ENABLED", () => {
  it("leaves the database alone unless it is true", async () => {
    for (const setting of [undefined, "false"]) {
      const { db, statements, state, url } = await database()
      const worker = await isolate()
      expect((await worker.fetch(listInboxes(), environment(url, setting), context())).status).toBe(500)
      expect(statements.some((text) => text.includes("schema_migrations"))).toBe(false)
      expect(state.transactions).toBe(0)
      expect(await db.query("select to_regclass('mail.schema_migrations') as marker")).toEqual([{ marker: null }])
    }
    const { url } = await database()
    const response = await (await isolate()).fetch(listInboxes(), environment(url, "yes"), context())
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: "not_configured" } })
  })

  it("applies the full schema to an empty database before it serves the first request", async () => {
    const { db, statements, url } = await database()
    const reference = await testDatabase()
    closers.push(() => reference.pg.close())
    await migrate(reference.db)
    const worker = await isolate()
    const env = environment(url, "true")
    expect((await worker.fetch(new Request("https://mail.example.com/healthz"), env, context())).status).toBe(200)
    expect(statements).toEqual([])
    const ctx = context()
    const response = await worker.fetch(listInboxes(), env, ctx)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ result: { inboxes: [] } })
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1)
    expect(await schemaObjects(db)).toEqual(await schemaObjects(reference.db))
    expect(await markers(db)).toEqual(await markers(reference.db))
    expect(statements.some((text) => /set\s+(local\s+)?role/i.test(text))).toBe(false)
  })

  it("costs one marker lookup per isolate once the schema is current", async () => {
    const { db, statements, state, url } = await database()
    await migrate(db)
    statements.length = 0
    const env = environment(url, "true")
    const first = await isolate()
    expect((await first.fetch(listInboxes(false), env, context())).status).toBe(401)
    expect((await first.fetch(listInboxes(false), env, context())).status).toBe(401)
    const second = await isolate()
    expect((await second.fetch(listInboxes(false), env, context())).status).toBe(401)
    expect(statements).toEqual([markerLookup, markerLookup])
    expect(state.transactions).toBe(0)
    expect(await ensureSchema(db)).toBe("current")
  })

  it("migrates an empty database once when isolates and requests start together", async () => {
    const isolates = await database()
    const results = await Promise.all(Array.from({ length: 4 }, () => ensureSchema(isolates.db)))
    expect(results.sort()).toEqual(["current", "current", "current", "migrated"])
    expect(await markers(isolates.db)).toHaveLength(2)

    const { state, url } = await database()
    const worker = await isolate()
    const env = environment(url, "true")
    const responses = await Promise.all(Array.from({ length: 6 }, () => worker.fetch(listInboxes(), env, context())))
    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(200))
    expect(state.transactions).toBe(1)
  })

  it("fails every event while the schema cannot be checked and retries on the next one", async () => {
    const { statements, state, url } = await database()
    state.fail = () => true
    const worker = await isolate()
    const env = environment(url, "true")
    const response = await worker.fetch(listInboxes(), env, context())
    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: {
      message: "Email operation failed", code: "internal_error", transient: true,
    } })
    const setReject = vi.fn()
    await expect(worker.email({
      from: "customer@example.net", to: "agent@example.com", raw: new Response("mail").body!, rawSize: 4, setReject,
    } as unknown as ForwardableEmailMessage, env, context())).rejects.toThrow("Email could not be stored")
    expect(setReject).not.toHaveBeenCalled()
    const message = { body: {}, ack: vi.fn(), retry: vi.fn() }
    const batch = { messages: [message], retryAll: vi.fn(), ackAll: vi.fn() }
    await worker.queue(batch as unknown as MessageBatch<unknown>, env, context())
    expect(batch.retryAll).toHaveBeenCalledWith({ delaySeconds: 60 })
    expect(message.ack).not.toHaveBeenCalled()
    expect(message.retry).not.toHaveBeenCalled()
    await expect(worker.scheduled({} as ScheduledController, env, context())).rejects.toThrow("database unavailable")
    expect(statements).toEqual(Array(4).fill(markerLookup))
    state.fail = undefined
    expect((await worker.fetch(listInboxes(), env, context())).status).toBe(200)
  })

  it("rolls back a migration that fails partway and finishes it on the next attempt", async () => {
    const { db, state } = await database()
    state.fail = (text) => text.includes("create table if not exists mail.sends")
    await expect(ensureSchema(db)).rejects.toThrow("database unavailable")
    expect(await db.query("select to_regclass('mail.inboxes') as inboxes")).toEqual([{ inboxes: null }])
    state.fail = undefined
    expect(await ensureSchema(db)).toBe("migrated")
    expect(await ensureSchema(db)).toBe("current")
  })
})
