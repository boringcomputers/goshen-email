# Source and maintenance

Extracted from `boringcomputers/bezalel` at
[`27740c1c62a2531d865e04f1f98cb71aa83b6024`](https://github.com/boringcomputers/bezalel/tree/27740c1c62a2531d865e04f1f98cb71aa83b6024).
The source code remains in Bezalel. No production resources or mailbox data
move as part of this extraction.

The extracted directories are `apps/email`, `apps/email-gateway`, and `ops/email`.
[SOURCE.json](SOURCE.json) records the original SHA-256 for each copied file.
The `modified` list names copied files intentionally changed here. The standalone
dashboard, root workspace files, CI, and new tests are additions.

Changes to the copied code:

- The schema includes organization names and notification preferences on standalone
  dashboard accounts. Message commits queue opted-in notifications, and the Worker
  schedules email summaries. Settings, profiles, and notification delivery are
  implemented in independently added files. Original source hashes are preserved.

- `MAIL_EVENTS_URL` accepts a shared webhook at any supported URL path.
  `BEZALEL_EVENTS_URL` remains an alias. Shared webhooks can be disabled without
  disabling product-mailbox webhooks or mailbox storage.
- Worker configuration uses example values and separate resource names.
- The standalone Worker uses PostgreSQL through a Hyperdrive binding. Migrations
  use a direct PostgreSQL connection; the Neon driver is removed here.
- Test fixtures can use dedicated local PostgreSQL databases through the production driver.
- The Worker also serves the standalone account REST API, OpenAPI, and MCP.
  The developer clients and API-key schema are new standalone additions.
- Messages can carry optional Jev triage. The standalone analyzer and retry
  processor are new files; message storage, reads, and Worker scheduling call them.
- Documentation describes the standalone owner dashboard and deployment.

There is no automatic synchronization. When taking a fix from Bezalel, inspect
the diff from this recorded revision, apply only the relevant changes, and run
the standalone checks. When fixing shared email logic here, carry the patch back
to Bezalel in a separate PR and run its provider and policy tests too.
Do not copy local `.env`, `.dev.vars`, Wrangler state, or production credentials.

`pnpm source:check` checks copied files against the recorded hashes, allowing
only the declared modifications. Update the manifest deliberately when changing
another extracted file. The check verifies provenance, not runtime correctness.

The original [AGPL-3.0-only license](LICENSE) applies to the extracted code and
this project. This repository does not publish or deploy changes automatically.
