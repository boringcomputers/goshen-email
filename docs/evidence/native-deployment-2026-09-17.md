# Native deployment evidence, September 17, 2026

This records preparation and isolated tests. No production deployment, schema
write, message replay, or external email send took place.

## Source and live inventory

- Native Worker version `b75d5b23-888c-49a3-81bc-6b0b79dbb81c`, deployed September
  11 from Bezalel `8c39cb800b951b6708bf197927957cad09e8f0e3`.
- Candidate base `bezalel-email` commit
  `26fce1268359ea3ffbaff0f8c7b4f0d2bdf06ec5`, plus this PR's native profile.
- Native database `bezalel_email` on Neon, runtime role `bezalel_email`, with
  10 tables in schema `mail`. The standalone Hyperdrive targets a different
  database. No native Hyperdrive was provisioned during this work.
- Authenticated production `listInboxes` returned 26 inboxes. Sorted address
  identities exactly matched the active, non-test native database rows.
- The native R2 bucket, delivery queue, dead-letter queue, catch-all route, and
  every-minute schedule retain the resources named in the deployment profile.

## Protected snapshot restore

At 16:11 UTC, `pg_dump` read the native `mail` schema with a read-only session and
verified TLS. A disposable PostgreSQL 18 container on loopback restored the dump.
The candidate migration ran only there, with a 2-second lock timeout and a
15-second statement timeout. The first migration took 23 ms on that isolated
copy. This is not a production lock-time estimate.

The comparison projected every original column and hashed each table's sorted
canonical JSON rows. Every hash matched after migration and after a second pass.

| Original table | Restored rows | Rows after both passes | Original values |
| --- | ---: | ---: | --- |
| `clients` | 3 | 3 | Exact match |
| `domains` | 1 | 1 | Exact match |
| `garbage` | 1 | 1 | Exact match |
| `inboxes` | 31 | 31 | Exact match |
| `incoming` | 0 | 0 | Exact match |
| `messages` | 13 | 13 | Exact match |
| `outbox` | 6 | 6 | Exact match |
| `recipient_suppressions` | 0 | 0 | Exact match |
| `schema_migrations` | 1 | 1 | Exact match |
| `sends` | 8 | 8 | Exact match |

The 31 inbox rows include active inboxes, test inboxes, and deletion tombstones.
All eight send records were completed. Four outbox rows were delivered; two
remained pending with zero attempts, one `email.received` and one
`email.delivery_updated`. Their payloads and retry state were preserved without
replaying them. Existing SQL function definitions were unchanged.

The snapshot contains zero attachment references. Synthetic attachment tests
cover signed links and bytes, but this snapshot does not prove an R2 restore.
The dump and full hashes remain in a protected, ignored artifact directory.
Only aggregate results appear here. The disposable database was removed after
comparison. Production grants were not imported or tested by this restore.

## Reproducible behavior checks

| Check | Before upgrade or with shared entry point | Native candidate result |
| --- | --- | --- |
| Schema | Frozen native schema and synthetic data | Every original field in all 10 tables unchanged after two passes |
| Developer route | Standalone `/openapi.json` returns 200 | Native route returns 404 |
| Shared webhook omitted | Standalone supports an optional shared destination | Native returns 503 before dispatch or claiming background work |
| Existing credentials | Client token version 4 and signed attachment link | Client reads succeed; attachment bytes equal `Original file` |
| Completed send retry | Original key and fingerprint | Existing result returned; transport called zero times |
| Uncertain send | Pending reservation | Reservation stays pending; transport called zero times |
| Pending webhooks | Existing IDs, payloads, attempts, direct/shared targets | 503 retains pending state; later 200 acknowledges each once with the same IDs and valid signatures |
| Standalone features | Account, Access, or Typesafe settings present | Native configuration rejects them before handling mail |
| Deployment configuration | An all-zero binding in `wrangler.native.jsonc` let local bundling pass despite a missing remote resource | Production profile removed; preparation template requires a real ID in the release change. The build script only creates an ephemeral dry-run configuration and rejects extra CLI flags. |

These checks use synthetic mail, a memory object store, and captured webhook
requests. They do not contact recipients or agents. The frozen schema fixture
records its original source and license.

The repository build, type checks, generated API check, test suites, and source
provenance check passed locally. The native build script also bundled the
Worker without deployment. See the PR for final test counts and hosted CI
status. Production canaries, Bezalel UI parity, rollback/overlap testing, R2
backup restoration, and the pending-event diagnosis remain release gates.
