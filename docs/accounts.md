# Public accounts

Anyone can create a Bezalel Email account at `/sign-up`. Better Auth handles
email/password credentials, verification, recovery, and database sessions. The
email Worker owns these records in PostgreSQL. Passwords use the library's scrypt
hashing. A password must contain 12 to 128 characters.

The dashboard provides `/sign-in`, `/sign-up`, `/forgot-password`,
`/reset-password`, and `/verify-email`. Verification is required before a session
can access mail. Verification and recovery links expire after one hour. Sign-out
revokes the current session; password reset revokes all the account's sessions.
Sessions last seven days and refresh with activity. Cookies are HTTP-only,
SameSite=Lax, Secure on HTTPS, and scoped to the dashboard host. Session caching
is disabled so revocation takes effect on the next request.

Each verified account starts with five inbox slots. Existing customer records
retain their limits and inboxes when their verified email matches. New users
cannot claim existing mailboxes. The API checks session validity, disabled status,
and mailbox ownership on every request. Administrator emails come only from
`DASHBOARD_ADMIN_EMAILS`. Administrators can manage customers and existing
mailboxes without a customer inbox limit.

## Configuration

| Worker | Variable | Purpose |
| --- | --- | --- |
| Email API | `AUTH_PUBLIC_URL` | Exact dashboard origin with no trailing slash |
| Email API | `AUTH_FROM` | Sender address on a configured, verified sending domain |
| Email API | `AUTH_SECRET` | Independent random secret of at least 32 characters |
| Both | `AUTH_PROXY_SECRET` | A second independent random secret shared only by these Workers |
| Email API | `DASHBOARD_ADMIN_EMAILS` | Comma-separated owner emails, which must be verified during signup |
| Dashboard | `DASHBOARD_AUTH_MODE=account` | Enable public account pages and customer requests |

The dashboard uses its service binding to reach the email Worker. It replaces
all incoming authorization and IP headers with the proxy secret and the actual
client IP. The API rejects account requests without that secret. Neither the
platform token nor the proxy secret enters a browser response. The dashboard
exposes only the account endpoints needed by its screens. Account JSON responses
do not include session tokens or password records.

State changes require the dashboard Origin and JSON content type. Callback URLs
must stay on the dashboard origin. Database rate limits cover sign-in, sign-up,
verification resend, and password reset. Scheduled cleanup removes expired
sessions, verification records, and stale rate-limit records.

The local Node dashboard also supports `DASHBOARD_AUTH_MODE=account`; set the
same origin and proxy secret on the API. HTTP origins are allowed only on
loopback. The existing password owner mode and optional
[Cloudflare Access mode](customer-auth.md) remain available explicitly.

## Rollout

Production database changes require separate authorization under `AGENTS.md`.
The account feature is not enabled in production merely by merging this code.

1. Review [account-auth.sql](../ops/email/account-auth.sql). It includes the
   customer ownership schema and five Better Auth tables. It also adds the
   customer-to-auth-user reference, makes customer webhook URLs optional, and
   installs the quota and access-control routines. Existing messages, mailboxes,
   keys, and customer limits are preserved. Run it as the schema owner only
   after production migration approval. Existing default grants must give the
   application role DML access and routine execution, as in the
   [database guide](planetscale.md).
2. Set both secrets on the API Worker and the proxy secret on the dashboard.
   Preserve all existing mail provider credentials. Set the owner email list.
3. Deploy the API after the schema is ready. The API's health endpoint and
   existing agent API remain available independently of dashboard accounts.
4. Deploy the dashboard with `DASHBOARD_AUTH_MODE=account`. Keep the password-mode
   secrets and previous Worker version available until the owner has verified
   their account and confirmed access to existing inboxes.
5. The owner creates an account using an email in `DASHBOARD_ADMIN_EMAILS`, opens
   the verification email, and confirms their existing inboxes and Customers
   controls. A normal account should see only its own inboxes.

Rollback switches the dashboard back to its previous password-mode version.
Leave the new tables in place; do not drop account data during rollback. Deploy
neither SMTP nor DNS changes for this feature.

The SQL is generated with
`pnpm --filter @bezalel/email exec tsx scripts/generate-account-schema.ts`, using
an empty in-memory database. Review generated changes when upgrading Better Auth.
The regular migration command includes the same statements for fresh databases.

## Local verification

```sh
FIXTURE_AUTH_MODE=account pnpm --filter @bezalel/email exec tsx test/dashboard-fixture.ts
```

Open `http://127.0.0.1:3038/sign-up`. The fixture binds to loopback, creates a
fresh PGlite database, and simulates domain verification, routing, storage, and
email sending. `http://127.0.0.1:3039/sends` contains captured verification and
recovery URLs. These are test messages, not live delivery.

`pnpm test` exercises real password hashing, verification, ownership, session
revocation, recovery, CSRF, and rate limits with isolated local databases. The
PostgreSQL suite also runs signup, verification, sessions, and sign-out inside
Cloudflare's local workerd runtime using real PostgreSQL sockets. Only its
provider API calls are simulated. Follow the database guide for the dedicated
local `TEST_DATABASE_URL`; tests refuse remote databases.
