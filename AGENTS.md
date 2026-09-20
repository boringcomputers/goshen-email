# Goshen Email

Use Node.js 24 and pnpm 10.15.1. Make changes on a task branch in an isolated
worktree. Keep the source license and provenance manifest. Do not merge a PR
without explicit instruction.

The Worker in `apps/email` owns mailbox storage, delivery, and application
credentials. `apps/email-gateway` owns SMTP transport and scanners.
`apps/email-dashboard` is an owner interface with a server-side Worker client.
Keep mailbox tokens scoped, secrets out of browser responses, send idempotency
intact, and quarantine decisions in the Worker.

Run `pnpm build`, `pnpm check`, `pnpm test`, and `pnpm source:check`.
Use `homelab-job` for full suites when available. Tests use isolated local
databases. Never run tests or migrations against production resources.
For browser evidence, use `apps/email/test/dashboard-fixture.ts`. Record which
provider operations use test doubles. Do not present simulated delivery as live mail.

Update SOURCE.json deliberately when changing extracted files. Carry shared
fixes back to Bezalel through a separate reviewed change. Never overwrite another
checkout's work or deploy Worker, SMTP, or DNS changes as part of a code-only task.
