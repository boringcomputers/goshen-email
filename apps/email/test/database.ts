import { randomUUID } from "node:crypto"
import { PGlite } from "@electric-sql/pglite"
import { Client } from "pg"
import { afterAll } from "vitest"
import { postgresDatabase, type Database } from "../src/database.js"

const cleanups = new Set<() => Promise<void>>()
afterAll(async () => {
  for (const close of cleanups) await close()
})

export async function postgresFixture() {
  const target = new URL(process.env.TEST_DATABASE_URL ?? "")
  if (!["postgres:", "postgresql:"].includes(target.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname) ||
      !target.pathname.endsWith("_test") || target.search) {
    throw new Error("TEST_DATABASE_URL must name a dedicated local *_test database without query parameters")
  }
  const admin = postgresDatabase(target.href)
  const name = `hyperdrive_${randomUUID().replaceAll("-", "")}`
  await admin.query(`create database ${name}`)
  target.pathname = `/${name}`
  const connectionString = target.href
  const db = postgresDatabase(connectionString)
  const close = async () => {
    if (!cleanups.has(close)) return
    await admin.query(`drop database ${name} with (force)`)
    cleanups.delete(close)
  }
  cleanups.add(close)
  return {
    db, connectionString,
    pg: {
      async exec(text: string) {
        const client = new Client({ connectionString })
        try { await client.connect(); await client.query(text) }
        finally { await client.end() }
      },
      close
    }
  }
}

export async function testDatabase(): Promise<{
  db: Database
  connectionString?: string
  pg: { exec(text: string): Promise<unknown>; close(): Promise<void> }
}> {
  if (process.env.TEST_DATABASE_URL) return postgresFixture()
  const pg = new PGlite()
  const db: Database = {
    query: async <T>(text: string, params: unknown[] = []) =>
      (await pg.query<T>(text, params)).rows
  }
  return { pg, db }
}
