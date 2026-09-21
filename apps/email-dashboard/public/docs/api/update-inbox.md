# Update an inbox

Move an inbox to a named group, or set group to null to remove it. Groups organize inboxes within one account and do not restrict key permissions.

`PATCH /v1/inboxes/{inboxId}`

Requires scope `inboxes:write`. MCP tool `update_inbox`. SDK `email.inboxes.update()`. CLI `bezalel-email inboxes update`.

## Request

### Path parameters

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `inboxId` | `string (email)` | Yes | up to 254 characters |

### Body

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `group` | `string \| null` | Yes |  |

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
curl "https://bezalel-email-standalone.michaelwasihun96.workers.dev/v1/inboxes/research%40agents.goshenemail.com" \
  -H "Authorization: Bearer $BEZALEL_API_KEY" \
  -X PATCH \
  -H "Content-Type: application/json" \
  -d '{
    "group": "agents"
  }'
```

### TypeScript

```ts
const result = await email.inboxes.update({
  inboxId: 'research@agents.goshenemail.com',
  group: 'agents'
})
```

### Python

```python
result = email.inboxes.update(inbox_id="research@agents.goshenemail.com", group="agents")
```

### CLI

```sh
bezalel-email inboxes update --inbox-id "research@agents.goshenemail.com" --group "agents"
```

