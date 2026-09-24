# Get an inbox

Get an inbox by its canonical email address.

`GET /v1/inboxes/{inboxId}`

Requires scope `inboxes:read`. MCP tool `get_inbox`. CLI `goshenemail inboxes get`.

## Request

### Path parameters

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `inboxId` | `string (email)` | Yes | up to 254 characters |

## Response

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `inboxId` | `string` | Yes |  |
| `address` | `string` | Yes |  |
| `displayName` | `string` |  |  |
| `createdAt` | `string` | Yes |  |
| `group` | `string \| null` |  |  |
| `deliveryStatus` | `"pending" \| "ready"` |  |  |
| `setupAvailable` | `boolean` |  |  |

Errors return `{ "error": { "code", "message", "transient" } }` with a 4xx or 5xx status.

## Examples

```sh
curl "https://api.goshenemail.com/v1/inboxes/research%40agents.goshenemail.com" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY"
```

### CLI

```sh
goshenemail inboxes get --inbox-id "research@agents.goshenemail.com"
```

