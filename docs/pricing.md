# Pricing and billing

Goshen Email sells hosted inboxes for AI agents on three plans, with $2 top-ups
for extra capacity. [Autumn](https://useautumn.com) holds the plans and
balances and bills through Stripe. The Worker asks Autumn before each metered
action and records the action afterwards. Self-hosted deployments run without
any of this.

## Plans

| | Free | Developer $20/mo | Team $99/mo |
| --- | --- | --- | --- |
| Inboxes | 5 | 10 | 100 |
| Sends per month | 1,000 | 10,000 | 100,000 |
| Triage analyses per month | 500 | 10,000 | 100,000 |
| Custom domains | none | 5 | 50 |
| Storage | 1 GB | 10 GB | 100 GB |
| Seats | 1 | 2 | 10 |
| Top-ups | none | $2/unit | $2/unit |
| Support | GitHub issues | email | priority email |

A top-up unit is one inbox, one custom domain, 1,000 sends, or 1,000 triage
analyses per month. Monthly balances reset on the billing date. Inbox and
domain counts do not reset. The rolling 24-hour send limit per inbox stays in
place on every plan as an abuse backstop.

Self-hosting is free under the Functional Source License and needs no Autumn
account. Support contracts for self-hosted installs are sold separately and not
through Autumn.

## Why these numbers

The comparison point is AgentMail, whose public plans on 2026-09-20 were Free
(3 inboxes, 3,000 sends/month), Developer $20 (10 inboxes, 10,000 sends), and
Startup $200 (150 inboxes, 150,000 sends), with $2 top-ups for +1 inbox, +1
domain, or +1,000 sends. Two smaller competitors, Mails.ai and MailMolt, price
their middle tier at $99.

- Free gives 5 inboxes where AgentMail gives 3, because inbox rows cost
  almost nothing. Sends cost money, so the free send allowance is lower.
- Developer matches AgentMail on price and on inboxes and sends, so nobody
  rejects Goshen on a spreadsheet, and adds a triage allowance they do not have.
- Team at $99 undercuts AgentMail's $200 tier and matches the price the rest
  of the market has set for that level.
- Triage is metered on its own because each analysis is a paid call to
  TypeSafe. The free allowance is enough to see it work.
- The $2 top-up copies AgentMail's model on purpose: it is easy to explain and
  already familiar to the buyers we want.

The dashboard for human review, quarantine, triage, and the self-host path are
the differentiators. Price is set to be unremarkable so those can carry the
decision.

## What the Worker meters

| Feature id | Held or consumed at | Settled at | Enforced in this release |
| --- | --- | --- | --- |
| `inboxes` | `createInbox` holds one unit before provisioning a new address | confirmed after provisioning, released if it fails; `deleteInbox` credits one back | yes |
| `sends` | `send` and `reply` hold one unit before the idempotency reservation | confirmed after the message is committed, released on every other exit | yes |
| `triage` | held when an incoming message arrives; for quarantined mail, when someone releases it | confirmed once the message is stored or the release happens, released otherwise; refunded if the analysis ends in failure | yes |
| `custom_domains` | not yet; domain operations are administrator-only today | | no |
| `storage_mb` | not yet | | no |
| `seats` | not yet; accounts have one member | | no |

Design points:

- Checks and deductions are one atomic step. Sends and triage use Autumn
  balance locks: `check` with `send_event` and a `lock` holds the unit, and
  `balances.finalize` confirms or releases it. A hold the Worker never
  finalizes expires after ten minutes and releases itself. Autumn does not
  allow locks on allocated features, so inbox creation consumes its unit in
  the same `check` and refunds it with an idempotent negative usage event if
  provisioning fails; the refund is retried three times. Either way two
  requests cannot both pass on the last unit.
- The database is the source of truth for how many inboxes an account has.
  `createInbox` and `getUsage` compare Autumn's inbox usage with that count
  and correct it with an idempotent event when they differ, then decide on
  the true count. That repairs a refund that never reached Autumn and counts
  inboxes created before billing was switched on, so no backfill script is
  needed. Creation (existence check, hold, provisioning), deletion with its
  credit, and the usage correction all run under the account's row lock
  (`withAccountLock`), so a second request for the same account waits for the
  first to commit and cannot refund a unit that is still being provisioned or
  count an inbox twice.
- The send hold happens before a reservation exists. A denied send leaves no
  row, so the same `idempotencyKey` succeeds after the customer upgrades. A key
  whose reservation will be answered as-is (sent, pending, or failed for good)
  skips the hold, so retries of a completed send return its result even when
  the allowance is spent. Failures that `reserve_send` lets the caller retry
  (`rate_limited`, `attachment_storage_error`) are checked again on retry.
- A send is charged only when its message is committed. Rejected sends,
  attachment storage failures, and uncertain outcomes release the hold.
- Checks fail closed. If Autumn does not answer, metered operations return
  `billing_unavailable` (503, `transient: true`) and nothing is written.
  Settlement failures after the action is decided are swallowed: the
  customer's action already happened, and a hold that fails to confirm
  expires in our favour, not theirs.
- Triage holds its unit at receipt so a burst of mail cannot overspend, and
  confirms it only for the delivery that stored the message; a duplicate
  delivery of the same Message-ID releases its hold. An analysis that ends in
  `failed` refunds the unit with a negative usage event. Quarantined mail is
  not charged unless someone releases it, and only the release that changes
  the message's state is charged. If that release had no allowance left it
  drops the pending analysis in the same transaction as the release, so the
  worker never sees unpaid work; a caller that lost the release never touches
  the analysis another caller's hold is paying for.
- Administrators listed in `DASHBOARD_ADMIN_EMAILS` are exempt from every
  check and are never created in Autumn.
- Inboxes provisioned with the platform token rather than an account are not
  metered.

Denials return `billing_limit` (402). Agents can read balances with
`getUsage` (`GET /v1/usage`, `inboxes:read`); the response also carries the
plan catalog from `apps/email/src/pricing.ts`. Upgrading is a human action in
the dashboard: `startCheckout` returns an Autumn or Stripe checkout URL and
`openBillingPortal` returns the hosted billing portal URL. Neither is part of
the developer API.

## Dashboard and landing page

The dashboard's Plan and usage page (`#/billing`) shows the current plan with
its renewal date, meters for inboxes, sends, and triage analyses, and a card
per plan with an upgrade button. Upgrading calls `startCheckout` and sends the
browser to the returned URL; Manage billing does the same with
`openBillingPortal`. A spent allowance is marked on its meter. Administrators
see that they are not billed and get no upgrade buttons. Deployments without
`AUTUMN_SECRET_KEY` show the inbox count and any operator quota and no plans.

The landing page's pricing section lists the same three plans from the same
numbers. Both surfaces read their copy from the catalog rather than repeating
it, except the landing page, which is static HTML and is checked by eye
against `pricing.ts` when either changes.

## Rollout

Schema: none. This release adds no tables or columns.

1. Create the Autumn organization and connect Stripe at
   `app.useautumn.com/dev?tab=stripe`. Without Stripe, metering and the Free
   plan work but `startCheckout` and `openBillingPortal` fail. Push the plans
   from `ops/autumn` (see [ops/autumn/README.md](../ops/autumn/README.md)).
   Set the default success URL in Autumn to the dashboard's billing page.
   Done for the `goshen_email` production org on 2026-09-23, except Stripe.
2. Deploy the Worker and dashboard from the same revision. Without the secret
   the Worker behaves as before.
3. Set `AUTUMN_SECRET_KEY` as a Worker secret. From the next request, new
   customers are created in Autumn on the Free plan when they first create an
   inbox or send, and every account's limits apply.
4. Existing accounts start on Free. Their inbox usage in Autumn is corrected
   to the database count the first time they create an inbox or read usage,
   so an account already over the Free allowance keeps its inboxes and is
   denied the next one.


## Local verification

`apps/email/test/billing.test.ts` runs the Worker against an in-memory Autumn
double (`apps/email/test/autumn-fixture.ts`) with small allowances. It covers
the inbox cap and retry path, send denial before reservation and success after
a top-up, one winner among simultaneous sends on the last unit, a retried
storage failure being checked again, no charge for rejected sends, mailbox-key
sends, provider outage, administrator exemption, triage holds and refunds
including a failed commit, simultaneous and missing quarantine releases,
`getUsage` through REST, CLI, and MCP, and checkout and the billing
portal from the dashboard. A test also checks that the catalog in
`pricing.ts` matches the plans, prices, and included amounts in
`ops/autumn/autumn.config.ts`. No test contacts Autumn or Stripe.

For the dashboard page, start `apps/email/test/dashboard-fixture.ts` with
`FIXTURE_AUTH_MODE=account FIXTURE_BILLING=true FIXTURE_TRIAGE=true
FIXTURE_PORT=3196` and run
`node --test apps/email-dashboard/test/browser/billing.mjs`. The fixture meters
accounts against the Autumn double on the Free plan; its control server
accepts `POST /billing` to change a customer's granted amount or take billing
down. The check signs in, creates usage, reads the meters, spends the send
allowance and confirms the 402, follows the upgrade button to the fixture's
checkout URL, opens the portal, recovers from an outage, checks four viewport
widths for overflow, and signs in as an administrator. Set `PLAYWRIGHT_MODULE`
and `CHROMIUM_PATH` for external installs; `DASHBOARD_EVIDENCE_DIR` saves
screenshots.
