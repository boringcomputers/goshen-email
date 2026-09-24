# List inboxes

List a page of account inboxes, optionally filtered by group. Pass nextPageToken as pageToken. Mailbox keys list only their assigned inbox and cannot filter groups or use page tokens.

`GET /v1/inboxes`

Requires scope `inboxes:read`. MCP tool `list_inboxes`. CLI `goshenemail inboxes list`.

## Request

### Query parameters

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `limit` | `integer` |  | 1–100, default 50 |
| `pageToken` | `string` |  | 1–1024 characters |
| `group` | `string` |  | 1–64 characters |

## Response

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `inboxes` | `object[]` | Yes |  |
|   `inboxId` | `string` | Yes |  |
|   `address` | `string` | Yes |  |
|   `displayName` | `string` |  |  |
|   `createdAt` | `string` | Yes |  |
|   `group` | `string \| null` |  |  |
|   `deliveryStatus` | `"pending" \| "ready"` |  |  |
|   `setupAvailable` | `boolean` |  |  |
| `nextPageToken` | `string` |  |  |

Errors return `{ "error": { "code", "message", "transient" } }` with a 4xx or 5xx status.

## Examples

```sh
curl "https://api.goshenemail.com/v1/inboxes" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY"
```

### CLI

```sh
goshenemail inboxes list
```

