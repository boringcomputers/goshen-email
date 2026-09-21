# API overview

The REST API: base URL, authentication, conventions, and the 17 operations shared by every client.

## Base URL

```text
https://bezalel-email-standalone.michaelwasihun96.workers.dev
```

All paths below are relative to it and versioned under `/v1`. The OpenAPI 3.1 document is served at [`/openapi.json`](https://bezalel-email-standalone.michaelwasihun96.workers.dev/openapi.json) and is the source the SDK types, CLI schemas, and MCP tool schemas are generated from.

## Authentication

Every request carries `Authorization: Bearer <key>`, where the key is an account key (`bze_`) or a mailbox key (`gme_`). Each operation requires one scope, listed on its page. See [Authentication](/docs/authentication).

## Conventions

- **JSON in, JSON out.** Request bodies are `application/json`. Responses are resource objects, not envelopes.
- **Identifiers in paths are URL encoded.** `inboxId` is the inbox's email address; `messageId` is an RFC 5322 Message-ID with angle brackets. `research@agents.goshenemail.com` becomes `research%40agents.goshenemail.com`.
- **Arrays in queries repeat the name.** `?labels=received&labels=unread`.
- **Lists page with tokens.** Pass `nextPageToken` back as `pageToken`. See [Pagination](/docs/pagination).
- **Sends are idempotent.** `send` and `reply` require an `idempotencyKey`; `Idempotency-Key` as a header also works. See [Sending mail](/docs/sending).
- **Errors are uniform.** `{ "error": { "code", "message", "transient" } }` with a 4xx or 5xx status. See [Errors](/docs/errors).
- **Times are ISO 8601** in UTC.

## Operations

### Inboxes

| Operation | Method and path | Scope |
| --- | --- | --- |
| [List inboxes](/docs/api/list-inboxes) | `GET /v1/inboxes` | `inboxes:read` |
| [Create an inbox](/docs/api/create-inbox) | `POST /v1/inboxes` | `inboxes:write` |
| [Get an inbox](/docs/api/get-inbox) | `GET /v1/inboxes/{inboxId}` | `inboxes:read` |
| [Update an inbox](/docs/api/update-inbox) | `PATCH /v1/inboxes/{inboxId}` | `inboxes:write` |
| [Delete an inbox](/docs/api/delete-inbox) | `DELETE /v1/inboxes/{inboxId}` | `inboxes:write` |
| [Finish inbox setup](/docs/api/finish-inbox-setup) | `POST /v1/inboxes/{inboxId}/setup` | `inboxes:write` |

### Messages

| Operation | Method and path | Scope |
| --- | --- | --- |
| [List messages](/docs/api/list-messages) | `GET /v1/inboxes/{inboxId}/messages` | `messages:read` |
| [Search messages](/docs/api/search-messages) | `GET /v1/inboxes/{inboxId}/messages/search` | `messages:read` |
| [Get a message](/docs/api/get-message) | `GET /v1/inboxes/{inboxId}/messages/{messageId}` | `messages:read` |
| [Send a message](/docs/api/send) | `POST /v1/inboxes/{inboxId}/messages/send` | `messages:send` |
| [Reply to a message](/docs/api/reply) | `POST /v1/inboxes/{inboxId}/messages/{messageId}/reply` | `messages:send` |
| [Update message labels](/docs/api/update-message-labels) | `PATCH /v1/inboxes/{inboxId}/messages/{messageId}/labels` | `messages:write` |
| [Get an attachment](/docs/api/get-attachment) | `GET /v1/inboxes/{inboxId}/messages/{messageId}/attachments/{attachmentId}` | `messages:read` |

### Threads

| Operation | Method and path | Scope |
| --- | --- | --- |
| [List threads](/docs/api/list-threads) | `GET /v1/inboxes/{inboxId}/threads` | `messages:read` |
| [Get a thread](/docs/api/get-thread) | `GET /v1/inboxes/{inboxId}/threads/{threadId}` | `messages:read` |
| [Update thread labels](/docs/api/update-thread-labels) | `PATCH /v1/inboxes/{inboxId}/threads/{threadId}/labels` | `messages:write` |

### Account

| Operation | Method and path | Scope |
| --- | --- | --- |
| [Get usage](/docs/api/get-usage) | `GET /v1/usage` | `inboxes:read` |

## Validation

The OpenAPI schemas describe most constraints. The server also enforces a few that JSON Schema cannot express: a body (`text` or `html`) is required on sends, `text` plus `html` must fit in 512 KiB, attachments must fit in 2 MiB combined, and `to` plus `cc` plus `bcc` is capped at 50. Requests that fail validation return `invalid_argument` (422) with a message naming the field.

## Other endpoints

- `GET /openapi.json`: the contract.
- `POST /mcp`: the hosted [MCP server](/docs/mcp).
- `GET /healthz`: liveness.

The `/inbox-rpc/*` and `/rpc/*` paths serve older clients and platform integrations and are not covered here.
