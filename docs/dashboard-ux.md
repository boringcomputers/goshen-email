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

Settings sits above the account controls. It edits notification preferences and the organization and profile
names, shows the verified sign-in email, and links to API keys. The saved
organization name appears in the sidebar and breadcrumb. See
[workspace settings](settings.md) for persistence and rollout details.

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

## Design references

Reviewed on September 17, 2026:

- [AgentMail's published API key dashboard screenshot](https://github.com/agentmail-to/agentmail-docs/blob/main/fern/assets/api-key-creation.png): resource sidebar, breadcrumb header, list table, creation action, and row actions.
- [AgentMail's inbox screenshot](https://github.com/agentmail-to/agentmail-docs/blob/main/fern/assets/label-example.png): inbox folder controls and thread list.
- [AgentMail quickstart](https://github.com/agentmail-to/agentmail-docs/blob/main/fern/pages/get-started/quickstart.mdx): account keys and inbox workflow.

The signed-in console could not be inspected because the shared browser lost
its automation connection. This implementation follows those public references;
it does not claim complete feature or visual parity with the current console.
Bezalel's branding and existing account model remain in use.

## Verification

Start the isolated fixture with `FIXTURE_AUTH_MODE=account FIXTURE_TRIAGE=true
FIXTURE_PORT=3190 pnpm --filter @bezalel/email exec tsx test/dashboard-fixture.ts`.
Set `DASHBOARD_TEST_URL=http://127.0.0.1:3190` and
`DASHBOARD_TEST_CONTROL_URL=http://127.0.0.1:3191`, then run
`node --test apps/email-dashboard/test/browser/console.mjs`.
Run `developer-keys.mjs`, `mailbox-selection.mjs`, and `triage.mjs` the same way,
restarting the fixture between files to isolate account login rate limits.
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
