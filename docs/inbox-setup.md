# First inbox setup

New account users see **Get started** when they open an empty workspace. They
choose an email username on the configured default domain and can add an inbox
name. The guide uses the same provisioning and ownership checks as **Create inbox**.

If delivery routing fails, the address remains reserved. Reloading the page
shows that reservation in **Inboxes**. Open it and choose **Get started**;
**Retry delivery setup** retries the same inbox.
The guide distinguishes configured routing from confirmed receipt of an email.
It never sends a test email automatically.

Once routing is configured, users can copy their address and send it an email
from another account. **Check for email** checks for a received message that is
neither quarantined nor in Trash. It returns only a timestamp, without exposing
message contents.

## Connect an agent

Open **API keys** for an account API key that works across all of the account's
inboxes through the API, CLI, and MCP. See the [developer guide](developers.md).

For optional single-inbox access, **Get a mailbox key** opens the mailbox key dialog. The key stays masked
and is copied only when the user chooses **Copy key**. The user saves it as
`GOSHENEMAIL_MAILBOX_KEY` in the agent's environment. **Copy command** copies a curl
request to `/inbox-rpc/getInbox` with that environment variable, never the key.

The API records the first successful `getInbox` request for the current key
version. Viewing the key, copying the command, and using the dashboard do not
record a connection. **Check connection** reads this status after the normal
session and mailbox ownership checks. Replacing a key requires connecting again
with the replacement; an old key cannot complete this step.

This confirms that the key reached the mailbox API. It does not identify an
agent, prove that its automation is running, or confirm email delivery.

Users may choose **Go to inbox** or **Set up later** at any time. Dismissal is a
browser preference scoped to the customer ID. Keys are never written to browser
storage. **Get started** reopens the guide for the selected customer inbox.
Delivery and connection status come from the server and survive browser changes.
Existing owner mailboxes without customer provisioning do not show this guide.

## Rollout

This feature requires the account rollout from `docs/accounts.md` and the two
additive columns in `ops/email/inbox-onboarding.sql`. Review and obtain production
migration approval before applying the SQL as the schema owner. Apply the SQL
before deploying the API, then deploy the dashboard. Existing application table
grants cover the columns. No new secrets, DNS records, or SMTP configuration are
required by this change.

The existing `getInbox` endpoint now records the successful connection. Deploying
its new implementation before the migration will fail that request. Roll back the
Worker versions if necessary and leave the additive columns in place.

## Verification

Use `FIXTURE_AUTH_MODE=account` with `apps/email/test/dashboard-fixture.ts`.
The fixture uses isolated PGlite storage and simulates domain verification,
routing, email sending, and object storage. Its loopback control server supports
`POST /routing` with `{ "available": false }` to exercise pending routing,
`POST /receive` to inject a received message, and the real mailbox handlers at
`POST /inbox-rpc/getInbox` to verify the copied command with a fixture key.
No provider delivery is implied by these checks.

To run the mailbox-switch regression, start the account fixture on ports
3168 and 3169 and run `node apps/email-dashboard/test/browser/mailbox-selection.mjs`
with Playwright available. If installed outside this worktree, set
`PLAYWRIGHT_MODULE` to its absolute module path and `CHROMIUM_PATH` to the browser
executable. This check uses fixture email codes and deliberately fails message
requests. It verifies that the guide and its actions follow the selected inbox
while requests are pending, after failures, and after inventory refreshes.
