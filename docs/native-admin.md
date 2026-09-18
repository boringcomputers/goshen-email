# Read Bezalel inboxes from the email dashboard

The account dashboard has a **Bezalel inboxes** page for the administrator named
in `NATIVE_MAIL_ADMIN_EMAILS`. Sign in with that verified email address using the
existing email code or magic link, then open Bezalel inboxes in the sidebar.
The native deployment keeps its current addresses, records, and Bezalel owners.
Standalone inboxes remain on the ordinary Inboxes page.

The page lists active production inboxes, searches names and addresses, reads
conversations, searches message content, filters folders, and downloads signed
attachments. Reading a message leaves its labels unchanged. The view cannot
send, reply, delete, release quarantine, change ownership, or retrieve keys.
Existing quarantine rules still apply to message bodies and attachments.

## Authorization

This integration requires account sign-in. On every native read, the dashboard
asks the standalone account service to verify the current session. That service
checks the verified email, account state, and administrator role. The dashboard
also requires the email to appear in its separate native administrator allowlist.
Client headers and request bodies cannot provide either identity or role.
Signing out or disabling the account blocks subsequent reads.

The dashboard makes a separate server-side request to the native Worker using
the `NATIVE_MAIL_API` service binding. Only seven read operations are allowed at
both the dashboard endpoint and client boundary. The native credential stays in
a Worker secret and is never sent to the browser. Existing account requests
continue through the standalone service binding and credential.

## Configuration and deployment

| Dashboard setting | Value |
| --- | --- |
| `DASHBOARD_AUTH_MODE` | `account` |
| `NATIVE_MAIL_WORKER_URL` | `https://bezalel-email.michaelwasihun96.workers.dev` |
| `NATIVE_MAIL_ADMIN_EMAILS` | `michaelwasihun96@gmail.com` |
| `NATIVE_MAIL_API` service binding | `bezalel-email` |
| `NATIVE_MAIL_API_TOKEN` secret | The existing native platform token |

The same email must already be an administrator in the standalone account
service's `DASHBOARD_ADMIN_EMAILS`. The production profile names only the
requested owner. Other administrators do not receive native access automatically.
Without the native secret or allowlist, the page stays disabled.

Provision `NATIVE_MAIL_API_TOKEN` from protected storage without printing it or
putting it in a command argument. Preserve the existing native token and all
existing dashboard secrets. Build, verify, and deploy only the dashboard.
No mail Worker, database, routing, or ownership migration is needed.

Record the previous dashboard version before activation. Verify anonymous
requests fail, the configured owner can read the expected inboxes, and customer
requests cannot. Compare the native records and inbox ownership before and after.
Rollback restores the prior dashboard version; it does not restore or change mail
storage. The native service continues processing mail during dashboard rollback.

## Verification

`test/native-mail.test.mjs` covers session checks, the email allowlist, credential
separation, CSRF, forbidden operations, and revocation. `test/worker.test.mjs`
checks the two service bindings in local Cloudflare workerd. The bindings use
fixture responses; they do not contact production.

For browser verification, start the existing loopback fixture with
`FIXTURE_AUTH_MODE=account FIXTURE_NATIVE_MAIL=true FIXTURE_PORT=3198`.
Run `apps/email-dashboard/test/browser/native-mail.mjs` with Playwright installed.
Set `PLAYWRIGHT_MODULE` and `CHROMIUM_PATH` when using existing local installations.
The fixture creates separate PGlite databases for accounts and native mail and
uses fake routing, delivery, and object storage. The browser test verifies owner
and customer access, conversation reads, attachment bytes, search, mobile layout,
sign-out, and unchanged native records. Restart the fixture between runs to keep
sign-in rate limits isolated.
