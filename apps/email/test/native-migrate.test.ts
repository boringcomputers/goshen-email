import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it.each([
  "",
  "not-a-url-with-private-password",
  "postgres://bezalel_email:private-password@localhost/bezalel_email",
  "postgres://bezalel_email:private-password@ep-bold-cherry-ax6egul8.c-4.us-east-2.aws.neon.tech/neondb",
  "postgres://bezalel_email_runtime:private-password@ep-bold-cherry-ax6egul8.c-4.us-east-2.aws.neon.tech/bezalel_email",
  "postgres://postgres:private-password@us-east-1.pg.psdb.cloud/postgres",
])("rejects a missing or incorrect native migration target without exposing credentials (%#)", async (url) => {
  try {
    await promisify(execFile)("pnpm", ["exec", "tsx", "scripts/migrate-native.ts"], {
      env: { ...process.env, NATIVE_DATABASE_URL: url }, timeout: 5_000,
    })
    throw new Error("Unexpected successful migration")
  } catch (error) {
    const failure = error as { code?: number; stderr?: string }
    expect(failure.code).toBe(1)
    expect(failure.stderr).toContain("NATIVE_DATABASE_URL must")
    expect(failure.stderr).not.toContain("private-password")
  }
})
