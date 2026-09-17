# Workspace settings

Open **Settings** at `/app#/settings` to change your organization name, profile
name, and notification preferences. Each section saves separately. The
organization name appears in the sidebar and breadcrumb; the profile name
appears in the account menu. Names and preferences persist across sign-ins.
The verified sign-in email is read-only. One account owns one workspace.

Settings are available in account and Cloudflare Access modes. The Worker
uses the authenticated customer ID. `updateSettings` accepts optional
`organizationName`, `displayName`, `desktopNotifications`, and
`emailNotifications` fields. Names are trimmed and limited to 100 and 200
characters respectively; notification values must be booleans. Empty requests,
unknown fields, blank names, and control characters are rejected. Callers
cannot change their email, role, quota, or another account. These operations
are excluded from the public account-key API and MCP.

Profile saves update both the customer and linked authentication profile in
one database statement. Disabled accounts cannot read or change settings. Session and settings responses
also include a server-generated `notificationCursor`; notification requests use
this timestamp to exclude old mail without discarding arrivals during the first
request. The cursor is a read boundary, not an authentication credential.
Dashboard requests retain the existing session and origin checks.

## Notifications

Both channels default off and apply to future mail in the account's own
inboxes, including for administrators. They exclude test inboxes, quarantined,
spam, and trashed messages. Enabling them does not replay historical mail.
New arrivals create notification records in the message commit statement;
duplicate inbound messages cannot create duplicate records. Ownership,
account access, inbox deletion, and protection are checked again on delivery.
Opt-out cancels queued notifications for that channel. The sender holds the
account row lock during its final eligibility check and transport call. An
opt-out either cancels work before sending or waits for a send already in
progress; no new send begins after the opt-out response succeeds.

Desktop alerts require a supported browser, permission, and an open dashboard.
The **Allow in this browser** button requests permission only on a click,
following the [Notifications API permission requirements](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API).
The dashboard polls every 30 seconds without refreshing the reader. It starts
tracking arrivals when the preference is enabled, even while browser permission
is pending, so granting permission does not discard the first new arrival. It groups
new arrivals into one alert and omits subjects, senders, and bodies. Alerts
open the relevant inbox. Web Locks and local storage deduplicate across tabs;
browsers without Web Locks only show alerts in the focused tab. Polling stops
on sign-out. Preference changes in another browser take effect on reload;
the server always rechecks opt-out when answering a notification request.
This does not implement push notifications when the dashboard is closed.

Email notifications go only to the verified sign-in address. The existing
minute cron groups up to 100 arrivals per summary, processing at most ten
summaries per invocation. It uses `AUTH_FROM`, `AUTH_PUBLIC_URL`, and the
existing transport. Email summaries contain a count and dashboard/settings
links, never message contents. Automated messages with `Auto-Submitted` or
`X-Bezalel-Notification` headers do not trigger email alerts, preventing loops.
The notification queue does not alter mailbox send idempotency or webhooks.

The existing transport accepts no notification idempotency key. Each summary is durably reserved
before sending and attempted once. A failed lookup before transport begins
returns the reservation to pending, and an ineligible recipient finalizes it
as failed. Transport errors and interrupted sends are not retried automatically
because delivery may already have happened. The reservation is committed
before the send transaction so a rollback after sending cannot cause a resend. Inspect
`mail.notifications.email_state` for pending, attempted, accepted, or failed
records. An accepted receipt means queued or delivered by the transport,
not confirmed arrival in the recipient's mailbox. Pending notifications
expire after a day; all notification records are removed after seven days.
Email notifications require the account sender configuration even when the
user signs in through Cloudflare Access.

## Rollout

1. Apply [workspace-settings.sql](../ops/email/workspace-settings.sql) as the
   schema owner before deploying. It adds the organization name, two opt-in
   columns, the notification queue, and indexes. It preserves saved values
   when rerun. Ensure the application's existing default table grants cover
   the new table, as for the account-auth migration.
2. Deploy the email Worker, then the dashboard. No SMTP or DNS changes are
   needed. Confirm `AUTH_FROM`, `AUTH_PUBLIC_URL`, and the minute cron exist.
3. Verify saved names and preferences survive a reload. Opt in on a test
   account and confirm a new arrival produces a browser alert and an email
   summary; then opt out and confirm further arrivals do not notify.

An application rollback can leave the additive schema in place. Do not drop
account data during rollback.

## Verification

Backend tests cover persistence, account isolation, validation, migration
reruns, profile rollback, duplicate arrivals, opt-out, quarantine, deleted
inboxes, disabled accounts, automatic-mail suppression, concurrent workers,
and uncertain sends. Browser checks cover saves and failures, navigation,
permission prompts, alert deduplication, grouped email transport, isolation,
sign-out/in, and responsive layouts. Focused notification tests also cover granting
permission after opt-in, cross-tab deduplication, delayed responses after
sign-out, opt-out cleanup, recovery after a failed poll, and mail arriving
while the first poll is still in progress.

Start `apps/email/test/dashboard-fixture.ts` with `FIXTURE_AUTH_MODE=account`
and `FIXTURE_PORT=3194`, then run
`node --test apps/email-dashboard/test/browser/settings.mjs`.
Set `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` for externally installed Playwright
and Chromium. `DASHBOARD_EVIDENCE_DIR` optionally saves screenshots.
Use `homelab-job` for browser checks on the homelab.

The fixture uses local PGlite. Email sending, routing, domain verification,
object storage, Jev, and the browser Notification API use test doubles. The
loopback-only `/notifications` fixture endpoint runs the real email queue
processor against the transport double. No live email or native OS alert is
claimed by these checks.
