# Delete an inbox

Permanently retire an inbox and delete its mail. The address cannot be reused.

`DELETE /v1/inboxes/{inboxId}`

Requires scope `inboxes:write`. MCP tool `delete_inbox`. SDK `email.inboxes.delete()`. CLI `bezalel-email inboxes delete`.

## Request

### Path parameters

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `inboxId` | `string (email)` | Yes | up to 254 characters |

## Response

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `deleted` | `boolean` | Yes |  |

Errors return `{ "error": { "code", "message", "transient" } }` with a 4xx or 5xx status.

## Examples

```sh
curl "https://bezalel-email-standalone.michaelwasihun96.workers.dev/v1/inboxes/research%40agents.goshenemail.com" \
  -H "Authorization: Bearer $BEZALEL_API_KEY" \
  -X DELETE
```

### TypeScript

```ts
const result = await email.inboxes.delete({
  inboxId: 'research@agents.goshenemail.com'
})
```

### Python

```python
result = email.inboxes.delete(inbox_id="research@agents.goshenemail.com")
```

### CLI

```sh
bezalel-email inboxes delete --inbox-id "research@agents.goshenemail.com"
```

