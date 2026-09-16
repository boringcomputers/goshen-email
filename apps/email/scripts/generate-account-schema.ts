import { customerMigrations } from "../src/customer-schema.js"
import { URL } from "node:url"
import { writeFile } from "node:fs/promises"
import { KyselyPGlite } from "kysely-pglite"
import { getMigrations } from "better-auth/db/migration"
import { accountOptions } from "../src/account-auth.js"
import type { MailService } from "../src/mail-service.js"

// Schema generation uses a fresh in-memory database, never deployment credentials.
const pg = new KyselyPGlite()
await pg.client.exec("create schema mail")
const options = accountOptions({ publicUrl: "https://accounts.example.com", secret: "schema-only-".repeat(4), proxySecret: "schema-only-".repeat(4), from: "accounts@example.com", adminEmails: [] }, pg.dialect, {} as MailService)
const plan = await getMigrations(options)
const sql = (await plan.compileMigrations()).replaceAll("create table ", "create table if not exists ").replaceAll("create index ", "create index if not exists ").replaceAll("create unique index ", "create unique index if not exists ")
const statements = sql.split(";").map((s) => s.trim()).filter(Boolean)
statements.push("alter table mail.customers add column if not exists auth_user_id uuid unique references mail.auth_users(id)")
await writeFile(new URL("../src/account-schema.ts", import.meta.url), `// Generated from Better Auth 1.7.5; review before applying to any database.\nexport const accountMigrations = ${JSON.stringify(statements, null, 2)}\n`)
await writeFile(new URL("../../../ops/email/account-auth.sql", import.meta.url), `-- Public account rollout, including the customer ownership schema.
-- Review and obtain production migration approval before execution.
-- Apply using the schema owner; existing default application grants must be present.
BEGIN;
SET LOCAL ROLE postgres;
${[...customerMigrations, ...statements].join(";\n\n")};
COMMIT;
`)
await pg.client.close()
