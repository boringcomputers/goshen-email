import type { Env } from "../../src/worker.js"
import { config } from "../support.js"

// Synthetic values only. The native entry point accepts any deployment whose settings are
// complete and consistent, so tests never need the production Worker's identifiers.
export const nativeTestEnvironment = (): Env => ({
  HYPERDRIVE: { connectionString: "postgres://test:test@127.0.0.1:1/native_test" } as Hyperdrive,
  MAIL_API_TOKEN: config.apiToken, MAIL_WEBHOOK_SECRET: config.webhookSecret,
  CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
  EMAIL_DOMAINS: JSON.stringify({ "native.example.com": "b".repeat(32) }),
  DEFAULT_EMAIL_DOMAIN: "native.example.com", WORKER_NAME: "native-mail-test",
  PUBLIC_EMAIL_URL: "https://native-mail.example.com",
  MAIL_EVENTS_URL: "https://events.example.com/cloudflare",
  MAIL_OBJECTS: {} as R2Bucket,
})
