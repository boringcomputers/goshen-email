# Bezalel native deployment preparation

The production profile and activation procedure are now in the
[September 17 release record](native-release-2026-09-17.md). The preparation
evidence below describes the earlier implementation and its original gates.

This profile prepares Bezalel's existing native mail Worker to run from this
repository. Merging it does not deploy the Worker, change a database, move mail,
or complete the migration. AgentMail and the standalone service keep their
existing configuration.

The approved direction is a dedicated deployment retaining the existing native
resources. The remaining release gates come from Bezalel's native email
migration plan, which lives in that private repository.

## Deployment profile

[`wrangler.native.template.json`](../apps/email/wrangler.native.template.json) describes
the future deployment configuration and selects
[`native-worker.ts`](../apps/email/src/native-worker.ts). The wrapper delegates
mail handling to the shared implementation. It exposes the existing health,
admin RPC, test RPC, direct-client, attachment, and gateway routes. Account,
dashboard, developer API, and MCP routes return 404.

Before dispatching requests or background handlers, it requires a default
domain, an HTTPS public URL, and an HTTPS event destination. It accepts the old
`BEZALEL_EVENTS_URL` alias, but rejects conflicting aliases and nonempty
account, Access, or Typesafe settings. Missing webhook configuration must fail
before the service can claim an outbox event. Which domain and URLs those are
is configuration in `wrangler.native.jsonc`, not the code. The underlying
service still validates credentials and the database binding.

| Resource | Native profile |
| --- | --- |
| Worker | `bezalel-email` |
| Public URL | The Worker's `workers.dev` origin, as `PUBLIC_EMAIL_URL` in `wrangler.native.jsonc` |
| Default domain | `goshenemail.com` |
| R2 bucket | `bezalel-email` |
| Delivery queue | `bezalel-email-delivery` |
| Dead-letter queue | `bezalel-email-delivery-dead` |
| Shared webhook | `https://mcp.bezalel.sh/events/cloudflare` |
| Cron | Every minute |
| Hyperdrive | Required at release preparation; must connect to the existing native database |

The template is not a deployable Wrangler profile. Its
`REQUIRES_PROVISIONED_NATIVE_HYPERDRIVE_ID` marker must become a verified resource
ID in a separate release change. That change will add `apps/email/wrangler.native.jsonc`
using the template's configuration and the provisioned native binding. This PR
does not create that production file.

The existing `bezalel-email-standalone` Hyperdrive points to the standalone
database and must not be substituted here. Provision and verify a dedicated
native connection with query caching disabled and TLS verification before
preparing the production artifact.

Keep `MAIL_API_TOKEN`, `MAIL_WEBHOOK_SECRET`, and all applicable domain/gateway
secrets unchanged. Preserve `CLOUDFLARE_API_TOKEN` for the native sending account.
The new Worker reads its database connection from Hyperdrive, so keeping the old
`DATABASE_URL` secret alone is insufficient. Secret values belong in protected
deployment configuration, never in this file or Git.

## Local validation

Use Node 24 and pnpm 10.15.1. These commands build without deploying:

```sh
pnpm build
pnpm --filter @bezalel/email exec tsx scripts/build-native.ts
pnpm check
pnpm test
pnpm source:check
```

The native build script accepts no arguments and always passes `--dry-run` to
Wrangler. It gives an ephemeral build configuration a separate Worker name and
an all-zero local Hyperdrive ID, then removes that configuration on exit. It
never provisions a connection or deploys a Worker. A successful local bundle
does not verify Cloudflare resource existence or production readiness.

With a dedicated local PostgreSQL test database, also run:

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5434/bezalel_email_test pnpm test:postgres
```

The test database URL must identify a loopback host and a database ending in
`_test`. Each database fixture creates and removes its own child database. Never
use a production URL. `native-runtime.test.ts` skips without this variable; the
PostgreSQL suite runs it through workerd and the local Hyperdrive binding.

The migration test starts from the deployed native schema at Bezalel commit
`8c39cb800b951b6708bf197927957cad09e8f0e3`, seeds synthetic state, and applies the
candidate migrations twice. It compares every original column, then checks
old client keys, an already-signed attachment link, a completed send key, an
uncertain send, and failed/successful webhook retries. Mail transport, object
storage, and webhook delivery in this test are test doubles.

## Schema and release work still required

The candidate adds customer/account/API-key tables and optional triage columns.
Some shared queries depend on those tables even with the account routes blocked.
Deploying code before the compatible schema upgrade can break mail operations.
The profile does not create customer ownership records or backfill triage.

The September 17 rehearsal found no changes to existing SQL function definitions
and no changes to original row values after either migration pass. This result
covers the pinned candidate and snapshot described in the
[evidence report](evidence/native-deployment-2026-09-17.md).

Before production activation:

1. Refresh the native inventory, resource diff, database/R2 backups, and ownership
   comparisons in Bezalel. Reconcile the two pending live webhook events. Do not
   discard them or replay them to agents as a test.
2. Provision the dedicated native Hyperdrive and verify its database identity,
   runtime grants, TLS, and disabled query cache. Review a native migration role.
   The existing `scripts/migrate.ts` uses `SET LOCAL ROLE postgres`; the restore
   rehearsal did not prove that role assumption or production grants.
3. Pin the final candidate after any other schema changes merge. Rehearse Bezalel
   UI/API parity, AgentMail regressions, the previous Worker on candidate-written
   data, overlapping invocations, and database/R2 restoration. The current
   PostgreSQL rehearsal has no production attachment references and does not
   establish an R2 backup or prove rollback compatibility.
4. Prepare the timed release record and recovery commands for owner approval.
   Keep the existing Worker identity as the sole native writer. A second Worker
   with cron or queue consumers against the same storage is not this migration.
5. After approval, apply the reviewed schema changes and deploy the pinned
   native artifact. Run separately authorized owned-address delivery canaries
   and verify Bezalel event processing. Observe for at least 24 hours as required
   by the migration plan before calling the handoff complete.

The source of the pending-event problem is not established. The configured cron
was present during inventory, but two short live-tail observations showed only
HTTP requests. That observation does not prove that cron is disabled. Resolve
the backlog and verify scheduled progress before approving a production cutover.
