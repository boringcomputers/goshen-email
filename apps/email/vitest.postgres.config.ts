import { defineConfig } from "vitest/config"

if (!process.env.TEST_DATABASE_URL) throw new Error("TEST_DATABASE_URL is required for PostgreSQL tests")

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], fileParallelism: false, testTimeout: 30_000, hookTimeout: 30_000 }
})
