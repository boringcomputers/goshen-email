import { afterEach, beforeEach, expect, it, vi } from "vitest"

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock("node:child_process", () => ({ execFileSync: execute }))
const names = ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "DATABASE_URL", "MAIL_API_TOKEN", "MAIL_WEBHOOK_SECRET"]
const originalArgv = process.argv
afterEach(() => { process.argv = originalArgv })
beforeEach(() => {
  vi.resetModules()
  execute.mockReset()
  process.argv = ["node", "deploy-native.ts"]
})
it.each(names)("blocks activation when the retained %s secret is absent", async (missing) => {
  execute.mockReturnValue(JSON.stringify(names.filter(name => name !== missing).map(name => ({ name, type: "secret_text" }))))
  await expect(import("../scripts/deploy-native.js")).rejects.toThrow(`Native Worker secrets are missing: ${missing}`)
  expect(execute).toHaveBeenCalledTimes(1)
})
it("stops on a failed secret inventory without echoing command output", async () => {
  execute.mockImplementation(() => { throw new Error("private command output") })
  await expect(import("../scripts/deploy-native.js")).rejects.toThrow("Could not verify the existing native Worker secrets")
  expect(execute).toHaveBeenCalledTimes(1)
})
it("deploys the fixed profile only after all existing secrets are verified", async () => {
  execute.mockReturnValueOnce(JSON.stringify(names.map(name => ({ name, type: "secret_text" }))))
  await import("../scripts/deploy-native.js")
  expect(execute).toHaveBeenCalledTimes(2)
  expect(execute.mock.calls[1]?.[1]).toEqual(["exec", "wrangler", "deploy", "--config", expect.stringContaining("wrangler.native.jsonc"),
    "--message", "Native mail deployment from bezalel-email"])
})
