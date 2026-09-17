import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it.each(["--deploy", "--no-dry-run", "--config", "--outdir"])(
  "rejects %s instead of forwarding extra arguments to Wrangler", async (argument) => {
    await expect(promisify(execFile)("pnpm", ["exec", "tsx", "scripts/build-native.ts", argument], { timeout: 10_000 }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("only runs Wrangler with --dry-run") })
  },
)
