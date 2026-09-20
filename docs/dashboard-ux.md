# Dashboard UX

The dashboard opens on an inbox inventory. Each row links to its inbox reader
and has an options menu for copying the address or deleting that inbox. Search
matches names, addresses, and groups. Group filters and ten-row pages use the
complete paginated account inventory.

The resource sidebar contains Inboxes, Domains when enabled, API keys,
and Integrations. Inbox folders and mailbox keys live inside the inbox view.
The reader's Filter messages button expands the
existing Jev category, response, and urgency controls.

Configured administrators also see [Bezalel inboxes](native-admin.md), a read-only
view of the dedicated native deployment. It keeps native mail separate from the
standalone account inventory and checks administrator access on every read.

Settings sits above the account button. It edits notification preferences and the organization and profile
names, shows the verified sign-in email, and links to API keys. The saved
organization name appears in the breadcrumb. See
[workspace settings](settings.md) for persistence and rollout details.
The account button at the bottom of the sidebar opens a menu above it with the
full sign-in name and email, a Settings link, and Sign out. Clicking outside,
pressing Escape, or navigating closes the menu.

API keys and domains have dedicated list pages with separate creation dialogs.
Integrations provides the configured API and MCP URLs plus SDK and CLI setup
documentation. Account keys still appear once, remain masked, and clear when
their creation dialog closes. The Worker retains all permissions and ownership
checks.

Inbox deletion names the selected row's address, explains permanent deletion
and address retirement, and initially focuses Cancel. Escape and Cancel send no
request. Pending deletion disables both buttons; failure stays in the dialog
for retry. Success removes the inbox locally before refreshing the inventory,
so a refresh failure cannot leave a deleted row actionable.

Hash routes support browser Back and reloads, including individual inboxes.
Missing inbox routes and the retired Customers route return to the inventory.
Mobile navigation uses the existing focus trap; the mail reader keeps its
back-to-conversations behavior.

## Refresh

A reload paints the workspace as it last looked before any request finishes.
`dashboard-boot.js` runs in the head and selects the routed view.
`dashboard-shell.js` runs at the end of the body: it draws the static icons,
reads the saved workspace from `localStorage` under
`bezalel.dashboard.snapshot`, and paints the sidebar, breadcrumb, account
button, inbox table, mailbox switcher, thread list, settings values, API key
table, domain cards, and native inventory from it. `app.js` and the page
modules render fresh data through the same painters, so the network changes
nothing on screen unless the data changed. Reloading a list already on screen
keeps it until the new list arrives; switching folders or inboxes still shows
the loading placeholder.

The saved workspace holds display data only: the session's names, flags, and
URLs, the inbox inventory, the default inbox view of the five most recently
opened inboxes, API key names and prefixes, domain records, and the native
inventory. It never holds tokens, keys, or message bodies. Sign-out, an ended
session, and a session for a different customer clear it. Anyone who can read
the browser profile can read it, as with browser history; the dashboard keeps
its `no-store` headers, so this is the only state the browser retains.

A browser that has never shown the workspace has nothing to paint. It hides
the navigation, account button, and list footer until the session answers, and
the breadcrumb can change width once the organization name arrives.

## Design

The dashboard shell matches the Fancy Dashboard artboard. Shared tokens live in
`tokens.css`. The canvas is sand 50 (`#F3F2EF`). The sidebar is 240px with
20px vertical and 12px horizontal padding. Navigation is 13px, with 16px icons
and a white active row. The header is 64px tall, with 32px side padding and a
20px semibold title. Content padding is 8px on top and 32px on the sides and
bottom. Panels, tables, and the mail reader use a 12px radius, a hairline
border, and a white surface. Primary actions stay ink pills at 32px. Inputs
are 40px with an 8px radius. Mobile navigation keeps 44px tap targets.

`console.css` sets that layout for inboxes, API keys, integrations, domains,
settings, and the native inbox inventory. `native-mail.css` uses the same
tokens for its reader. Mobile navigation and the single-column mail reader
keep their existing breakpoints and keyboard behavior.

## Verification

Start the isolated fixture with `FIXTURE_AUTH_MODE=account FIXTURE_TRIAGE=true
FIXTURE_PORT=3190 pnpm --filter @bezalel/email exec tsx test/dashboard-fixture.ts`.
Set `DASHBOARD_TEST_URL=http://127.0.0.1:3190` and
`DASHBOARD_TEST_CONTROL_URL=http://127.0.0.1:3191`, then run
`node --test apps/email-dashboard/test/browser/console.mjs`.
Run `developer-keys.mjs`, `mailbox-selection.mjs`, `triage.mjs`, `refresh.mjs`,
and `saved-workspace.mjs` the same way, restarting the fixture between files to
isolate account login rate limits. `refresh.mjs` gates the session and
inventory responses and checks that a reload paints the saved workspace with
no layout shift and that fresh data changes nothing already on screen.
`saved-workspace.mjs` checks that sign-out, an ended session, and another
account clear it.
Set `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` if Chromium and Playwright are
installed outside the worktree. Run this workload through `homelab-job` on the
homelab.

The console regression checks navigation, grouped search, pagination, reloads,
API key creation and secret clearing, mobile navigation, and deletion including
failure, cancellation, duplicate submission, and deleting the last inbox.
Existing browser tests also cover setup, SDK/CLI use, revocation, and triage.
The fixture uses PGlite and test doubles for routing, domain verification,
sending, object storage, and Jev. It does not send live mail.

The navigation redesign needed only a dashboard deployment. Workspace settings
adds a database column and Worker operations; follow its rollout guide before
deploying the Settings page.
