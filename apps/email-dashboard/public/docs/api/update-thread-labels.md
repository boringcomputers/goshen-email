# Update thread labels

Add or remove thread labels. Quarantine cannot be changed by agents.

`PATCH /v1/inboxes/{inboxId}/threads/{threadId}/labels`

Requires scope `messages:write`. MCP tool `update_thread_labels`. SDK `email.threads.updateLabels()`. CLI `bezalel-email threads labels`.

## Request

### Path parameters

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `inboxId` | `string (email)` | Yes | up to 254 characters |
| `threadId` | `string (uuid)` | Yes |  |

### Body

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `addLabels` | `string[]` |  | up to 50 items, default [] |
| `removeLabels` | `string[]` |  | up to 50 items, default [] |

## Response

None.

Errors return `{ "error": { "code", "message", "transient" } }` with a 4xx or 5xx status.

## Examples

```sh
curl "https://bezalel-email-standalone.michaelwasihun96.workers.dev/v1/inboxes/research%40agents.goshenemail.com/threads/0b8d0e7f-3444-4bb7-a250-c2793dd5944d/labels" \
  -H "Authorization: Bearer $BEZALEL_API_KEY" \
  -X PATCH \
  -H "Content-Type: application/json" \
  -d '{
    "addLabels": [
      "reviewed"
    ],
    "removeLabels": [
      "unread"
    ]
  }'
```

### TypeScript

```ts
const result = await email.threads.updateLabels({
  inboxId: 'research@agents.goshenemail.com',
  threadId: '0b8d0e7f-3444-4bb7-a250-c2793dd5944d',
  addLabels: [
    'reviewed'
  ],
  removeLabels: [
    'unread'
  ]
})
```

### Python

```python
result = email.threads.update_labels(inbox_id="research@agents.goshenemail.com", thread_id="0b8d0e7f-3444-4bb7-a250-c2793dd5944d", add_labels=["reviewed"], remove_labels=["unread"])
```

### CLI

```sh
bezalel-email threads labels --json '{"inboxId":"research@agents.goshenemail.com","threadId":"0b8d0e7f-3444-4bb7-a250-c2793dd5944d","addLabels":["reviewed"],"removeLabels":["unread"]}'
```

