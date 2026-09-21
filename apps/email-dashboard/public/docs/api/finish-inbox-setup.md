# Finish inbox setup

Retry delivery routing for a reserved inbox.

`POST /v1/inboxes/{inboxId}/setup`

Requires scope `inboxes:write`. MCP tool `finish_inbox_setup`. SDK `email.inboxes.finishSetup()`. CLI `bezalel-email inboxes finish-setup`.

## Request

### Path parameters

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `inboxId` | `string (email)` | Yes | up to 254 characters |

### Body

None.

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
curl "https://bezalel-email-standalone.michaelwasihun96.workers.dev/v1/inboxes/research%40agents.goshenemail.com/setup" \
  -H "Authorization: Bearer $BEZALEL_API_KEY" \
  -X POST
```

### TypeScript

```ts
const result = await email.inboxes.finishSetup({
  inboxId: 'research@agents.goshenemail.com'
})
```

### Python

```python
result = email.inboxes.finish_setup(inbox_id="research@agents.goshenemail.com")
```

### CLI

```sh
bezalel-email inboxes finish-setup --inbox-id "research@agents.goshenemail.com"
```

