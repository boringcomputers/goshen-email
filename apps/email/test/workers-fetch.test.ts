import { readdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

it('never passes redirect: "error", which the Workers runtime rejects before sending', async () => {
  const source = join(dirname(fileURLToPath(import.meta.url)), "../src")
  for (const file of (await readdir(source, { recursive: true })).filter((name) => name.endsWith(".ts")))
    expect(await readFile(join(source, file), "utf8"), file).not.toMatch(/redirect:\s*["']error["']/)
})
