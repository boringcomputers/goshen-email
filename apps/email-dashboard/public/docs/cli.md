# CLI

A JSON command-line client for scripts and shells. Every API operation, dry runs, and schema output.

## Availability

The CLI is `goshenemail`, built from the Goshen Email repository and not yet published to npm. From a checkout after `pnpm build`, run it as `node packages/email-cli/dist/main.js`. Node.js 24 is required. The examples below assume the binary is on your `PATH`.

## Configuration

```sh
export GOSHENEMAIL_API_KEY="bze_..."
export GOSHENEMAIL_BASE_URL="https://api.goshenemail.com"   # optional; defaults to the hosted API
```

The key is read from the environment only. There is no flag for it and no config file, so it cannot end up in shell history.

## Commands

```text
goshenemail <resource> <command> [--json <JSON|->] [flags]
```

| Command | Operation |
| --- | --- |
| `inboxes list` | [List inboxes](/docs/api/list-inboxes) |
| `inboxes create` | [Create an inbox](/docs/api/create-inbox) |
| `inboxes get` | [Get an inbox](/docs/api/get-inbox) |
| `inboxes update` | [Update an inbox](/docs/api/update-inbox) |
| `inboxes delete` | [Delete an inbox](/docs/api/delete-inbox) |
| `inboxes finish-setup` | [Finish inbox setup](/docs/api/finish-inbox-setup) |
| `messages list` | [List messages](/docs/api/list-messages) |
| `messages search` | [Search messages](/docs/api/search-messages) |
| `messages get` | [Get a message](/docs/api/get-message) |
| `messages send` | [Send a message](/docs/api/send) |
| `messages reply` | [Reply to a message](/docs/api/reply) |
| `messages labels` | [Update message labels](/docs/api/update-message-labels) |
| `messages attachment` | [Get an attachment](/docs/api/get-attachment) |
| `threads list` | [List threads](/docs/api/list-threads) |
| `threads get` | [Get a thread](/docs/api/get-thread) |
| `threads labels` | [Update thread labels](/docs/api/update-thread-labels) |
| `account usage` | [Get usage](/docs/api/get-usage) |

## Passing input

Simple fields are flags in kebab case; array fields repeat the flag:

```sh
goshenemail inboxes create --username research --group agents
goshenemail messages list --inbox-id research@agents.goshenemail.com --labels received --labels unread --limit 20
goshenemail messages send --inbox-id research@agents.goshenemail.com \
  --to vendor@example.net --subject "Quote request" --text "Could you send the current quote?" \
  --idempotency-key 2f7c1c1e-6d1a-4a3b-9b0e-0c9b3f5c8a11
```

Anything more complex goes in `--json`, either inline or from stdin with `-`:

```sh
goshenemail inboxes update --json '{"inboxId":"research@agents.goshenemail.com","group":null}'
goshenemail messages send --json - < approved-message.json
```

`send` and `reply` require `--idempotency-key` (or `idempotencyKey` in the JSON). See [Sending mail](/docs/sending) for why.

## Output

Results are JSON on stdout, one document per command, so they pipe into `jq`:

```sh
goshenemail threads list --inbox-id research@agents.goshenemail.com --labels unread | jq -r '.threads[].subject'
```

Errors are JSON on stderr with `code`, `message`, and `transient`, and the exit status is 1.

## Dry runs and schemas

`--dry-run` validates the input against the published schema and prints the request that would be sent, with the authorization header redacted. Nothing contacts the API.

```sh
goshenemail messages send --dry-run --inbox-id research@agents.goshenemail.com --to a@example.net --text hi --idempotency-key k1
```

`--schema` after a command prints that operation's JSON Schema; `goshenemail --schema` prints all of them. Useful for generating forms or validating input in another language.

The dry run checks the published schema. The server also enforces limits JSON Schema cannot express (combined body and attachment sizes, recipient totals), so a request that passes a dry run can still be rejected.

## Other flags

| Flag | Meaning |
| --- | --- |
| `--base-url <origin>` | Override `GOSHENEMAIL_BASE_URL` |
| `--help` | Usage and the command list |
| `--version` | Version |
