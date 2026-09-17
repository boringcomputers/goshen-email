import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, URL } from "node:url"

if (process.argv.length !== 2) throw new Error("The native build accepts no arguments and only runs Wrangler with --dry-run")

const root = new URL("../", import.meta.url)
const template = JSON.parse(await readFile(new URL("wrangler.native.template.json", root), "utf8"))
if (template.hyperdrive?.length !== 1 || template.hyperdrive[0].binding !== "HYPERDRIVE" ||
    template.hyperdrive[0].id !== "REQUIRES_PROVISIONED_NATIVE_HYPERDRIVE_ID") {
  throw new Error("The native build requires the preparation template")
}

const directory = await mkdtemp(join(tmpdir(), "bezalel-native-build-"))
try {
  const configuration = join(directory, "wrangler.json")
  await writeFile(configuration, JSON.stringify({
    ...template,
    name: "bezalel-email-native-build",
    main: fileURLToPath(new URL(template.main, root)),
    hyperdrive: [{ ...template.hyperdrive[0], id: "0".repeat(32) }],
  }), { mode: 0o600 })
  execFileSync("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--config", configuration,
    "--outdir", fileURLToPath(new URL("dist/native", root))], { cwd: fileURLToPath(root), stdio: "inherit" })
} finally {
  await rm(directory, { recursive: true, force: true })
}
