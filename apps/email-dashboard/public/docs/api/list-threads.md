# List threads

List threads filtered by labels or triage of the latest message. A sent reply clears the thread triage until a new incoming message arrives.

`GET /v1/inboxes/{inboxId}/threads`

Requires scope `messages:read`. MCP tool `list_threads`. CLI `goshenemail threads list`.

## Request

### Path parameters

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `inboxId` | `string (email)` | Yes | up to 254 characters |

### Query parameters

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `category` | `"billing" \| "support" \| "sales" \| "personal" \| "notification" \| "other"` |  |  |
| `needsReply` | `"yes" \| "no" \| "uncertain"` |  |  |
| `urgency` | `"low" \| "normal" \| "high" \| "critical"` |  |  |
| `limit` | `integer` |  | 1–100, default 20 |
| `pageToken` | `string` |  | up to 200 characters |
| `labels` | `string[]` |  | up to 50 items |
| `includeTrash` | `boolean` |  | default false |

## Response

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `threads` | `object[]` | Yes |  |
|   `threadId` | `string` | Yes |  |
|   `inboxId` | `string` | Yes |  |
|   `subject` | `string` | Yes |  |
|   `preview` | `string` | Yes |  |
|   `timestamp` | `string` |  |  |
|   `triage` | `object \| object \| object` |  |  |
|     `status` | `string` |  |  |
|     `code` | `"provider_unavailable" \| "provider_rejected" \| "invalid_response"` |  |  |
|     `failedAt` | `string (ISO 8601)` |  |  |
|     `version` | `number` |  |  |
|     `model` | `string` |  | 1–100 characters |
|     `analyzedAt` | `string (ISO 8601)` |  |  |
|     `durationMs` | `integer` |  | at least 0 |
|     `bodyTruncated` | `boolean` |  |  |
|     `usage` | `object` |  |  |
|     `category` | `object` |  |  |
|     `needsReply` | `object` |  |  |
|     `urgency` | `object` |  |  |
|   `messageCount` | `number` | Yes |  |
|   `labels` | `string[]` | Yes |  |
|   `senders` | `string[]` | Yes |  |
|   `recipients` | `string[]` | Yes |  |
|   `receivedTimestamp` | `string` |  |  |
|   `sentTimestamp` | `string` |  |  |
|   `lastMessageId` | `string` |  |  |
|   `attachmentCount` | `number` |  |  |
| `nextPageToken` | `string` |  |  |

Errors return `{ "error": { "code", "message", "transient" } }` with a 4xx or 5xx status.

## Examples

```sh
curl "https://api.goshenemail.com/v1/inboxes/research%40agents.goshenemail.com/threads" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY"
```

### CLI

```sh
goshenemail threads list --inbox-id "research@agents.goshenemail.com"
```

