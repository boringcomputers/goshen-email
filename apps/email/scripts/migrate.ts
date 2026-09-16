import { Client } from "pg"
import { migrate } from "../src/database.js"

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required")
const client = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10_000 })
client.on("error", () => {})
try {
  await client.connect()
  await client.query("begin")
  // Keep ownership and default grants consistent across temporary migration logins.
  await client.query("set local role postgres")
  await migrate({
    query: async <T>(text: string, parameters: unknown[] = []) =>
      (await client.query(text, parameters)).rows as T[]
  })
  await client.query("commit")
} catch (error) {
  await client.query("rollback").catch(() => {})
  throw error
} finally {
  await client.end().catch(() => {})
}
console.log("Email schema is ready")
