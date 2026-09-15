import { PGlite } from "@electric-sql/pglite"
import { vi } from "vitest"
import { MailService } from "../src/mail-service.js"
import { MailboxStore } from "../src/mailbox-store.js"
import { migrate, type Database } from "../src/database.js"
import type { MailConfig, ObjectStore, Transport } from "../src/contracts.js"
import type { MessageProtection } from "../src/protection.js"

export const cleanProtection = (): MessageProtection => ({
  status: "clean", scannedAt: new Date().toISOString(),
  authentication: { spf: "pass", dkim: "pass", dmarc: "pass", signingDomains: ["example.net"] },
  spam: { score: 0, threshold: 6 }, antivirus: { status: "clean", signatures: [] }, reasons: [],
})

export const config: MailConfig = {
  accountId: "b".repeat(32),
  defaultDomain: "example.com",
  domains: { "example.com": "a".repeat(32) },
  publicUrl: "https://mail.example.com",
  eventsUrl: "https://plane.example.com/events/cloudflare",
  apiToken: "test-api-token-".repeat(3),
  webhookSecret: `whsec_${Buffer.from("test-secret-for-email-webhooks-1234").toString("base64")}`
}

export const fixture = async () => {
  const pg = new PGlite()
  const db: Database = {
    query: async <T>(text: string, params: unknown[] = []) =>
      (await pg.query<T>(text, params)).rows
  }
  await migrate(db)
  const blobs = new Map<string, Uint8Array>()
  const objects: ObjectStore = {
    async put(key, body) {
      blobs.set(
        key,
        typeof body === "string"
          ? new TextEncoder().encode(body)
          : new Uint8Array(body)
      )
    },
    async get(key) {
      const value = blobs.get(key)
      return value ? { body: new Response(value).body! } : null
    },
    async list({ prefix, limit = 1000 }) {
      const keys = [...blobs.keys()].filter((key) => key.startsWith(prefix))
      return {
        objects: keys.slice(0, limit).map((key) => ({ key })),
        truncated: keys.length > limit
      }
    },
    async delete(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys)
        blobs.delete(key)
    }
  }
  const send = vi
    .fn<Transport["send"]>()
    .mockImplementation(async (input) => ({
      messageId: `<${crypto.randomUUID()}@cloudflare.test>`,
      delivered: input.to,
      queued: [],
      bounced: [],
      suppressed: []
    }))
  const verifyDomain = vi
    .fn<Transport["verifyDomain"]>()
    .mockImplementation(async (domain) => ({
      domainId: domain,
      domain,
      status: "VERIFIED",
      records: []
    }))
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"))
  const service = new MailService({
    store: new MailboxStore(db),
    objects,
    transport: { send, verifyDomain },
    config,
    request
  })
  return { pg, db, blobs, objects, send, verifyDomain, request, service }
}

export const rawMail = (
  options: {
    id?: string
    subject?: string
    references?: string
    html?: boolean
    attachment?: boolean
  } = {}
) =>
  new TextEncoder().encode(
    [
      "From: Customer <customer@example.net>",
      "To: Agent <agent@example.com>",
      "Cc: colleague@example.net",
      "Reply-To: support@example.net",
      `Message-ID: ${options.id ?? "<incoming@example.net>"}`,
      `Subject: ${options.subject ?? "Invoice question"}`,
      ...(options.references
        ? [
            `In-Reply-To: ${options.references}`,
            `References: ${options.references}`
          ]
        : []),
      "MIME-Version: 1.0",
      "Content-Type: multipart/mixed; boundary=mail-test",
      "",
      "--mail-test",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Please check invoice number 42.",
      ...(options.html
        ? [
            "--mail-test",
            "Content-Type: text/html; charset=utf-8",
            "",
            "<p>Please check invoice number 42.</p>"
          ]
        : []),
      ...(options.attachment
        ? [
            "--mail-test",
            'Content-Type: text/plain; name="invoice.txt"',
            'Content-Disposition: attachment; filename="invoice.txt"',
            "Content-Transfer-Encoding: base64",
            "",
            "SW52b2ljZSA0Mg=="
          ]
        : []),
      "--mail-test--",
      ""
    ].join("\r\n")
  )
