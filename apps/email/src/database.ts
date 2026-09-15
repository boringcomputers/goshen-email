import { Client } from "pg"
import { migrations } from "./schema.js"

export interface Database {
  query<T = Record<string, unknown>>(
    text: string,
    parameters?: unknown[]
  ): Promise<T[]>
}

export const postgresDatabase = (connectionString: string): Database => ({
  async query<T>(text: string, parameters: unknown[] = []): Promise<T[]> {
    // Hyperdrive pools origin connections. Keep each socket inside its query so
    // email, queue, and scheduled work never reuse another event's connection.
    const client = new Client({ connectionString, connectionTimeoutMillis: 10_000 })
    // Connection failures also reject connect/query; don't log database secrets.
    client.on("error", () => {})
    try {
      await client.connect()
      const result = await client.query(text, parameters)
      return result.rows as T[]
    } finally {
      // A disconnect failure must not turn a committed send reservation into a retry.
      await client.end().catch(() => {})
    }
  }
})

export const migrate = async (db: Database): Promise<void> => {
  for (const statement of migrations) await db.query(statement)
}
