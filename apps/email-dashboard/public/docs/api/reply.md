# Reply to a message

Reply to an email only when authorized. Preserve idempotencyKey and contents on retries.

`POST /v1/inboxes/{inboxId}/messages/{messageId}/reply`

Requires scope `messages:send`. MCP tool `reply`. CLI `goshenemail messages reply`.

## Request

### Path parameters

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `inboxId` | `string (email)` | Yes | up to 254 characters |
| `messageId` | `string` | Yes | 1–998 characters |

### Body

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `attachments` | `object[]` |  | up to 10 items |
|   `filename` | `string` | Yes | 1–200 characters |
|   `contentType` | `string` | Yes | up to 100 characters |
|   `content` | `string` | Yes | up to 2,796,204 characters |
| `labels` | `string[]` |  | up to 50 items |
| `text` | `string` |  | up to 2,000,000 characters |
| `html` | `string` |  | up to 2,000,000 characters |
| `replyAll` | `boolean` |  | default false |
| `to` | `string (email)[]` |  | at least 1 item, up to 50 items |
| `cc` | `string (email)[]` |  | up to 50 items |
| `bcc` | `string (email)[]` |  | up to 50 items |
| `idempotencyKey` | `string` | Yes | 1–200 characters |

## Response

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `messageId` | `string` | Yes |  |
| `threadId` | `string` | Yes |  |
| `deduplicated` | `boolean` |  |  |

Errors return `{ "error": { "code", "message", "transient" } }` with a 4xx or 5xx status.

## Examples

```sh
curl "https://api.goshenemail.com/v1/inboxes/research%40agents.goshenemail.com/messages/%3C20260920.12345%40agents.goshenemail.com%3E/reply" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello, could you send the current quote?",
    "idempotencyKey": "2f7c1c1e-6d1a-4a3b-9b0e-0c9b3f5c8a11"
  }'
```

### CLI

```sh
goshenemail messages reply --inbox-id "research@agents.goshenemail.com" --message-id "<20260920.12345@agents.goshenemail.com>" --text "Hello, could you send the current quote?" --idempotency-key "2f7c1c1e-6d1a-4a3b-9b0e-0c9b3f5c8a11"
```

