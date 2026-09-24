# Developer tools

Goshen Email has an account API, a JSON CLI, and MCP over Streamable HTTP or
stdio. All use the same 17-operation contract. There is no SDK; call the REST
API directly from any language.

When the operator enables [email triage](triage.md), message and thread responses
include category, needs-reply, and urgency judgments. Lists and searches accept
the same triage filters across REST, CLI, and MCP.

This release needs the migration and Worker/dashboard rollout below. The CLI and
the stdio MCP server are built from this repository and have not been published
to npm. Installation examples here use the checkout.

## Get an API key

Sign in to the dashboard, open **API keys**, and choose **Create API key**. Name a key, select its
permissions, and choose its expiration. Copy the key immediately: it is shown
once and only its SHA-256 hash is stored. **Revoke** stops future requests.
Disabling a customer also revokes their keys; re-enabling them does not restore
old keys. An account can have up to 20 active keys for rotation or different
applications. One key is enough to manage all its inboxes through any client.
Keys default to 30 days and can expire after 1 to 365 days.

Use `GOSHENEMAIL_API_KEY` for the CLI and MCP. Account keys start with `bze_` and
can access only inboxes owned by that account. Even a dashboard administrator's
key cannot access other customers or legacy platform inboxes. On the hosted
service the account's plan sets its inbox count and monthly send and triage
allowances; a spent allowance returns `billing_limit` (402), and `getUsage`
(`GET /v1/usage`) reports what remains. See the [pricing guide](pricing.md).
Without billing configured, accounts have no inbox-count cap by default and an
operator can set an explicit quota. Send limits always apply. Keys cannot
create other keys, release quarantine, or change plans.

| Scope | Access |
| --- | --- |
| `inboxes:read` | List and inspect inboxes |
| `inboxes:write` | Create, group, finish setup, and permanently delete inboxes |
| `messages:read` | Read/search messages, threads, and attachment download URLs |
| `messages:write` | Update message and thread labels |
| `messages:send` | Send and reply |

Existing `gme_` mailbox keys also work with the REST API, CLI, and stdio MCP.
They can list only their assigned inbox and cannot create or delete inboxes.
Hosted MCP currently requires an account key. Neither surface accepts the
platform's `MAIL_API_TOKEN`.

## HTTP API

The base URL is your email Worker origin. For the hosted deployment:

```sh
export GOSHENEMAIL_BASE_URL=https://api.goshenemail.com
# Set GOSHENEMAIL_API_KEY through your secret manager or environment.
curl "$GOSHENEMAIL_BASE_URL/v1/inboxes" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY"

curl "$GOSHENEMAIL_BASE_URL/v1/inboxes" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY" \
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

## CLI

Build with Node 24 and pnpm 10.15.1 (`pnpm install --frozen-lockfile`, then
`pnpm build`), then run it from the checkout:

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
    "goshenemail": {
      "url": "https://api.goshenemail.com/mcp",
      "headers": { "Authorization": "Bearer ${GOSHENEMAIL_API_KEY}" }
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
`packages/email-mcp/dist/main.js` and pass `GOSHENEMAIL_API_KEY` and optionally
`GOSHENEMAIL_BASE_URL` in the subprocess environment. Stdio advertises the complete
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
changes the default inbox quota to unlimited for new accounts. Every existing
quota is preserved, including five: the old schema cannot distinguish its
automatic default from a manually assigned quota. Review older accounts
individually before setting their `inbox_limit` to `NULL` to remove a limit.
Migration reruns also preserve assigned quotas.

Deploy the API before the dashboard. No new secrets, SMTP changes, or DNS changes
are needed. Package publishing is a separate release step. Rollback can restore
the old Workers while retaining the additive key table; retain key revocation in
the customer-disable routine.

Run `pnpm api:generate` after changing the contract and `pnpm api:check` to detect
drift. The same generator writes the reviewed migration from `api-key-schema.ts`
and `account-inbox-schema.ts`.
Run `pnpm build`, `pnpm check`, `pnpm test`, `pnpm test:postgres`, and
`pnpm source:check` with isolated local databases.

`developer-api.test.ts` runs the internal client, CLI, and a real MCP client against the
Worker handlers and local storage. Provider delivery, domain verification, and
object storage use test doubles. It does not prove real email delivery.
Browser evidence uses `apps/email/test/dashboard-fixture.ts` in account mode.
