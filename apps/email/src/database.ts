import { createHash } from "node:crypto"
import { Client } from "pg"
import { migrations } from "./schema.js"

export interface DatabaseQueries {
  query<T = Record<string, unknown>>(text: string, parameters?: unknown[]): Promise<T[]>
}
export interface Database extends DatabaseQueries {
  transaction<T>(task: (db: DatabaseQueries) => Promise<T>): Promise<T>
}

async function withConnection<T>(connectionString: string, task: (client: Client) => Promise<T>): Promise<T> {
  // Each operation owns its socket; transactions keep it until commit/rollback.
  const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 })
  client.on("error", () => {})
  try { await client.connect(); return await task(client) }
  finally {
    // A disconnect failure must not turn a committed send reservation into a retry.
    await client.end().catch(() => {})
  }
}
const queries = (client: Client): DatabaseQueries => ({
  async query<T>(text: string, parameters: unknown[] = []): Promise<T[]> {
    return (await client.query(text, parameters)).rows as T[]
  },
})
export const postgresDatabase = (connectionString: string): Database => ({
  query: (text, parameters) => withConnection(connectionString, client => queries(client).query(text, parameters)),
  transaction: task => withConnection(connectionString, async client => {
    await client.query("begin")
    try {
      const result = await task(queries(client))
      await client.query("commit")
      return result
    } catch (error) {
      await client.query("rollback").catch(() => {})
      throw error
    }
  }),
})

// Any edit to the migrations changes this marker, so a database that has it is up to date.
const schemaVersion = `schema-${createHash("sha256").update(JSON.stringify(migrations)).digest("hex").slice(0, 16)}`

export const migrate = async (db: DatabaseQueries): Promise<void> => {
  for (const statement of migrations) await db.query(statement)
  await db.query("insert into mail.schema_migrations(id) values ($1) on conflict do nothing", [schemaVersion])
}

const schemaRecorded = async (db: DatabaseQueries): Promise<boolean> => {
  const [row] = await db.query<{ recorded: boolean }>(
    "select exists(select 1 from mail.schema_migrations where id = $1) as recorded", [schemaVersion])
  return row?.recorded === true
}

// Brings the schema up to date through the Worker's own connection. A current database costs one
// query. Otherwise one transaction holds a fixed advisory lock, so isolates that start together
// migrate once, and a failure rolls back everything. It runs as the connecting user and never
// changes role, unlike `pnpm migrate`.
export const ensureSchema = async (db: Database): Promise<"current" | "migrated"> => {
  try {
    if (await schemaRecorded(db)) return "current"
  } catch (error) {
    // 42P01: a fresh database has no mail.schema_migrations table yet.
    if ((error as { code?: unknown }).code !== "42P01") throw error
  }
  return db.transaction(async tx => {
    await tx.query("select pg_advisory_xact_lock(hashtext('bezalel-email-schema'))")
    // Another isolate may have finished while this one waited for the lock.
    const [table] = await tx.query<{ present: boolean }>(
      "select to_regclass('mail.schema_migrations') is not null as present")
    if (table?.present && await schemaRecorded(tx)) return "current"
    await migrate(tx)
    return "migrated"
  })
}
