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

export const migrate = async (db: DatabaseQueries): Promise<void> => {
  for (const statement of migrations) await db.query(statement)
}
