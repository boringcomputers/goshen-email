# Bezalel Email

Email inboxes for people and agents, with a standalone dashboard, an HTTP API,
and an optional SMTP gateway for custom domains.

This project extracts the email implementation from
[Bezalel](https://github.com/boringcomputers/bezalel). The original code stays in
Bezalel. This repository runs independently and retains the AGPL-3.0-only license.
See [SOURCE.md](SOURCE.md) for the source revision and how to carry fixes between projects.

## Included

- A dashboard for inboxes, conversations, search, composing, replies,
  attachments, custom-domain DNS records, delivery outcomes, and quarantine review.
- A Cloudflare Worker for mailbox storage, sending and receiving, threading,
  labels, signed webhooks, delivery tracking, and mailbox-scoped application keys.
- An SMTP gateway using Postfix, Rspamd, and ClamAV for domains at any DNS provider.
- PostgreSQL migrations, R2 attachment storage, local database tests, and deployment guides.

The dashboard supports one owner or a trusted team sharing access to the entire
deployment. Applications and agents use mailbox-scoped credentials.
Bezalel's multi-tenant accounts, billing, approval policies, analytics pages, and
MCP server stay in Bezalel. The standalone API uses HTTP JSON operations.

## Run the dashboard

Install Node.js 24 and pnpm 10.15.1. Set up the email Worker using the
[Worker guide](apps/email/README.md), then:

```sh
pnpm install --frozen-lockfile
cp apps/email-dashboard/.env.example apps/email-dashboard/.env
openssl rand -hex 32
```

Save the generated value as `DASHBOARD_PASSWORD`. Set `MAIL_WORKER_URL` to your
Worker's HTTPS origin and `MAIL_API_TOKEN` to its platform token. Use independent
values for the dashboard password and Worker token.

```sh
pnpm build
pnpm start
```

Open <http://127.0.0.1:3031> and sign in with the dashboard password. The Worker
token remains on the dashboard server. Sessions expire after eight hours,
sign-out revokes them, and restarting the dashboard signs everyone out.

For remote access, put the dashboard behind an HTTPS reverse proxy, set
`DASHBOARD_PUBLIC_URL` to its exact public origin, and preserve the incoming
Host header. Set `HOST=0.0.0.0` when the proxy runs outside the dashboard container.
The dashboard uses an HTTP-only, SameSite=Strict cookie and checks request origins.
Set `DASHBOARD_TRUSTED_PROXY_IPS` to the comma-separated IP addresses from which
your reverse proxy connects. Configure that proxy to overwrite `X-Real-IP` with
the client's connection IP. Login throttles then apply per client. Direct
connections use their socket address and ignore forwarded headers. Trusted
proxy requests without a valid `X-Real-IP` cannot sign in.

`pnpm dev` starts the dashboard with file watching. `pnpm dev:worker` starts
Wrangler separately. Local Worker development still needs a dedicated PostgreSQL
database. The root `build` command bundles the Worker without deploying it.

## Worker and SMTP deployment

Follow the [Worker setup](apps/email/README.md) for Cloudflare Email Sending,
Email Routing, PlanetScale Postgres through Hyperdrive, R2, and delivery queues.
Configuration uses placeholders and separate `bezalel-email-standalone` resource names. Set your own account,
domain, zone, bucket, and queue values before deployment.

```sh
pnpm migrate
pnpm deploy:worker
```

Follow the [PlanetScale and Hyperdrive guide](docs/planetscale.md) to create the database
connection and disable query caching. The checked-in binding ID is a placeholder.

Migration reads a direct PostgreSQL URL from `apps/email/.env`. Worker development
reads `apps/email/.dev.vars`; deployed secrets are set through Wrangler. Keep these
files out of Git. Run migrations before each Worker upgrade.

For customer-owned domains, follow the [SMTP gateway runbook](ops/email/README.md).
It covers DNS, reverse DNS, TLS, scanner health, durable queues, and backups.
The gateway needs a host that permits incoming and outgoing SMTP on port 25.

`MAIL_EVENTS_URL` optionally configures a shared signed webhook. With it unset,
shared-mailbox events are settled without delivery or later replay. Client
mailboxes keep their own provisioned webhooks. The legacy `BEZALEL_EVENTS_URL`
setting also works when connecting this Worker back to Bezalel.

## Connect an application or agent

The platform provisions a mailbox through `POST /clients/provision`, then gives
the application its returned mailbox-scoped API key. That key can read and send
only from its assigned inbox. It cannot provision other inboxes or release quarantine.

```sh
curl --fail-with-body "$MAIL_WORKER_URL/inbox-rpc/listMessages" \
  -H "Authorization: Bearer $MAILBOX_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"limit":20}'
```

See the [API guide](docs/api.md) for provisioning, sends, idempotency, webhooks,
and custom domains. Keep the platform token out of agent prompts and browsers.

## Checks

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm check
pnpm test
pnpm source:check
```

Tests use PGlite's embedded PostgreSQL, isolated files, local SMTP fixtures,
and simulated Cloudflare/R2 responses. They do not require Bezalel or a shared
database. Run `pnpm test:postgres` with a dedicated local `TEST_DATABASE_URL`
to repeat the mailbox tests through the production PostgreSQL driver and exercise the
Hyperdrive binding in the Workers runtime. See the [database guide](docs/planetscale.md#verification).

Live sending, public DNS, scanner deployment, and inbox placement
require the deployment canary in the SMTP runbook.

To exercise the dashboard against temporary mail storage without provider credentials:

```sh
pnpm --filter @bezalel/email exec tsx test/dashboard-fixture.ts
```

Open <http://127.0.0.1:3038>. The fixture password is
`fixture-dashboard-password-fixture-dashboard-password-`. It runs only on
loopback and never sends real email. Its test control endpoint on port 3039 can
inject mail with `POST /receive` and a JSON `inboxId`. Do not deploy the fixture.

Mail bodies render as text. Drafts remain in the open browser tab, and uncertain
sends retain their exact request ID for retry. The mailbox database retains
delivery outcomes and scanner findings; the dashboard shows those on each message.
