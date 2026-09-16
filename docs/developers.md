# Developer tools

Bezalel Email has an account API, TypeScript and Python clients, a JSON CLI, and
MCP over Streamable HTTP or stdio. All use the same 16-operation contract.

This release needs the migration and Worker/dashboard rollout below. The npm
and Python packages are built from this repository; they have not been published
to a package registry. Installation examples here use the checkout.

## Get an API key

Sign in to the dashboard and open **Developers**. Name a key, select its
permissions, and choose its expiration. Copy the key immediately: it is shown
once and only its SHA-256 hash is stored. **Revoke** stops future requests.
Disabling a customer also revokes their keys; re-enabling them does not restore
old keys. An account can have up to 20 active keys for rotation or different
applications. One key is enough to manage all its inboxes through any client.
Keys default to 30 days and can expire after 1 to 365 days.

Use `BEZALEL_API_KEY` for SDKs, CLI, and MCP. Account keys start with `bze_` and
can access only inboxes owned by that account. Even a dashboard administrator's
key cannot access other customers or legacy platform inboxes. Accounts have no
inbox-count cap by default. An operator can set an explicit account quota;
send limits still apply. Keys cannot create other keys or release quarantine.

| Scope | Access |
| --- | --- |
| `inboxes:read` | List and inspect inboxes |
| `inboxes:write` | Create, group, finish setup, and permanently delete inboxes |
| `messages:read` | Read/search messages, threads, and attachment download URLs |
| `messages:write` | Update message and thread labels |
| `messages:send` | Send and reply |

Existing `gme_` mailbox keys also work with the REST API, SDKs, CLI, and stdio MCP.
They can list only their assigned inbox and cannot create or delete inboxes.
Hosted MCP currently requires an account key. Neither surface accepts the
platform's `MAIL_API_TOKEN`.

## HTTP API

The base URL is your email Worker origin. For the hosted deployment:

```sh
export BEZALEL_BASE_URL=https://bezalel-email-standalone.michaelwasihun96.workers.dev
# Set BEZALEL_API_KEY through your secret manager or environment.
curl "$BEZALEL_BASE_URL/v1/inboxes" \
  -H "Authorization: Bearer $BEZALEL_API_KEY"

curl "$BEZALEL_BASE_URL/v1/inboxes" \
  -H "Authorization: Bearer $BEZALEL_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"username":"research","displayName":"Research agent"}'
```

The [OpenAPI specification](openapi.json) is also served at `/openapi.json`.
Responses are JSON resource objects, not the legacy RPC `{result: ...}` envelope.
Errors use `{error: {code, message, transient}}` with an HTTP error status.
Identifiers in paths must be URL encoded. `inboxId` is the canonical inbox email
address, not a UUID; use the returned value even when a custom address exists.
List responses include `nextPageToken` when another page exists. Pass it back as
`pageToken`, unchanged. Inbox lists default to 50 items, allow up to 100, and
sort by creation time and ID. Keep the same account and group filter between
pages. Lists reflect current data, so changes during traversal can affect the
results. Array query parameters repeat: `labels=received&labels=unread`.

Creating an inbox requires a username. Retry the same username if the response
is lost. If routing fails, the address stays reserved; call `finishInboxSetup`
or retry its creation. A different username means a different inbox.

Add `group: "research"` when creating an inbox to organize it under that account.
Groups use 1–64 lowercase letters, digits, underscores, or hyphens, starting with
a letter or digit. They need no separate creation step. Filter with
`GET /v1/inboxes?group=research`, move an inbox with
`PATCH /v1/inboxes/{inboxId}` and `{"group":"support"}`, or clear its group with
`{"group":null}`. Retrying inbox creation preserves its current group.
Groups are organizational labels; the account key can access all groups allowed
by its operation scopes. They are not isolated tenants or permission boundaries.
Mailbox keys cannot filter groups, paginate inboxes, or change groups.

Sends and replies require an explicit `idempotencyKey`. Keep the same key **and
contents** after a timeout or uncertain result. A new intended email needs a new
key. REST callers may provide `Idempotency-Key` instead; if both forms are
provided they must agree. Clients never automatically retry requests.

Schema validation also checks body presence, combined body/attachment sizes,
and recipient limits that JSON Schema does not fully describe. CLI dry runs
validate the published schema; the server remains authoritative.

## TypeScript / JavaScript

Build with Node 24 and pnpm 10.15.1:

```sh
pnpm install --frozen-lockfile
pnpm build
```

Use the workspace package `@bezalel/email-sdk`, or create a local tarball with
`pnpm --filter @bezalel/email-sdk pack --pack-destination /tmp` and install that
tarball in another project. Both JavaScript and TypeScript use the same client:

```ts
import { BezalelEmail } from '@bezalel/email-sdk'

const email = new BezalelEmail({
  apiKey: process.env.BEZALEL_API_KEY!,
  baseUrl: process.env.BEZALEL_BASE_URL,
})
const inbox = await email.inboxes.create({ username: 'research', group: 'agents' })
const agents = await email.inboxes.list({ group: 'agents' })
await email.inboxes.update({ inboxId: inbox.inboxId, group: 'research' })
for await (const page of email.pages('listInboxes', { group: 'research' })) {
  for (const inbox of page.inboxes) console.log(inbox.inboxId)
}
const page = await email.messages.list({ inboxId: inbox.inboxId, limit: 20 })

// Only send after the user authorizes the message. Save this key for retries.
const idempotencyKey = crypto.randomUUID()
await email.messages.send({
  inboxId: inbox.inboxId, to: ['recipient@example.net'], subject: 'Hello',
  text: 'Hello from Bezalel', idempotencyKey,
})

for await (const page of email.pages('listMessages', { inboxId: inbox.inboxId })) {
  for (const message of page.messages) console.log(message.subject)
}
```

