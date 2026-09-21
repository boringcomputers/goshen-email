# Update message labels

Add or remove message labels. Quarantine requires human review in the dashboard.

`PATCH /v1/inboxes/{inboxId}/messages/{messageId}/labels`

Requires scope `messages:write`. MCP tool `update_message_labels`. SDK `email.messages.updateLabels()`. CLI `bezalel-email messages labels`.

## Request

### Path parameters

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `inboxId` | `string (email)` | Yes | up to 254 characters |
| `messageId` | `string` | Yes | 1–998 characters |

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
curl "https://bezalel-email-standalone.michaelwasihun96.workers.dev/v1/inboxes/research%40agents.goshenemail.com/messages/%3C20260920.12345%40agents.goshenemail.com%3E/labels" \
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
const result = await email.messages.updateLabels({
  inboxId: 'research@agents.goshenemail.com',
  messageId: '<20260920.12345@agents.goshenemail.com>',
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
result = email.messages.update_labels(inbox_id="research@agents.goshenemail.com", message_id="<20260920.12345@agents.goshenemail.com>", add_labels=["reviewed"], remove_labels=["unread"])
```

### CLI

```sh
bezalel-email messages labels --json '{"inboxId":"research@agents.goshenemail.com","messageId":"<20260920.12345@agents.goshenemail.com>","addLabels":["reviewed"],"removeLabels":["unread"]}'
```

