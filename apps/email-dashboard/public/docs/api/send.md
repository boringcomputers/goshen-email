# Send a message

Send an email only when the user has authorized it. Retry with the SAME idempotencyKey and unchanged contents.

`POST /v1/inboxes/{inboxId}/messages/send`

Requires scope `messages:send`. MCP tool `send`. CLI `goshenemail messages send`.

## Request

### Path parameters

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `inboxId` | `string (email)` | Yes | up to 254 characters |

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
| `to` | `string (email)[]` | Yes | at least 1 item, up to 50 items |
| `cc` | `string (email)[]` |  | up to 50 items |
| `bcc` | `string (email)[]` |  | up to 50 items |
| `subject` | `string` |  | up to 998 characters, default "" |
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
curl "https://api.goshenemail.com/v1/inboxes/research%40agents.goshenemail.com/messages/send" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Hello, could you send the current quote?",
    "to": [
      "recipient@example.net"
    ],
    "subject": "Quote request",
    "idempotencyKey": "2f7c1c1e-6d1a-4a3b-9b0e-0c9b3f5c8a11"
  }'
```

### CLI

```sh
goshenemail messages send --json '{"inboxId":"research@agents.goshenemail.com","text":"Hello, could you send the current quote?","to":["recipient@example.net"],"subject":"Quote request","idempotencyKey":"2f7c1c1e-6d1a-4a3b-9b0e-0c9b3f5c8a11"}'
```

