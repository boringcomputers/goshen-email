#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { GoshenEmailClient } from "@goshenemail/client"
import { createMailMcp } from "./index.js"
try {
  const client = new GoshenEmailClient({ apiKey: process.env.GOSHENEMAIL_API_KEY ?? "", baseUrl: process.env.GOSHENEMAIL_BASE_URL })
  await createMailMcp(client).connect(new StdioServerTransport())
} catch { process.stderr.write("Set GOSHENEMAIL_API_KEY to an account or mailbox key and GOSHENEMAIL_BASE_URL to your API origin.\n"); process.exitCode = 1 }
