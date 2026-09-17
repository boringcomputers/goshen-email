# Workspace settings

Open **Settings** at `/app#/settings` to change the organization name or your
profile name. Each section saves separately. The organization name appears in
the sidebar and breadcrumb; the profile name appears in the account menu.
Names persist across browsers and sign-ins. Sign-in email is read-only.

The current account owns one workspace. Settings do not add shared membership,
invitations, billing, or notification preferences. Account access links to the
existing API keys page and describes the configured passwordless sign-in method.
Settings are available in account and Cloudflare Access modes.

The Worker reads settings from the authenticated account. `getSettings` returns
its customer record; `updateSettings` accepts an organization name, a profile
name, or both. Unknown fields, blank names, control characters, organization
names longer than 100 characters, and profile names longer than 200 characters
are rejected. Callers cannot supply another account's ID or change their email,
role, or quota. Account API keys do not expose these dashboard operations.

Profile saves update the customer record and its linked authentication profile
in one database statement. A failure rolls back both updates. Disabled accounts
cannot read or change settings. Dashboard requests retain the existing session
and origin checks.

## Rollout

1. Apply [workspace-settings.sql](../ops/email/workspace-settings.sql) with the
   schema-owner role after production migration approval. It adds one column
   to `mail.customers`, defaults existing accounts to **Your workspace**, and
   preserves saved names when rerun. Existing application table grants apply
   to the new column.
2. Deploy the email Worker, then the dashboard. The API must support settings
   before the dashboard offers them.
3. Verify an account can rename its workspace, reload Settings, and see the
   saved name in the sidebar and page header.

Rolling back the application can leave this additive column in place. Do not
drop account data during rollback. No SMTP or DNS changes are needed.

## Verification

Backend tests cover account isolation, rejected fields, disabled accounts,
profile update rollback, persistence after sign-in, Access profiles, and
migration reruns. The browser regression covers failed saves, duplicate
submissions, navigation during a save, load retries, sign-out and sign-in,
account isolation, and desktop/mobile layouts.

Start `apps/email/test/dashboard-fixture.ts` with `FIXTURE_AUTH_MODE=account`
and `FIXTURE_PORT=3194`, then run
`node --test apps/email-dashboard/test/browser/settings.mjs`.
Set `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` for externally installed Playwright
and Chromium. `DASHBOARD_EVIDENCE_DIR` optionally saves screenshots.
Use `homelab-job` for the browser checks on the homelab.

The fixture uses local PGlite storage. Email sending, routing, domain
verification, object storage, and Jev use test doubles. It sends no live email.