`BezalelError` exposes `status`, `code`, and `transient`. A `network_error` means
that the outcome may be unknown, not that a send failed. The default timeout is
30 seconds; configure `timeoutMs` or pass a signal to `client.request`.
Caller cancellation returns non-transient `request_cancelled`. Cancellation
does not undo a send that the server has already accepted.

## Python

Python 3.10 or later is supported. The runtime uses the standard library.

```sh
python3 -m pip install ./packages/email-python
```

```python
import os
from bezalel_email import BezalelEmail

email = BezalelEmail(api_key=os.environ['BEZALEL_API_KEY'])
inbox = email.inboxes.create(username='research', group='agents')
email.inboxes.update(inbox_id=inbox['inboxId'], group='research')
for page in email.pages('listInboxes', group='research'):
    for item in page['inboxes']:
        print(item['inboxId'])
messages = email.messages.list(inbox_id=inbox['inboxId'], limit=20)
for page in email.pages('listMessages', inbox_id=inbox['inboxId']):
    for message in page['messages']:
        print(message['subject'])
```

Python keyword arguments use snake case; responses keep the API's camel-case
field names. `BezalelError` has `status`, `code`, and `transient`. Set `base_url`
for another deployment and `timeout` in seconds. The client is synchronous.

## CLI

From the built checkout:

```sh
node packages/email-cli/dist/main.js inboxes list
node packages/email-cli/dist/main.js inboxes create --username research --group agents
node packages/email-cli/dist/main.js inboxes list --group agents --limit 10
node packages/email-cli/dist/main.js inboxes update --inbox-id research@example.com --group research
node packages/email-cli/dist/main.js inboxes update --json '{"inboxId":"research@example.com","group":null}'
node packages/email-cli/dist/main.js messages list --inbox-id research@example.com
node packages/email-cli/dist/main.js messages send --dry-run \
  --inbox-id research@example.com --to recipient@example.net \
  --text 'Hello' --idempotency-key saved-request-id
node packages/email-cli/dist/main.js messages send --json - < approved-message.json
node packages/email-cli/dist/main.js --schema
```

Output is JSON on stdout. Errors are JSON on stderr and exit with status 1.
`--dry-run` sends no request and redacts authorization. Use `--json` for complex
inputs such as attachments, or repeat array flags (`--to a@example.net --to
b@example.net`). Use `--schema` after a command to inspect its input contract.
No credentials are accepted as command-line flags or written to a config file.

## MCP

Hosted MCP uses the API Worker's `/mcp` endpoint and an account API key in the
Authorization header. Configure your client's secret/environment interpolation
rather than committing an actual token:

```json
{
  "mcpServers": {
    "bezalel-email": {
      "url": "https://bezalel-email-standalone.michaelwasihun96.workers.dev/mcp",
      "headers": { "Authorization": "Bearer ${BEZALEL_API_KEY}" }
    }
  }
}
```

The exact configuration syntax depends on the MCP host. This release uses
header authentication, not OAuth. Each HTTP request rechecks the key, its
expiration, and account status. Discovery includes only tools allowed by the
key's scopes. Tools enforce authorization again when called.
`create_inbox`, `update_inbox`, and `list_inboxes` accept the same group and
pagination fields as the REST API.

For stdio, configure `node` with the absolute path to
`packages/email-mcp/dist/main.js` and pass `BEZALEL_API_KEY` and optionally
`BEZALEL_BASE_URL` in the subprocess environment. Stdio advertises the complete
catalog; the API rejects operations outside the key's scope. It writes only
MCP protocol messages to stdout.

Email text, subjects, names, and attachments are untrusted input. Tools describe
this boundary and annotate read-only and destructive operations. The server
does not run commands from messages or automatically send mail.

## Rollout and verification

Apply `ops/email/developer-api.sql` after the account and onboarding migrations,
using the schema owner and explicit production migration approval. Verify that
the application role has SELECT/INSERT/UPDATE/DELETE on `mail.api_keys` and
EXECUTE on `mail.create_api_key` and `mail.set_customer_access`. Existing default
grants should cover these; verify them before deploying.
Also verify EXECUTE on the replacement six-argument
`mail.provision_customer_inbox` function. The migration adds inbox groups and
changes the default inbox quota to unlimited. On the first upgrade it converts
existing quotas of five to unlimited, because the old schema cannot distinguish
the automatic default from a manually assigned five-inbox quota. Other explicit
quotas remain. Subsequent migration runs preserve all assigned quotas.

Deploy the API before the dashboard. No new secrets, SMTP changes, or DNS changes
are needed. Package publishing is a separate release step. Rollback can restore
the old Workers while retaining the additive key table; retain key revocation in
the customer-disable routine.

Run `pnpm api:generate` after changing the contract and `pnpm api:check` to detect
drift. The same generator writes the reviewed migration from `api-key-schema.ts`
and `account-inbox-schema.ts`.
Run `pnpm build`, `pnpm check`, `pnpm test`, `pnpm test:postgres`, and
`pnpm source:check` with isolated local databases.

`developer-api.test.ts` runs the SDK, CLI, and a real MCP client against the
Worker handlers and local storage. Provider delivery, domain verification, and
object storage use test doubles. It does not prove real email delivery.
Browser evidence uses `apps/email/test/dashboard-fixture.ts` in account mode.
