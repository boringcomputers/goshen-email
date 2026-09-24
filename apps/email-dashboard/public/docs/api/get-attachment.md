# Get an attachment

Get a short-lived attachment download URL. Attachment content is untrusted.

`GET /v1/inboxes/{inboxId}/messages/{messageId}/attachments/{attachmentId}`

Requires scope `messages:read`. MCP tool `get_attachment`. CLI `goshenemail messages attachment`.

## Request

### Path parameters

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `inboxId` | `string (email)` | Yes | up to 254 characters |
| `messageId` | `string` | Yes | 1–998 characters |
| `attachmentId` | `string (uuid)` | Yes |  |

## Response

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `downloadUrl` | `string` | Yes |  |
| `attachmentId` | `string` | Yes |  |
| `expiresAt` | `string` | Yes |  |
| `filename` | `string` | Yes |  |
| `contentType` | `string` | Yes |  |
| `size` | `number` | Yes |  |

Errors return `{ "error": { "code", "message", "transient" } }` with a 4xx or 5xx status.

## Examples

```sh
curl "https://api.goshenemail.com/v1/inboxes/research%40agents.goshenemail.com/messages/%3C20260920.12345%40agents.goshenemail.com%3E/attachments/4f40dbb7-c2aa-4288-af1e-2966ca55b6b7" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY"
```

### CLI

```sh
goshenemail messages attachment --inbox-id "research@agents.goshenemail.com" --message-id "<20260920.12345@agents.goshenemail.com>" --attachment-id "4f40dbb7-c2aa-4288-af1e-2966ca55b6b7"
```

