# Create an inbox

Create an inbox, optionally in a named group. Reuse the same username to retry setup. Retries preserve the existing group; use updateInbox to move it.

`POST /v1/inboxes`

Requires scope `inboxes:write`. MCP tool `create_inbox`. SDK `email.inboxes.create()`. CLI `bezalel-email inboxes create`.

## Request

### Body

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `username` | `string` | Yes | up to 64 characters |
| `domain` | `string` |  | up to 253 characters |
| `displayName` | `string` |  | up to 200 characters |
| `group` | `string` |  | 1–64 characters |

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
curl "https://bezalel-email-standalone.michaelwasihun96.workers.dev/v1/inboxes" \
  -H "Authorization: Bearer $BEZALEL_API_KEY" \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "username": "research",
    "displayName": "Research agent",
    "group": "agents"
  }'
```

### TypeScript

```ts
const result = await email.inboxes.create({
  username: 'research',
  displayName: 'Research agent',
  group: 'agents'
})
```

### Python

```python
result = email.inboxes.create(username="research", display_name="Research agent", group="agents")
```

### CLI

```sh
bezalel-email inboxes create --username "research" --display-name "Research agent" --group "agents"
```

