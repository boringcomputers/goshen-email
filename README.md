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

The Cloudflare dashboard supports public passwordless accounts with magic links,
six-digit email codes, and sign-out. See the [account guide](docs/accounts.md) for
configuration and rollout.
The [Settings page](docs/settings.md) saves organization and profile names,
plus desktop and email notification preferences for each account.
Accounts see their own inboxes. Owners can manage all inboxes.
Applications and agents use an account API key to manage their account's inboxes.
Optional mailbox keys restrict an agent to a single inbox.
New accounts get a guided inbox setup with routing retries, a copyable agent
connection command, and checks for the first incoming email. See the
[inbox setup guide](docs/inbox-setup.md).
The [developer tools](docs/developers.md) add account API keys, a versioned HTTP
API with OpenAPI, TypeScript and Python SDKs, a JSON CLI, and hosted/stdio MCP.
One key works across all clients. Accounts have no default inbox-count cap and
can organize their inboxes into named groups.
See the [AgentMail comparison](docs/agentmail-comparison.md) for this release's
scope and remaining gaps. These additions require the documented migration and
deployment; packages are not yet published to registries.
Bezalel's billing, approval policies, and analytics stay in Bezalel.

## Homepage

The root page uses Fancy's **Bezalel Email Landing** layout from
[Paper](https://app.paper.design/file/01M2M5SZD5HN356SQFCWH7BCEN/1-0), with copy
about Bezalel Email's inboxes, mailbox API keys, attachments, and quarantine
review. The feature strip and setup cards describe existing capabilities.
The email thread and file names are illustrative examples.

The page shares the dashboard's Paper tokens and local Inter font. Smaller
screens reflow the cards, navigation, and product illustration. Sign-in, inbox,
and API key links open `/app`. Demo, sales, and unfinished footer destinations
remain `#` placeholders.

## Run the local owner dashboard

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

Open <http://127.0.0.1:3031> for the homepage, or
<http://127.0.0.1:3031/app> to sign in with the dashboard password. The Worker
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

## Cloudflare deployment

The API and dashboard both run on Cloudflare Workers:

- [Dashboard](https://bezalel-email-dashboard.michaelwasihun96.workers.dev/app)
- [API](https://bezalel-email-standalone.michaelwasihun96.workers.dev/healthz)

The dashboard uses Better Auth accounts, static assets for the interface, and a
service binding to the API. The API validates the session and mailbox ownership
on every request. Complete the approved schema migration and account configuration
before deploying account mode. Follow the [account guide](docs/accounts.md).
Cloudflare Access remains an optional invitation-based mode.

The Node dashboard remains available for local or VPS hosting with a shared owner
password. Its access includes every inbox, so use Cloudflare customer mode for
customer-facing deployments.

The API connects to PlanetScale through Hyperdrive and uses its own R2 bucket
and delivery queues. See the [database guide](docs/planetscale.md).

```sh
pnpm deploy:worker
pnpm deploy:dashboard
```

A push to `main` deploys these Workers after tests pass. Wrangler reads
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from GitHub Actions
secrets to upload the scripts. That token is not the Email Routing token
stored on the API Worker. The job does not apply SQL. Deploy the API before the
dashboard: a newer dashboard calls operations an older API rejects with
"Unknown dashboard operation", which the Settings page reports as an email API
that needs its latest deployment. Set `MAIL_API_TOKEN` and
`MAIL_WEBHOOK_SECRET` as API Worker secrets. Account mode also requires independent `AUTH_SECRET` and `AUTH_PROXY_SECRET`
values. Follow the account guide to configure both Workers before switching modes.

The API uses `agents.goshenemail.com` for standalone inboxes. Cloudflare shares
one catch-all across a zone, so this deployment creates an exact address rule
for each new inbox. The `goshenemail.com` catch-all continues to target the
original Bezalel Worker. The API verifies sending and public MX records before
provisioning an inbox, and refuses to overwrite a conflicting address rule.

Set a scoped `CLOUDFLARE_API_TOKEN` secret with Email Sending access, Email
Routing settings read access, and Email Routing Rules Write for this zone.
Until it is present, dashboard reads work but mailbox creation and sending fail
with a configuration error. Never deploy a short-lived Wrangler login token as
this secret. See the [Worker setup](apps/email/README.md).

A pull request runs CI only. A push to `main` deploys the Workers after those
tests pass, if that commit is still the tip of `main` and the Cloudflare
deploy secrets are set. The job does not deploy the SMTP gateway.
For customer-owned domains, follow the [SMTP gateway runbook](ops/email/README.md).
That gateway needs a host that permits incoming and outgoing SMTP on port 25.

Migration reads a direct PostgreSQL URL from `apps/email/.env`. Worker development
reads `apps/email/.dev.vars`; deployed secrets are set through Wrangler. Keep these
files out of Git. Apply required migrations separately before a Worker upgrade.

`MAIL_EVENTS_URL` optionally configures a shared signed webhook. With it unset,
shared-mailbox events are settled without delivery or later replay. Client
mailboxes keep their own provisioned webhooks. Customer dashboard inboxes have no
webhook by default and never fall back to the shared webhook. The legacy `BEZALEL_EVENTS_URL`
setting also works when connecting this Worker back to Bezalel.

## Connect an application or agent

Sign in and open **Developers** to create an account API key. Use that same key
with the REST API, SDKs, CLI, or MCP to create, group, and use multiple inboxes.
See the [developer guide](docs/developers.md) for setup and examples.

For restricted single-inbox access, the platform can provision a mailbox through
`POST /clients/provision` and give the application its returned mailbox key.
That key reads and sends only from its assigned inbox and cannot provision other
inboxes or release quarantine.

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

Open <http://127.0.0.1:3038> for the homepage or
<http://127.0.0.1:3038/app> for the dashboard. The fixture password is
`fixture-dashboard-password-fixture-dashboard-password-`. It runs only on
loopback and never sends real email. Its test control endpoint on port 3039 can
inject mail with `POST /receive` and a JSON `inboxId`. Do not deploy the fixture.

Mail bodies render as text. Drafts remain in the open browser tab, and uncertain
sends retain their exact request ID for retry. The mailbox database retains
delivery outcomes and scanner findings; the dashboard shows those on each message.
