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

- `MAIL_EVENTS_URL` accepts a shared webhook at any supported URL path.
  `BEZALEL_EVENTS_URL` remains an alias. Shared webhooks can be disabled without
  disabling product-mailbox webhooks or mailbox storage.
- Worker configuration uses example values and separate resource names.
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
