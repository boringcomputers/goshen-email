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

A top-up unit is one inbox, one custom domain, 1,000 sends, or 1,000 triage
analyses per month. Monthly balances reset on the billing date. Inbox and
domain counts do not reset. The rolling 24-hour send limit per inbox stays in
place on every plan as an abuse backstop.

Self-hosting is free under the AGPL and needs no Autumn account. Support
contracts for self-hosted installs are sold separately and not through Autumn.

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
| `triage` | consumed when an incoming message is stored; for quarantined mail, when it is released | refunded if the analysis ends in failure | yes |
| `custom_domains` | not yet; domain operations are administrator-only today | | no |
| `storage_mb` | not yet | | no |
| `seats` | not yet; accounts have one member | | no |

Design points:

- Checks and deductions are one atomic step. Sends and inbox creation use
  Autumn balance locks: `check` with `send_event` and a `lock` holds the unit,
  and `balances.finalize` confirms or releases it. Two requests cannot both
  pass on the last unit. A hold the Worker never finalizes expires after ten
  minutes and releases itself.
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
- Triage consumes its unit at receipt so a burst of mail cannot overspend. An
  analysis that ends in `failed` refunds the unit with a negative usage event.
  Quarantined mail is not charged unless someone releases it; a release with
  no allowance left drops the pending analysis instead of running it unpaid.
- Administrators listed in `DASHBOARD_ADMIN_EMAILS` are exempt from every
  check and are never created in Autumn.
- Inboxes provisioned with the platform token rather than an account are not
  metered.

Denials return `billing_limit` (402). Agents can read balances with
`getUsage` (`GET /v1/usage`, `inboxes:read`). Upgrading is a human action in
the dashboard: `startCheckout` returns an Autumn or Stripe checkout URL and is
not part of the developer API.

## Rollout

Schema: none. This release adds no tables or columns.

1. Create the Autumn organization and connect Stripe. Push the plans from
   `ops/autumn` to the sandbox first, then to production
   (see [ops/autumn/README.md](../ops/autumn/README.md)). Set the default
   success URL in Autumn to the dashboard's billing page.
2. Deploy the Worker and dashboard from the same revision. Without the secret
   the Worker behaves as before.
3. Set `AUTUMN_SECRET_KEY` as a Worker secret. From the next request, new
   customers are created in Autumn on the Free plan when they first create an
   inbox or send, and every account's limits apply.
4. Existing accounts start on Free with their current inbox count uncounted in
   Autumn until they create or delete an inbox. To count existing inboxes,
   record one `inboxes` event per account from an operator script before
   turning the key on, or grant those accounts a matching balance in Autumn.

The dashboard's plan page, the landing page's plan cards, and the operator
backfill script are follow-up work.

## Local verification

`apps/email/test/billing.test.ts` runs the Worker against an in-memory Autumn
double (`apps/email/test/autumn-fixture.ts`) with small allowances. It covers
the inbox cap and retry path, send denial before reservation and success after
a top-up, one winner among simultaneous sends on the last unit, a retried
storage failure being checked again, no charge for rejected sends, mailbox-key
sends, provider outage, administrator exemption, triage consumption and refund,
quarantine release, `getUsage` through REST, SDK, CLI, and MCP, and checkout
from the dashboard. No test contacts Autumn or Stripe.
