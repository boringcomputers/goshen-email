# Search messages

Search messages in one inbox, optionally filtered by category, needsReply, and urgency.

`GET /v1/inboxes/{inboxId}/messages/search`

Requires scope `messages:read`. MCP tool `search_messages`. SDK `email.messages.search()`. CLI `bezalel-email messages search`.

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
| `query` | `string` | Yes | 1–1000 characters |

## Response

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `messages` | `object[]` | Yes |  |
|   `messageId` | `string` | Yes |  |
|   `threadId` | `string` | Yes |  |
|   `inboxId` | `string` | Yes |  |
|   `from` | `string` | Yes |  |
|   `to` | `string[]` | Yes |  |
|   `subject` | `string` | Yes |  |
|   `preview` | `string` | Yes |  |
|   `timestamp` | `string` | Yes |  |
|   `labels` | `string[]` | Yes |  |
|   `attachments` | `object[]` | Yes |  |
|     `attachmentId` | `string` | Yes |  |
|     `filename` | `string` | Yes |  |
|     `contentType` | `string` | Yes |  |
|     `size` | `number` | Yes |  |
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
|   `protection` | `object` |  |  |
|     `status` | `"clean" \| "quarantined" \| "released"` | Yes |  |
|     `scannedAt` | `string (ISO 8601)` | Yes |  |
|     `authentication` | `object` | Yes |  |
|     `spam` | `object` | Yes |  |
|     `antivirus` | `object` | Yes |  |
|     `reasons` | `"malware" \| "spam" \| "authentication_failed" \| "scan_incomplete"[]` | Yes | up to 4 items |
|     `releasedAt` | `string (ISO 8601)` |  |  |
|     `releasedBy` | `string` |  | 1–200 characters |
|   `text` | `string` |  |  |
|   `html` | `string` |  |  |
|   `cc` | `string[]` |  |  |
|   `bcc` | `string[]` |  |  |
|   `replyTo` | `string[]` |  |  |
|   `delivery` | `object` |  |  |
|     `version` | `number` | Yes |  |
|     `sentAt` | `string` | Yes |  |
|     `updatedAt` | `string` | Yes |  |
|     `recipients` | `object[]` | Yes |  |
| `nextPageToken` | `string` |  |  |

Errors return `{ "error": { "code", "message", "transient" } }` with a 4xx or 5xx status.

## Examples

```sh
curl "https://bezalel-email-standalone.michaelwasihun96.workers.dev/v1/inboxes/research%40agents.goshenemail.com/messages/search?query=invoice" \
  -H "Authorization: Bearer $BEZALEL_API_KEY"
```

### TypeScript

```ts
const result = await email.messages.search({
  inboxId: 'research@agents.goshenemail.com',
  query: 'invoice'
})
```

### Python

```python
result = email.messages.search(inbox_id="research@agents.goshenemail.com", query="invoice")
```

### CLI

```sh
bezalel-email messages search --inbox-id "research@agents.goshenemail.com" --query "invoice"
```

