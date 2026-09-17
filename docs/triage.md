# Email triage

Jev assigns a category, estimates whether a reply is needed, and scores urgency
for new incoming messages. The Worker saves the message before calling TypeSafe.
Analysis failures do not prevent reading or replying to mail.

## Enable analysis

Apply `ops/email/triage.sql` after `ops/email/developer-api.sql`, using the schema
owner. The normal migration command includes both. Deploy the Worker and dashboard
from the same revision after the migration. Existing Worker versions ignore the
new columns, so they can keep serving requests during the migration.

Set `TYPESAFE_API_KEY` as a Worker secret to enable analysis for new incoming mail
across this deployment. The key belongs to the operator and never enters dashboard
responses. Customers keep using their existing Bezalel account or mailbox keys.
`TYPESAFE_MODEL` optionally selects a model; the default is `jev-latest`.
Without a TypeSafe key, the Worker stores mail normally and leaves `triage` absent.
Removing the key pauses processing and stops enqueueing new analysis.

TypeSafe receives the sender, up to 50 recipients, subject, received timestamp,
and the first 32,768 UTF-16 code units of plain text. The Worker marks truncated
bodies in the result. It sends no HTML, attachments, API credentials, or Bcc list.
There is no historical backfill or automatic routing in this release.

Quarantined messages are excluded from analysis, and their triage is hidden.
When analysis is enabled at receipt, the Worker stores pending work with the
message. An owner release with a clean antivirus result makes that work eligible
in the same transaction. Jev does not make quarantine
decisions or authorize sending, refunds, or other actions.

## Read and filter results

Message reads, lists, searches, and thread reads include an optional `triage` field.
Its `status` is `pending`, `complete`, or `failed`. Failed results contain a fixed
error code, never the provider's response body. The initial `email.received` webhook
can contain pending triage. Read the message again for the completed result; this
release does not send a separate completion webhook.

Completed results include:

| Field | Meaning |
| --- | --- |
| `category.value` | `billing`, `support`, `sales`, `personal`, `notification`, or `other` |
| `category.probabilities`, `category.confidence` | The full choice distribution and its confidence |
| `needsReply.probability` | Probability that the message required a response when it arrived |
| `needsReply.value` | `true` at 0.8 or above, `false` at 0.2 or below, otherwise `null` |
| `urgency.score` | Probability-weighted position from 0 to 3 |
| `urgency.value` | Rounded score as `low`, `normal`, `high`, or `critical`; `null` when confidence is below 0.5 |
| `urgency.probabilities`, `urgency.confidence` | The full urgency distribution and confidence |
| `model`, `version`, `analyzedAt`, `bodyTruncated` | Model, rubric version, analysis time, and input truncation |
| `durationMs`, `usage` | Request duration and input/output token counts |

The thresholds are initial display rules, not measured accuracy guarantees.
The dashboard marks category confidence below 0.5 as "Maybe" and shows uncertain
reply and urgency judgments explicitly. Confidence describes the distribution,
not whether taking an action is permitted. Evaluate results on representative
mail before using them to automate work.

List and search operations accept `category`, `needsReply`, and `urgency`.
`needsReply` uses `yes`, `no`, or `uncertain`. Filters combine with AND and run
before pagination. Absent, pending, and failed analysis never match a triage filter.
Keep the same filters when requesting the next page.

Thread triage comes from its latest message, ordered by timestamp then ID. A sent
reply therefore clears the thread's suggestion. Individual message triage remains
a record of the incoming message at arrival. Search results filter individual
messages, which may include older messages in an already answered thread.

```ts
const page = await email.messages.list({
  inboxId: 'support@example.com',
  category: 'support',
  needsReply: 'yes',
  urgency: 'critical',
})
```

```python
page = email.messages.list(
    inbox_id='support@example.com', category='support',
    needs_reply='yes', urgency='critical',
)
```

```sh
bezalel-email threads list --inbox-id support@example.com --needs-reply yes
```

The same arguments work with MCP's `list_messages`, `search_messages`, and
`list_threads`, and as REST query parameters. Access requires the existing
`messages:read` scope and ownership of the inbox. Inboxes retain their named groups;
triage categories describe messages and do not move inboxes between groups.

## Processing and recovery

Pending work lives on the message row, committed with the message. Email events
start processing after receipt, and the existing minute cron recovers pending work,
including mail accepted by the SMTP gateway. Each invocation claims at most ten
messages, one at a time. Claims expire after two minutes and carry a lease ID so
late responses cannot overwrite newer results.

TypeSafe requests have a 15-second timeout and a 64 KiB response limit. The Worker
retries network errors, HTTP 429, and server errors up to five total attempts.
Backoff starts at 30 seconds and doubles; a provider Retry-After can extend it to
one hour. The cron determines when due work actually runs. Invalid answers and
other HTTP errors fail immediately. Stored failure codes are `provider_unavailable`,
`provider_rejected`, and `invalid_response`.

Inspect pending/failed counts, attempts, and completed `durationMs`/`usage` in the
database when operating this feature. Fix credentials or provider availability
before retrying failures. There is no customer retry endpoint in this release.
An operator can requeue specific failed message IDs by setting `triage` to
`{"status":"pending"}`, `triage_attempts` to zero, `triage_lease` to null, and
`triage_available_at` to `now()`. Scope any recovery to the intended inbox.

## Local verification

`triage.test.ts` covers provider validation, uncertainty, storage, retry limits,
duplicate receives, expired leases, quarantine, deletion, and thread filters.
`triage-api.test.ts` checks SDK, REST, CLI, MCP, permissions, and response schemas.
Both run against isolated local databases, including the PostgreSQL suite.

Start `test/dashboard-fixture.ts` with `FIXTURE_AUTH_MODE=account` and
`FIXTURE_TRIAGE=true` for browser verification. The fixture's Jev answers,
domain verification, routing, sending, and object storage are test doubles.
These checks establish application behavior, not live model accuracy, cost,
latency, or email delivery.

The integration follows TypeSafe's [HTTP API](https://docs.typesafe.ai/api),
[Choice](https://docs.typesafe.ai/primitives/choice),
[Noul](https://docs.typesafe.ai/primitives/noul), and
[Score](https://docs.typesafe.ai/primitives/score) contracts.
