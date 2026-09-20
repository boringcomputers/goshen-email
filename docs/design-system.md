# Design system

The landing page and the dashboard both follow the Fancy project in Paper.
See [dashboard UX](dashboard-ux.md) for navigation and list behavior.
`console.css` applies the Dashboard artboard shell on `/app`: sand canvas,
240px sidebar, 64px header, 32px content padding, and 12px panels.
The exported Paper tokens remain intact.

## Original Fancy reference

The dashboard shell and the landing page use the [Fancy project in Paper](https://app.paper.design/file/01M2M5SZD5HN356SQFCWH7BCEN/2-0). On September 19, 2026 the 72-token snapshot still had content hash `a098097c`. Its Design System, App Components, Dashboard, and Bezalel Email Landing artboards supplied the values below.

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

The message list, email reader, and compose form adapt these primitives to the existing email functions. Fancy does not contain complete email-specific screen artboards. At narrow widths, the navigation opens as a drawer and the message reader has a back button. Folder, mailbox, domain, and credential actions remain available.

Inter is served from `/fonts/InterVariable.woff2`; the security policy permits fonts only from the dashboard's own origin. The font and its SIL Open Font License come from the [Inter repository](https://github.com/rsms/inter). The bundled license is in `public/fonts/OFL.txt`.

## Public landing page

The [Bezalel Email Landing artboard](https://app.paper.design/file/01M2M5SZD5HN356SQFCWH7BCEN/1-0) supplies the deployed homepage's structure, email capability icons, white canvas, and centered layout. The page copy has since been rewritten for Goshen Email and no longer matches the artboard text. The Design System page includes the same layout rules and updated component examples.

| Element | Specification |
| --- | --- |
| Canvas | `--color-landing-background` aliases white; no beige frame or outer page radius |
| Page sheet | `width: 100%`, `max-width: var(--container-landing)` at 1280px; centered |
| Page gutters | `clamp(20px, 4.45vw, 64px)`; 20px at viewport widths of 600px or less |
| Desktop geometry | At 1440px, the sheet starts at x=80; 64px inner gutters leave 1152px of content |
| Text widths | Hero and workflow paragraph: 820px maximum; hero description: 640px maximum |
| Hero type | 64px/68px desktop; 52px/56px below 1024px; 38px/42px at 600px or less |
| Feature cards | 360px minimum height, 24px internal gap; grow with copy |
| Closing card | Subtle surface `#F3F2EF`, 24px radius |
| Responsive layout | Cards stack below 1024px; phone navigation and actions wrap |

The landing tokens are separate from the dashboard background and general container tokens. Sand remains available for the existing sign-in backdrop and subtle surfaces. Demo and sales destinations remain blank as requested.

## Verification

Use the loopback-only fixtures in `apps/email/test/dashboard-fixture.ts` and `customer-dashboard-fixture.ts`. They use isolated PGlite databases and test doubles for delivery, DNS, and object storage. Sending in these fixtures is simulated.

Run the repository's build, check, test, and source checks with `homelab-job`. The dashboard tests verify that both the Node server and Cloudflare Access runtime serve the token CSS and WOFF2 font with the correct content types and security policy.

All four repository checks passed: 137 email tests, 21 gateway tests, and 15 dashboard tests. Fourteen browser assertions passed, including comparison of all 70 exported tokens, rendered geometry, sign-in, reading, sending with attachments, replies, search, trash/restore, quarantine release, inbox switching, owner/customer controls, masked keys, and responsive navigation at 1024, 768, and 390px. No browser exceptions, console errors, or blocked assets remained.

The browser run also found an existing username pattern incompatible with the HTML `pattern` attribute's Unicode sets syntax. The hyphen is now escaped, and the form rejects invalid usernames in Chromium.

Browser evidence is kept in the ignored `.artifacts/fancy-redesign/` directory for this worktree, including the capture script, screenshots, recording, computed CSS measurements, and assertion report.
