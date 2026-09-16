# Fancy design system

The dashboard uses the [Fancy project in Paper](https://app.paper.design/file/01M2M5SZD5HN356SQFCWH7BCEN/2-0), inspected on September 16, 2026. Its Design System, App Components, and Dashboard exports supply the values below. The token snapshot has Paper content hash `cee06986`.

`apps/email-dashboard/public/tokens.css` contains the exported tokens with their original names and values. `style.css` applies them to the email interface. The app keeps plain HTML, CSS, and JavaScript.

| Element | Paper specification |
| --- | --- |
| Typography | Inter; 400, 500, and 600 weights |
| App background | Sand 50, `#F3F2EF` |
| Sign-in background | Sand 100, `#EDE6DA` |
| Panels | White, `#FFFFFF`; hairline border, `#E7E3DB` |
| Primary actions | Ink, `#111111`; white text; pill radius |
| Sidebar | 240px; 20px vertical and 12px horizontal padding |
| Navigation | 13px text; 16px icons; 8px radius; white active row |
| Page header | 64px tall; 32px horizontal padding; 20px title |
| Content | 32px horizontal/bottom padding; 12px panel radius |
| Inputs | 40px tall; 8px radius; ink focus border and 3px ring |
| Dialogs | 24px radius and padding; 20px title; Paper modal shadow |
| Status badges | Original success, warning, danger, and neutral tokens |

The message list, email reader, compose form, and customer list adapt these primitives to the existing email functions. Fancy does not contain complete email-specific screen artboards. At narrow widths, the navigation opens as a drawer and the message reader has a back button. Folder, mailbox, domain, credential, and customer actions remain available.

Inter is served from `/fonts/InterVariable.woff2`; the security policy permits fonts only from the dashboard's own origin. The font and its SIL Open Font License come from the [Inter repository](https://github.com/rsms/inter). The bundled license is in `public/fonts/OFL.txt`.

## Verification

Use the loopback-only fixtures in `apps/email/test/dashboard-fixture.ts` and `customer-dashboard-fixture.ts`. They use isolated PGlite databases and test doubles for delivery, DNS, and object storage. Sending in these fixtures is simulated.

Run the repository's build, check, test, and source checks with `homelab-job`. The dashboard tests verify that both the Node server and Cloudflare Access runtime serve the token CSS and WOFF2 font with the correct content types and security policy.

All four repository checks passed: 137 email tests, 21 gateway tests, and 15 dashboard tests. Fourteen browser assertions passed, including comparison of all 70 exported tokens, rendered geometry, sign-in, reading, sending with attachments, replies, search, trash/restore, quarantine release, inbox switching, owner/customer controls, masked keys, and responsive navigation at 1024, 768, and 390px. No browser exceptions, console errors, or blocked assets remained.

The browser run also found an existing username pattern incompatible with the HTML `pattern` attribute's Unicode sets syntax. The hyphen is now escaped, and the form rejects invalid usernames in Chromium.

Browser evidence is kept in the ignored `.artifacts/fancy-redesign/` directory for this worktree, including the capture script, screenshots, recording, computed CSS measurements, and assertion report.
