# Bezalel native mail release

The owner authorized deployment on September 17 and required the same email
addresses and history. This release uses the existing `bezalel-email` Worker,
Neon `bezalel_email` database, R2 bucket, delivery queues, and public URLs.
AgentMail and the standalone deployment keep their existing resources.

The migration is live. At 23:41 UTC on September 17, the reviewed native profile
replaced the embedded implementation on the existing Worker. Production checks
below passed. The 24-hour observation period ends September 18 at 23:46 UTC;
that period is still in progress.

## Release identity

| Item | Value |
| --- | --- |
| Shared implementation | `80384464e99c8ec4865443f94aa99579c0f137c5` |
| Activated source commit | `fdb3c1133d0018385d9b1c7ff674e996da8ad96a` |
| Active Worker version | `a599ab54-7473-46d0-9c27-6d21962050fb`, 100% traffic |
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

The profile declares those five secrets as required. The native deployment
command reads their names and types from the existing Worker and stops before
uploading code if any are missing or the inventory fails. It never rotates or
uploads secrets. Missing credentials must be recovered from protected storage;
generating replacements would invalidate existing client keys or signatures.

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
all eleven visible production messages and their threads. All 75 responses
matched exactly after deployment, before the delivery check added new messages.
The protected results are retained as evidence. They are not public artifacts.

## Production verification

The native migration completed at 23:41:26 UTC. Its command took 1.64 seconds,
including process startup. Every original field matched in all ten original
tables. The runtime role had the required grants on all nineteen tables.

| Check | Before activation | After activation |
| --- | --- | --- |
| Existing inbox records | 31 | All 31 unchanged |
| Existing message records | 13 | All 13 unchanged; three new delivery-check messages |
| Native ownership | 26 active inboxes | All 26 ledger records unchanged |
| AgentMail ledger | 88 records across all statuses | All 88 unchanged |
| Direct mailbox clients | Three existing keys | All three authenticated successfully; no rotation |
| Test namespace | One active test inbox | Same inbox visible through the test API |
| Worker and Bezalel API reads | 75 baseline responses | 75 exact matches |
| Pending work | Zero pending events or intake | Zero pending events, intake, or unsettled sends |

The delivery check used an existing owner mailbox and the same owner's connected
Gmail account. The initial send arrived in Gmail. Retrying the same request
returned its original receipt without another send. A Gmail reply arrived in
Bezalel with one received event attributed to the correct owner and completed
fan-out. Its 90-byte attachment downloaded through Bezalel's signed URL with
identical bytes. Replying through Bezalel reached Gmail in the same thread.
Both outgoing messages passed Gmail's SPF, DKIM, and DMARC checks. The three
check messages remain in the inbox history.

Cloudflare readback confirmed the existing R2 bucket, delivery queue, minute
schedule, public URL, and all five secrets. Scheduled execution succeeded after
activation. No customer records or customer notifications were created.
All 26 domain ledger records and the empty draft ledger are unchanged. The five
original R2 objects remaining after the previous Worker's garbage collection
still match their backup hashes, totaling 75,446 bytes. The sixth backed-up
object belonged to the garbage-collection job completed before activation.

A local systemd user service, `bezalel-native-release-0917a-observation`, checks
the Worker, original record presence, inbox ownership, pending work, and recent
scheduled execution every five minutes until September 18 at 23:46 UTC. Its
initial samples passed. It records failures for review and never changes mail or
rolls back automatically. The protected status and sample log are under
`.artifacts/native-release/private/`. The worktree must remain until observation
finishes. Protected recovery material also exists outside the worktree and must
remain through at least September 25 at 00:00 UTC.

## Activation and recovery

1. Keep the protected PostgreSQL dump, R2 objects, manifests, previous Worker
   artifact, settings, and credentials for at least seven days and until the
   observation and recovery checks pass.
2. Read back the Hyperdrive origin and verify the current Worker version and
   bindings against the inventory. Stop if another deployment changed them.
3. Provide the existing schema-owner URL through `NATIVE_DATABASE_URL`, name its
   host separately in `NATIVE_DATABASE_HOST`, and run
   `pnpm --filter @bezalel/email exec tsx scripts/migrate-native.ts`.
   This command rejects other database identities, uses verified TLS, retains
   the native owner, and runs the schema statements in one transaction with a
   two-second lock timeout and fifteen-second statement timeout. Compare every
   original field before proceeding. Do not run the standalone migration command.
4. Deploy the reviewed native profile to the existing Worker:

   ```sh
   pnpm --filter @bezalel/email exec tsx scripts/deploy-native.ts
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
- Six native migration target and secret-redaction tests and seven deployment
  secret-inventory tests passed.
- Companion packages passed 61 tests. Bezalel's six email UI files passed all
  37 tests. All 140 distinct focused Bezalel server cases passed across isolated
  PostgreSQL runs, including managed providers, signed events, policy, drafts,
  replies, and AgentMail isolation. The first combined run stopped in the job
  wrapper after 96 passing cases; focused runs covered the remaining cases.
- Production verification used authenticated dashboard APIs and real delivery.
  No authenticated browser session was available, so these results do not claim
  a manual browser walkthrough. The 24-hour observation period is still running.
- GitHub Actions could not start because the account has a billing or spending
  limit block. The build and test results above came from local runs.

Cloudflare's scheduled invocation dataset had stopped recording native runs at
03:18 UTC on September 17 while recent HTTP invocations remained present. The
existing minute schedule was reapplied at 22:51 UTC. Successful runs at 22:57,
22:58, and 22:59 UTC confirmed recovery. The previous Worker also completed its
pending garbage-collection job. The six-object backup predates that collection.
The new Worker recorded a successful scheduled run at 23:42 UTC, after activation.
