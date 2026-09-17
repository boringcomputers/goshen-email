import { Client } from "pg"
import { migrate } from "../src/database.js"

// This release retains the native database and its existing schema owner.
const connection = (() => {
  try { return new URL(process.env.NATIVE_DATABASE_URL ?? "") }
  catch { throw new Error("NATIVE_DATABASE_URL must be a PostgreSQL URL") }
})()
if (!["postgres:", "postgresql:"].includes(connection.protocol) ||
    connection.hostname !== "ep-bold-cherry-ax6egul8.c-4.us-east-2.aws.neon.tech" ||
    connection.pathname !== "/bezalel_email" || connection.username !== "bezalel_email") {
  throw new Error("NATIVE_DATABASE_URL must identify the existing native mail database and schema owner")
}
connection.searchParams.set("sslmode", "verify-full")
const client = new Client({ connectionString: connection.href, connectionTimeoutMillis: 10_000 })
client.on("error", () => {})
try {
  await client.connect()
  await client.query("begin")
  await client.query("set local lock_timeout = '2s'")
  await client.query("set local statement_timeout = '15s'")
  const { rows: [identity] } = await client.query(`select current_database() as database, current_user as role,
    (select pg_get_userbyid(nspowner) from pg_namespace where nspname='mail') as owner`)
  if (identity?.database !== "bezalel_email" || identity.role !== "bezalel_email" || identity.owner !== "bezalel_email") {
    throw new Error("Native schema identity does not match the release")
  }
  await client.query("select pg_advisory_xact_lock(hashtext('bezalel-email-native-migration'))")
  await migrate({ query: async <T>(text: string, parameters: unknown[] = []) =>
    (await client.query(text, parameters)).rows as T[] })
  await client.query("commit")
  console.log("Native email schema is ready")
} catch {
  await client.query("rollback").catch(() => {})
  throw new Error("Native schema migration failed; verify database state before retrying")
} finally {
  await client.end().catch(() => {})
}
