# Bezalel native mail release

The owner authorized deployment on September 17 and required the same email
addresses and history. This release uses the existing `bezalel-email` Worker,
Neon `bezalel_email` database, R2 bucket, delivery queues, and public URLs.
AgentMail and the standalone deployment keep their existing resources.

## Release identity

| Item | Value |
| --- | --- |
| Shared implementation | `80384464e99c8ec4865443f94aa99579c0f137c5` |
| Previous native source | Bezalel `8c39cb800b951b6708bf197927957cad09e8f0e3` |
| Previous Worker version | `b75d5b23-888c-49a3-81bc-6b0b79dbb81c` |
| Profile | [`wrangler.native.jsonc`](../apps/email/wrangler.native.jsonc) |
| Native Hyperdrive | `3d49b61bbf7743998583bab1a04d8845` |
| Origin | Existing Neon database `bezalel_email` |
| Schema owner | Existing `bezalel_email` role |
| Runtime role | `bezalel_email_runtime` |

The Hyperdrive configuration was created and read back through Cloudflare's API.
It uses `verify-full`, the ISRG Root X1 CA, disabled query caching, and a limit
of ten origin connections. The runtime role has mailbox table access and
function execution, but cannot create objects in the mail schema. The schema
owner grants those rights to future objects through default privileges.

The profile preserves `CLOUDFLARE_ACCOUNT_ID` as an existing secret binding.
It retains `BEZALEL_EVENTS_URL` and adds the matching `MAIL_EVENTS_URL`.
Deployment preserves all five existing secrets, including the old `DATABASE_URL`
for code rollback. No mailbox token, webhook secret, address, or ownership
record is replaced.

## Preservation and recovery evidence

The protected PostgreSQL snapshot was restored into disposable PostgreSQL 18.
The final rehearsal applied the candidate schema twice. Its first pass took
26 ms. All original columns matched exactly in all ten original tables, and
existing SQL function definitions were unchanged.

| State | Before | After rehearsal |
| --- | ---: | ---: |
| Inbox records, including test and deleted records | 31 | 31, exact original fields |
| Active production inboxes | 26 | 26, exact addresses and IDs |
| Messages, including test messages | 13 | 13, exact original fields |
| Direct clients | 3 | 3, exact original fields |
| Send reservations | 8 sent | 8 sent, exact keys and results |
| R2 backup | 6 objects, 85,697 bytes | All downloaded with SHA-256 manifests |

Bezalel's ledger matched all 26 active native inboxes with no missing or
unowned inboxes. AgentMail records were inventoried separately and not modified.
Two pending native events were absent from Bezalel's event ledger. Running the
previous release's outbox delivery code delivered both with their original IDs.
Bezalel accepted both, recorded both, and completed fan-out. No agent endpoints
were subscribed to those events. The native outbox then had zero pending rows.

The old and new request handlers returned identical results for 77 reads on
the restored data. Concurrent intake through both service versions stored one
synthetic message. A send made by the candidate and retried through the previous
version called the fake transport once. The previous handler downloaded the
candidate's attachment using its existing signing format. These recovery checks
used local PostgreSQL connections, local object storage, and fake delivery.
They sent no external mail and replayed no historical webhooks.

The live baseline contains 75 successful requests: 38 to the Worker and 37
through Bezalel's owner-scoped dashboard API. It covers inbox/message lists and
all eleven visible production messages and their threads. The protected results
are retained for exact comparison after deployment. They are not public artifacts.

## Activation and recovery

1. Keep the protected PostgreSQL dump, R2 objects, manifests, previous Worker
   artifact, settings, and credentials for at least seven days and until the
   observation and recovery checks pass.
2. Read back the Hyperdrive origin and verify the current Worker version and
   bindings against the inventory. Stop if another deployment changed them.
3. Provide the existing schema-owner URL through `NATIVE_DATABASE_URL` and run
   `pnpm --filter @bezalel/email exec tsx scripts/migrate-native.ts`.
   This command rejects other database identities, uses verified TLS, retains
   the native owner, and runs the schema statements in one transaction with a
   two-second lock timeout and fifteen-second statement timeout. Compare every
   original field before proceeding. Do not run the standalone migration command.
4. Deploy the reviewed native profile to the existing Worker:

   ```sh
   pnpm --filter @bezalel/email exec wrangler deploy \
     --config wrangler.native.jsonc --message "Native mail deployment from bezalel-email"
   ```

5. Verify authenticated mail reads and Bezalel API parity before canary writes.
   Verify existing client keys, the test namespace, owned-address delivery,
   signed events, scheduled work, and queue progress. Record the deployed version.
6. Observe for at least 24 hours. Keep the embedded source until the recovery
   window ends. Remove it through a separate change.

If candidate behavior fails, restore the previous Worker version with the same
live database and objects:

```sh
pnpm --filter @bezalel/email exec wrangler rollback \
  b75d5b23-888c-49a3-81bc-6b0b79dbb81c --config wrangler.native.jsonc \
  --message "Restore previous native mail implementation"
```

Leave the compatible schema additions in place. Never restore the pre-release
snapshot over mail accepted since deployment. Wrangler rollback changes code and
versioned bindings; it does not restore storage. See Cloudflare's
[rollback documentation](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

## Validation status

- Workspace build, type checks, API contract generation check, and source
  provenance check passed. The actual native profile also built with `--dry-run`.
- The PostgreSQL suite passed 221 tests initially. One assertion still expected
  eighteen tables after the settings merge added a nineteenth. That assertion
  was corrected; all five tests in its runtime file passed on rerun.
- Six native migration target and secret-redaction tests passed.
- Companion packages passed 61 tests. Bezalel's six email UI files passed all
  37 tests. The first Bezalel server run passed 63 tests and skipped 77 database
  cases. All seventeen managed-provider tests then passed against isolated
  PostgreSQL, including original-provider replies, ownership, shared limits,
  AgentMail outage isolation, and saved default senders. The remaining database
  cases are running separately after the first combined run was stopped by the
  job wrapper.
- Authenticated browser UI verification, external delivery, and the 24-hour
  observation period are still pending at release preparation time.

Cloudflare's scheduled invocation dataset had stopped recording native runs at
03:18 UTC on September 17 while recent HTTP invocations remained present. The
existing minute schedule was reapplied at 22:51 UTC. Successful runs at 22:57,
22:58, and 22:59 UTC confirmed recovery. The previous Worker also completed its
pending garbage-collection job. The six-object backup predates that collection.
Activation must confirm that scheduled progress continues after the code change.
