#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { BezalelEmail } from "@bezalel/email-sdk"
import { createMailMcp } from "./index.js"
try {
  const client = new BezalelEmail({ apiKey: process.env.BEZALEL_API_KEY ?? "", baseUrl: process.env.BEZALEL_BASE_URL })
  await createMailMcp(client).connect(new StdioServerTransport())
} catch { process.stderr.write("Set BEZALEL_API_KEY to an account or mailbox key and BEZALEL_BASE_URL to your API origin.\n"); process.exitCode = 1 }
