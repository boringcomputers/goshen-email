import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { readFileSync } from "node:fs"

const config = fileURLToPath(new URL("../wrangler.native.jsonc", import.meta.url).href)
const profile = JSON.parse(readFileSync(config, "utf8")) as {
  name: string; account_id: string; secrets: { required: string[] }
}
if (process.argv.length > 2 || profile.name !== "bezalel-email" ||
    profile.account_id !== "c340deebb91d89c14d17239b7658dc81") {
  throw new Error("Deploy the native profile without additional arguments")
}

// Wrangler retains existing secrets. Verify their names before activating code.
let bindings: { name: string; type: string }[]
try {
  bindings = JSON.parse(execFileSync("pnpm", ["exec", "wrangler", "secret", "list", "--config", config], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
  }))
} catch {
  throw new Error("Could not verify the existing native Worker secrets; deployment stopped")
}
const missing = profile.secrets.required.filter((name) =>
  !bindings.some((binding) => binding.name === name && binding.type === "secret_text"))
if (missing.length) throw new Error(`Native Worker secrets are missing: ${missing.join(", ")}; deployment stopped`)
console.log(`Verified ${profile.secrets.required.length} retained native Worker secrets`)
execFileSync("pnpm", ["exec", "wrangler", "deploy", "--config", config,
  "--message", "Native mail deployment from bezalel-email"], { stdio: "inherit" })
