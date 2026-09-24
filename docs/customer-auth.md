# Optional Cloudflare Access sign-in

Public sign-up uses [passwordless accounts](accounts.md). This guide describes
the optional `DASHBOARD_AUTH_MODE=access` integration for invited customers.

Customers sign in with an email code through Cloudflare Access. The email API
verifies the signed assertion, checks the invitation, and looks up mailbox
ownership before reading mail, sending, deleting, or returning a mailbox key.
The dashboard never sends its platform credential for customer requests.

## Configure Access

1. Open [Cloudflare Zero Trust](https://one.dash.cloudflare.com/c340deebb91d89c14d17239b7658dc81/).
   Create a team if the account has none. Record its `*.cloudflareaccess.com` domain.
2. Under Integrations > Identity providers, add **One-time PIN**.
3. Add a **Self-hosted** Access application named **Bezalel Email** for
   `goshenemail.com`. In that same application,
   add public hostname entries for paths `/app` and `/api` (each also covers its
   subpaths). Keep both entries under the same application audience. Leave the
   root homepage and static assets outside Access; do not retain a hostname-wide
   entry if the homepage should be public.
   Set an eight-hour session and enable only the One-time PIN identity provider.
4. Add an **Allow** policy with **Include: Everyone** and **Require: Login
   Methods > One-time PIN**. Do not use a Bypass policy. Cloudflare verifies the
   email; the application separately rejects everyone without an invitation.
5. Copy the application's Audience tag, also called AUD.

An API setup token needs these account permissions, scoped to Goshen Labs:

- Access: Organizations, Identity Providers, and Groups: Edit
- Access: Apps and Policies: Edit

The normal Wrangler OAuth login may deploy Workers but lack those Access
permissions. The email-sending runtime token does not need Access administration
permissions. Keep setup credentials separate and out of Git and chat.

See Cloudflare's [application path rules](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/),
[OTP instructions](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
and [JWT verification instructions](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).

## Configure and deploy

Set these non-secret variables on the API Worker and in its deployment configuration:

| Variable | Value |
| --- | --- |
| `ACCESS_TEAM_DOMAIN` | The exact team domain, without `https://` |
| `ACCESS_AUD` | The application's 64-character audience tag |
| `DASHBOARD_ADMIN_EMAILS` | Comma-separated owner email addresses |

Owner addresses come from deployment configuration, never a request body. Owners
automatically receive an account when they first sign in. Existing mailboxes stay
visible to owners; customers start with no mailboxes and cannot claim old ones.

1. Apply the database migrations using the schema-owner role as described in the
   [database guide](planetscale.md). Confirm that the application role has DML
   access to the new customer tables and can execute the new functions.
2. Deploy the API with all three Access variables.
3. Confirm Access protects `/app` and `/api` on the dashboard hostname and uses
   the intended identity provider. Deploy the dashboard with
   `DASHBOARD_AUTH_MODE=access`, then verify `/` loads without a sign-in prompt.
4. Sign in as an owner. Confirm the expected inboxes appear.
5. Remove `DASHBOARD_PASSWORD` and `MAIL_API_TOKEN` from the dashboard Worker after
   successful verification. Customer mode ignores both. The old Durable Object
   binding stays for deployment compatibility and receives no customer requests.

Do not switch a live dashboard to customer mode before Access is configured.
Unconfigured or invalid identity requests fail closed. Never protect the entire
email API with Access, since agent keys and mail delivery use different credentials.

## Account access

The dashboard has no customer administration page. Access mode requires an
existing invitation, managed through the Worker's administrative operations.
For public signup without invitations, use [passwordless accounts](accounts.md).
Cloudflare sends a sign-in code when an invited customer starts signing in.

After the [developer API migration](developers.md#rollout-and-verification),
customers have no inbox-count cap unless an operator assigns one. Customers
create inboxes on `agents.goshenemail.com`. Inbox creation assigns ownership and enforces any limit
in one database transaction before creating an external delivery route. Owners do
not have a customer inbox limit. If route setup fails, the address stays reserved
and counts toward the customer limit. It appears as **setup pending**; use
**Finish inbox setup** or retry creating the same address to complete delivery.
Deleted addresses cannot be reused. Customers can
read, compose, reply, search, label, delete, review quarantine, and copy or replace
their own mailbox API keys. The API keys page creates account keys for
managing multiple inboxes and groups through the API, CLI, and MCP.
Each mailbox initially has a 250-send daily limit.
Custom-domain administration remains an owner operation in the dashboard.

Disabling an account through the Worker blocks future dashboard requests and
invalidates the customer's mailbox keys. Re-enabling access requires customers
to copy the new keys. An in-flight request may finish, and previously issued
attachment links remain valid
until their short expiry. Disabling access retains inboxes and stored mail.

Mailbox keys use `POST /inbox-rpc/<operation>` on the email API. Customer inboxes
have no webhook destination by default; their events never go to the shared
platform webhook. Existing provisioned application webhooks keep working.

## Local verification

`pnpm test` uses isolated databases and test signing keys. For a browser fixture:

```sh
pnpm --filter @bezalel/email exec tsx test/customer-dashboard-fixture.ts
```

Loopback ports 3042, 3043, and 3044 represent the owner, Alex, and Sam. Each uses a
different signed test identity against the real authorization and storage code.
The fixture replaces Cloudflare login, email delivery, routing, and object storage.
It never contacts providers. Do not deploy this fixture or treat it as a live
Cloudflare sign-in test.
