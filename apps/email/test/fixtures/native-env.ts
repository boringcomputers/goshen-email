import type { Env } from "../../src/worker.js"
import { config } from "../support.js"

export const nativeTestEnvironment = (): Env => ({
  HYPERDRIVE: { connectionString: "postgres://test:test@127.0.0.1:1/native_test" } as Hyperdrive,
  MAIL_API_TOKEN: config.apiToken, MAIL_WEBHOOK_SECRET: config.webhookSecret,
  CLOUDFLARE_ACCOUNT_ID: "c340deebb91d89c14d17239b7658dc81",
  EMAIL_DOMAINS: JSON.stringify({ "goshenemail.com": "35ea2f533f87f566600d95300aba1475" }),
  DEFAULT_EMAIL_DOMAIN: "goshenemail.com", WORKER_NAME: "bezalel-email",
  PUBLIC_EMAIL_URL: "https://bezalel-email.michaelwasihun96.workers.dev",
  MAIL_EVENTS_URL: "https://mcp.bezalel.sh/events/cloudflare",
  MAIL_OBJECTS: {} as R2Bucket,
})
