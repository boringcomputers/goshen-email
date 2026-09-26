# Design system

The landing page, the sign-in pages, and the dashboard follow the
[Goshen Email file in Paper](https://app.paper.design/file/01M3DDTT9P41NQV6HWG33Y0XWA).
Its tokens come from the Computer design system. See
[dashboard UX](dashboard-ux.md) for navigation and list behavior.

The app keeps plain HTML, CSS, and JavaScript. Values were read from the Paper
export (`get_jsx` and computed styles), not measured from screenshots.

## Paper pages

| Paper page | Code |
| --- | --- |
| Landing Page, artboard "Goshen Email — Landing" | `index.html`, `landing.css`, `site-header.css` |
| Dashboard, "00 — Sign in" | `auth.html`, `auth.css` (sign-in, sign-up, and magic-link states) |
| Dashboard, "01" to "11" | `dashboard.html`, `style.css` (shell, mail, dialogs), `console.css` (resource pages), `setup.css`, `developer.css`, `triage.css`, `native-mail.css` |
| Foundations and Components | `tokens.css` |

On September 26, 2026 the token set had content hash `8ccef971`.

## Tokens

`apps/email-dashboard/public/tokens.css` holds the Paper tokens under their
Paper names, so a `var(--color-foreground-muted)` in the Paper export maps to
the same variable in code. The earlier token names (`--color-ink`,
`--color-sand-50`, `--color-text-secondary`, and the rest) stay at the end of
the file as aliases onto the new palette. The generated docs pages still use
them.

| Element | Value |
| --- | --- |
| Canvas and sidebar | `--color-background` `#F8F8F8` |
| Panels, cards, dialogs | `--color-elevated` `#FFFFFF`; hairline `--color-border` `#00000014` |
| Text | `--color-foreground` `#191919`, muted at 56%, subtle at 40% |
| Primary actions | Black pills on the public pages; `--color-ui-button` `#363636` in the app |
| Accent | `--color-accent` `#317CFF` for unread dots and links |
| Status pills | Green 50 with success text, orange 50 with `--color-orange-700` `#B35F1B` text, red 50 with danger text |
| Type sizes | 11, 12, 13, 14, 16, 20, 32, 40, and 64px |
| Radii | 4, 6, 8, 12, 16, and 20px, plus full |

Two-tone headings set a muted first line over an ink second line. Paper
draws that first line in `--color-foreground-subtle`, which measures about
2.5:1 against the canvas. The code uses `--color-foreground-muted` instead,
about 4:1, to clear the 3:1 minimum for large text.

## Fonts

| Token | Family | Use |
| --- | --- | --- |
| `--font-sans` | Geist | Landing, sign-in, and headings |
| `--font-ui` | Inter | Dashboard UI and the docs body |
| `--font-mono` | Geist Mono | Addresses, keys, code |

All three are variable WOFF2 files in `public/fonts/`, served from the
dashboard's own origin under a `font-src 'self'` policy and cached for an hour.
`tokens.css` declares the faces with `font-display: optional`, so a late font
never moves the layout. Inter's license is `fonts/OFL.txt` and comes from the
[Inter repository](https://github.com/rsms/inter). Geist and Geist Mono are
version 1.7.2 of the [`geist` package](https://github.com/vercel/geist-font),
licensed under `fonts/Geist-OFL.txt`.

Paper draws Geist headings about 8% narrower than Chromium does at the same
size and tracking. The self-hosted file matches the Google Fonts build, so the
difference comes from Paper's renderer.

## Landing page

Each section sits in a 1280px column with hairline side rules and a full-width
top rule. The hero shows a three-pane app window built in HTML and CSS, marked
`role="img"`. Its agent pane drops below 1100px and its sidebar below 768px.
The product steps use three photos made for the Paper file, stored as WebP in
`public/images/landing/`.

Copy follows the Paper file where the code agrees with it. Where it did not,
the code won: webhooks are left out because account keys cannot use them yet,
plan descriptions come from `apps/email/src/pricing.ts`, and quarantine is
described as failing sender checks.

The header keeps the `.nav-actions` contract that `site-header.js` relies on:
Log in and Get started for visitors, a dashboard link and account menu for
signed-in visitors.

## Dashboard

A 248px gray sidebar sits beside a white panel with a 12px radius and the
shadow `#0000000F 0 0 0 1px, #0000000A 0 1px 3px`. Base UI text is Inter at
14px. Buttons are 30px with a 6px radius, and inputs are 36px with an 8px
radius. Phone layouts keep 44px tap targets.

The sidebar holds Compose, API keys, Integrations, Domains when enabled, Docs,
and the inbox list. The list comes from the inventory the dashboard already
loads, so it adds no requests. The footer holds Settings, the usage card, and
the account button. The usage card shows sends this month from the plan
meters. With no metered billing it reads Plan and usage.

Paper elements with no data behind them are left out: per-inbox unread and
held counts, the inbox table's unread and latest-message columns, "via MCP"
labels, domain allowance counts, and a top-up button.

## Verification

Use the loopback-only fixture in `apps/email/test/dashboard-fixture.ts`. It
uses an isolated PGlite database and test doubles for sign-in codes, delivery,
routing, DNS, object storage, triage, and billing. Sending there is simulated.

Run the repository's build, check, test, and source checks, then the browser
files under `apps/email-dashboard/test/browser/`. The dashboard unit tests
check that the Node server and the Worker serve `tokens.css`, all three fonts,
and the landing photos with the right content types and security policy.
`refresh.mjs` holds fonts back on `/`, `/sign-in`, and `/sign-up` and checks
that nothing moves when they arrive.
