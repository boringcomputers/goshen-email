# Contributing

Bug reports, fixes, docs, and features are all welcome. For anything bigger
than a small fix, open an issue first so we can agree on the approach before
you write code.

## Set up

You need Node.js 24 and pnpm 10.15.1. The Python client needs Python 3.10 or
later.

```sh
pnpm install --frozen-lockfile
pnpm build
```

To click through the dashboard with fake mail, run the local fixture described
in the [README](README.md#try-it-locally). It needs no accounts or credentials.

## Run the checks

CI runs these on every pull request. Run them first:

```sh
pnpm build
pnpm check
pnpm test
pnpm source:check
```

The tests use PGlite and test doubles for Cloudflare, R2, and SMTP, so they
need no network access. If your change touches SQL, also run
`pnpm test:postgres` against a disposable local PostgreSQL server. The
[database guide](docs/planetscale.md#verification) has a Docker command for
one. Never point tests or migrations at a database you care about.

## Generated files

Some files are generated. `pnpm check` fails when they drift from their
sources.

- After changing the API contract, run `pnpm api:generate`. It rewrites the
  OpenAPI document, the SDK types, the CLI and MCP schemas, and the related SQL
  in `ops/email/`.
- After editing a page in `apps/email-dashboard/docs/` or the OpenAPI document,
  run `pnpm docs:generate` and commit its output.

Files listed in `SOURCE.json` were copied from Bezalel. If you change one, add
its path to the `modified` list in the same pull request, or
`pnpm source:check` fails.

## Rules the code depends on

- Mailbox keys stay scoped to one inbox, and account keys to one account.
- Secrets and platform tokens never reach browser responses.
- Sends keep their idempotency guarantees. A retry with the same key never
  sends twice.
- Quarantine decisions stay in the API Worker.
- Never commit `.env`, `.dev.vars`, or real credentials. Both files are
  gitignored; copy the `.example` files instead.

Handlers and routes decide when something happens. Shared services such as
`apps/email/src/mail-service.ts` own how it happens, with explicit inputs and
structured results. Put reusable logic in a service rather than copying it
between handlers.

## Pull requests

Keep each pull request to one change. The template asks for:

- what changed and why,
- how you tested it, with the commands you ran and what they printed,
- a screenshot from the local fixture for dashboard changes,
- which provider operations (sending, routing, DNS, storage, queues) used test
  doubles, since local tests can't prove live delivery,
- schema changes, deploy order, or other risks.

Maintainers deploy the hosted service and apply schema changes to its database
separately. Contributors never need production access.

## Coding agents

`AGENTS.md` and `CLAUDE.md` describe the workflow the maintainers' coding
agents follow: isolated worktrees, recorded evidence, and an automated review
loop. You don't need to follow it as a human contributor. Agents working in
this repository should.

## License

By contributing, you agree to license your work under the project's
[AGPL-3.0-only license](LICENSE).
