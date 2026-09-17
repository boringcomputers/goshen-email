#!/usr/bin/env node
import { run } from "./index.js"
process.exitCode = await run(process.argv.slice(2), { env: process.env,
  readStdin: async () => { let text = ""; for await (const chunk of process.stdin) { text += chunk; if (Buffer.byteLength(text) > 5 * 1024 * 1024) throw new Error("Input exceeds 5 MiB") }; return text },
  out: text => process.stdout.write(text + "\n"), error: text => process.stderr.write(text + "\n"),
})
