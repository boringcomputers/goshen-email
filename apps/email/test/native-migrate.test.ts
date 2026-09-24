import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"

const host = "native-db.example.test"
const run = (env: Record<string, string>) => {
  const { NATIVE_DATABASE_HOST: _host, NATIVE_DATABASE_URL: _url, ...base } = process.env
  return promisify(execFile)("pnpm", ["exec", "tsx", "scripts/migrate-native.ts"], { env: { ...base, ...env }, timeout: 5_000 })
}

it.each([
  "",
  "not-a-url-with-private-password",
  "postgres://bezalel_email:private-password@localhost/bezalel_email",
  `postgres://bezalel_email:private-password@${host}/neondb`,
  `postgres://bezalel_email_runtime:private-password@${host}/bezalel_email`,
  "postgres://bezalel_email:private-password@another-db.example.test/bezalel_email",
  "postgres://postgres:private-password@us-east-1.pg.psdb.cloud/postgres",
])("rejects a missing or incorrect native migration target without exposing credentials (%#)", async (url) => {
  try {
    await run({ NATIVE_DATABASE_HOST: host, NATIVE_DATABASE_URL: url })
    throw new Error("Unexpected successful migration")
  } catch (error) {
    const failure = error as { code?: number; stderr?: string }
    expect(failure.code).toBe(1)
    expect(failure.stderr).toContain("NATIVE_DATABASE_URL must")
    expect(failure.stderr).not.toContain("private-password")
  }
})

it.each(["", "   "])("refuses to run without the expected database host (%j)", async (value) => {
  try {
    await run({ NATIVE_DATABASE_HOST: value, NATIVE_DATABASE_URL: `postgres://bezalel_email:private-password@${host}/bezalel_email` })
    throw new Error("Unexpected successful migration")
  } catch (error) {
    const failure = error as { code?: number; stderr?: string }
    expect(failure.code).toBe(1)
    expect(failure.stderr).toContain("NATIVE_DATABASE_HOST must")
    expect(failure.stderr).not.toContain("private-password")
  }
})
