# Extraction verification

Source: Bezalel `27740c1c62a2531d865e04f1f98cb71aa83b6024`.
Task branch: `agent/extract-email-0915a`.
Environment: Linux, Node.js 24.19.0, pnpm 10.15.1, Chromium, temporary PGlite database.

## Automated checks

| Check | Result |
| --- | --- |
| Source baseline | 111 email tests and 21 SMTP gateway tests passed |
| Independent frozen-lockfile install | Passed with three application packages |
| Worker bundle and dashboard/gateway syntax | Passed, Worker dry run only |
| TypeScript and syntax checks | Passed |
| Standalone email tests | 114 passed, including migrations, mailbox isolation, webhook configuration, and Workers runtime HTTP |
| Gateway tests | 21 passed, including SMTP, scanner responses, TLS, and journal handling |
| Dashboard tests | 9 passed, including session expiry/revocation, CSRF/host checks, per-client rate limiting, trusted proxies, concurrent attempts, and secret boundaries |
| Source comparison | 57 copied files match the source; 8 declare intentional changes |
| Bezalel source checkout | Clean; no source application changes |

## Browser evidence

The browser used `test/dashboard-fixture.ts`. Mail operations ran through the
authenticated dashboard, the Worker request handler, and the extracted mailbox
service with its SQL migrations. The provider, DNS verification, and R2 storage
used local test doubles. No real email was sent.

The empty screenshot is the new standalone dashboard before its first inbox.
The populated screenshot shows an inbox created through the dashboard, followed
by incoming fixture mail opened in the reader. This is a runtime flow comparison,
not a screenshot of the original Bezalel dashboard.

| Before creating an inbox | After receiving and opening mail |
| --- | --- |
| ![Empty standalone dashboard](https://pub-6f0cf05705c7412b93a792350f3b3aa5.r2.dev/uploads/2026/09/35b4e47d-540b-4028-b2e9-cf8aea2aeabc-before-empty.png) | ![Standalone inbox and conversation](https://pub-6f0cf05705c7412b93a792350f3b3aa5.r2.dev/uploads/2026/09/3ee7ea04-27d2-4854-bfaf-841887680bf0-after-mail.png) |

Confirmed in Chromium:

- Sign-in, first inbox creation, incoming message listing, and conversation reading.
- Reply accepted by the simulated transport with the original In-Reply-To header.
- New message accepted with an attachment whose decoded bytes match the fixture.
- Quarantined mail stayed outside the inbox until owner release, then became readable there.
- A 390px viewport had a 390px document width, with no horizontal overflow.

## Review regression

The initial shared login throttle blocked a valid owner after a different client
made five failed attempts. The regression test against `c815769` reproduced
HTTP 429 where HTTP 200 was expected. The updated code keeps budgets by connection
IP, or by `X-Real-IP` only from an explicitly trusted proxy. The same test passes,
as do tests for forged forwarding headers, cooldown expiry, and concurrent attempts.
The full project has 144 tests.

The SMTP gateway also packaged with `pnpm deploy --legacy --prod`, and its server
module imported from that package without the Bezalel workspace.

## Limits

Cloudflare account setup, public DNS, real SMTP delivery, live scanners, and inbox
placement were not exercised. No production resources or databases were changed.
The standalone dashboard uses one owner credential; Bezalel tenant policies,
billing, and MCP remain in the original project. Drafts live in the browser tab
and mail bodies render as text.
