# Web app

`apps/email-web` is a new dashboard front end for Goshen Email. It uses the
design system from Pluto's web app ([heyfabrika/pluto](https://github.com/heyfabrika/pluto)
`apps/web`, commit `7e1eb40c`). It is a SvelteKit single-page app with
Tailwind 4 and bits-ui. It runs next to the classic dashboard in
`apps/email-dashboard` and does not replace it yet.

## What comes from Pluto

- `src/app.css` has Pluto's tokens, the `ds` scope, and the two themes Pluto
  offers: Obsidian (dark, the default) and Porcelain (light). The other Pluto
  themes and its light-mode utility remaps are left out.
- `src/lib/components/ds` holds the Pluto components this app uses: button,
  badge, dialog, dropdown menu, input, textarea, checkbox, select, spinner,
  skeleton, progress, and ten patterns. They are copied unchanged. Only the
  patterns index is trimmed to match.
- `PageShell`, `FallbackAvatar`, the layout state helper, and the theme helper
  (cut to two themes) are Pluto's.
- The workspace layout copies Pluto's dashboard shell: a 260px sidebar that
  collapses to an icon rail, the same icons and nav rows, and the account menu
  with the theme picker. The mail view follows Pluto's email page, with
  folders, conversations, and the reader side by side.

## How it reaches the email service

The app holds no credentials. Every request goes to the dashboard server's
existing routes: `/api/session`, `/api/login`, `/api/logout`, `/api/auth/*`,
`/api/rpc/<operation>`, and `/api/native-rpc/<operation>`. The dashboard server
keeps its operation allowlists, origin check, rate limits, and cookies.
`src/lib/services/dashboard-api.ts` is the only module that calls `fetch`.

In development, Vite proxies `/api/` to the dashboard server at `DASHBOARD_URL`.
The dashboard rejects a request whose Origin is not its own, so the proxy
swaps in the dashboard's Origin, but only for requests from the dev server's
own page. A request from any other origin keeps its Origin, and the dashboard
answers 403. The proxy refuses to start unless `DASHBOARD_URL` is a loopback
address.

## Pages

Sign in, Inboxes, the mail view, Get started, Domains, API keys, Integrations,
Plan and usage, Settings, and Bezalel inboxes (administrators only, read only).
Sign-in supports email codes and magic links in account mode, the dashboard
password in password mode, and Cloudflare Access.

These rules carry over from the classic dashboard:

- A draft keeps one idempotency key. After a send attempt the payload is
  frozen, and "Retry same request" sends it again unchanged, so the Worker can
  recognize a send it already accepted.
- A 401 or 403 from an operation ends the session and returns to sign-in,
  keeping the page to come back to. The Bezalel reader treats 403 as "not an
  administrator" instead.
- Desktop notifications poll every 30 seconds while enabled, and open tabs
  share one lock so only one of them alerts.
- Dismissing the setup guide uses the classic dashboard's storage key.

What is different:

- Replies are written under the conversation instead of in a dialog.
- A closed draft that was never sent moves to the inbox you reopen compose
  from and keeps what you typed. A draft whose send was attempted stays with
  its inbox and says so, until you retry or discard it. The classic dashboard
  keeps every draft on its first inbox.
- The Quarantine folder offers Release and "Move to trash". The classic
  dashboard also offers "Move to inbox" there.
- The app does not paint a saved workspace before the session answers. It
  shows a spinner until then.
- The API Worker builds magic links from `AUTH_PUBLIC_URL`, so a link opens the
  classic `/magic-link` page and continues to `/app`. This app has its own
  `/magic-link` route for when it is served from that origin. Email codes work
  in both apps.

## Run it locally

Start the dashboard fixture, then the app against it:

```sh
FIXTURE_AUTH_MODE=account FIXTURE_TRIAGE=true FIXTURE_BILLING=true FIXTURE_PORT=3194 \
  pnpm --filter @bezalel/email exec tsx test/dashboard-fixture.ts
DASHBOARD_URL=http://127.0.0.1:3194 pnpm --filter @bezalel/email-web dev
```

The app answers on `http://127.0.0.1:5290`; set `EMAIL_WEB_PORT` to change it.
Sign in with any address. The fixture captures the code at
`http://127.0.0.1:3195/sends`. To run against a local dashboard server instead,
point `DASHBOARD_URL` at it.

## Verification

`pnpm --filter @bezalel/email-web check` runs svelte-check with warnings as
errors. `pnpm --filter @bezalel/email-web test` runs the service tests with
Node's built-in TypeScript support. The browser check needs the fixture and a
preview build:

```sh
pnpm --filter @bezalel/email-web build
DASHBOARD_URL=http://127.0.0.1:3194 pnpm --filter @bezalel/email-web preview
EMAIL_WEB_TEST_URL=http://127.0.0.1:5290 node --test apps/email-web/test/browser/web-app.mjs
```

It signs in with an emailed code, seeds two inboxes, reads, replies, and
composes with an attachment. It checks that a closed draft moves to the inbox
compose is reopened from, and that a draft with a failed send stays with its
inbox. Then it releases a quarantined message, searches, saves settings,
switches themes, signs out, signs back in with a magic link that returns to
the page it started from, and checks a second account on the Free plan. The
fixture allows three emailed codes and three magic links per client address
every 10 minutes. The check uses two codes and one link, so restart the fixture
between runs. Set `PLAYWRIGHT_MODULE` and
`CHROMIUM_PATH` for an external Playwright, and `DASHBOARD_EVIDENCE_DIR` to
save screenshots.

The fixture uses test doubles for routing, sending, domain verification,
object storage, triage, and billing. No mail leaves the machine.

## Rollout

This change deploys nothing. It does not touch the dashboard Worker, the API
Worker, the schema, SMTP, or DNS, and the deploy job on `main` does not build
or publish this app.

Serving it in production needs a follow-up change:

1. Serve the build from the dashboard Worker's origin so the session cookie
   and `/api` routes stay same-origin, for example under `/next/` with
   SvelteKit's `paths.base` set to match.
2. Add the build output to the dashboard's fixed asset map. SvelteKit writes
   its start script inline, which the dashboard's `script-src 'self'` policy
   blocks, so the Worker must send the script's hash or a build step must move
   it to a file.
3. Point magic links at this app's `/magic-link` route once it becomes the
   default.
4. Deploy with the dashboard Worker once the owner authorizes it, and keep
   `/app` available until the new app has run in production.
