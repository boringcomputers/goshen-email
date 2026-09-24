# Delete an inbox

Permanently retire an inbox and delete its mail. The address cannot be reused.

`DELETE /v1/inboxes/{inboxId}`

Requires scope `inboxes:write`. MCP tool `delete_inbox`. CLI `goshenemail inboxes delete`.

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
curl "https://api.goshenemail.com/v1/inboxes/research%40agents.goshenemail.com" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY" \
  -X DELETE
```

### CLI

```sh
goshenemail inboxes delete --inbox-id "research@agents.goshenemail.com"
```

