# Get an inbox

Get an inbox by its canonical email address.

`GET /v1/inboxes/{inboxId}`

Requires scope `inboxes:read`. MCP tool `get_inbox`. SDK `email.inboxes.get()`. CLI `bezalel-email inboxes get`.

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
| `group` | `string | null` |  |  |
| `deliveryStatus` | `"pending" | "ready"` |  |  |
| `setupAvailable` | `boolean` |  |  |

Errors return `{ "error": { "code", "message", "transient" } }` with a 4xx or 5xx status.

## Examples

```sh
curl "https://bezalel-email-standalone.michaelwasihun96.workers.dev/v1/inboxes/research%40agents.goshenemail.com" \
  -H "Authorization: Bearer $BEZALEL_API_KEY"
```

### TypeScript

```ts
const result = await email.inboxes.get({
  inboxId: 'research@agents.goshenemail.com'
})
```

### Python

```python
result = email.inboxes.get(inbox_id="research@agents.goshenemail.com")
```

### CLI

```sh
bezalel-email inboxes get --inbox-id "research@agents.goshenemail.com"
```

