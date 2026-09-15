# Email API

The Worker accepts JSON POST requests with `Authorization: Bearer <token>`.
Successful operations return `{ "result": ... }`. Errors return
`{ "error": { "message", "code", "transient" } }` and a non-2xx status.

## Credentials

| Credential | Access |
| --- | --- |
| `MAIL_API_TOKEN` | All mailboxes and platform provisioning. Server-side only. |
| Mailbox `apiKey`, prefixed `gme_` | Its assigned mailbox and client domain only. |
| `MAIL_GATEWAY_TOKEN` | SMTP submission, recipient lookup, scans, and delivery reports. |
| `DASHBOARD_PASSWORD` | Owner dashboard only. Does not authenticate Worker requests. |

## Provision a mailbox

The platform calls `POST /clients/provision` with its `MAIL_API_TOKEN`:

```json
{
  "clientId": "assistant-123",
  "username": "assistant-123",
  "displayName": "Research assistant",
  "webhookUrl": "https://agent.example.com/email/inbound",
  "dailySendLimit": 250
}
```

The result contains `inboxId`, `apiKey`, `webhookSecret`, `webhookUrl`, `clientId`,
and `dailySendLimit`. Store the mailbox key and signing secret with that application.
Repeated provisioning with the same identity returns the same mailbox.
Only the platform can change webhook destinations or rotate mailbox credentials.

`POST /clients/rotate` takes `{ "clientId": "assistant-123" }` and returns
replacement credentials. `POST /clients/delete` takes the same input, deletes
the mailbox, and revokes access. A deleted address cannot be reused.

## Read and send

Mailbox clients call `/inbox-rpc/<operation>`. `inboxId` is optional; if supplied,
it must match the credential. Common operations:

| Operation | Input |
| --- | --- |
| `getInbox` | `{}` |
| `listMessages`, `listThreads` | `limit`, optional `pageToken` and `labels` |
| `getMessage` | `messageId`, optional `includeHtml` |
| `getThread` | `threadId`, optional `includeBodies` |
| `searchMessages` | `query`, optional `limit` and `pageToken` |
| `getAttachment` | `messageId`, `attachmentId` |
| `send` | `to`, `subject`, `text` or `html`, `idempotencyKey` |
| `reply` | `messageId`, `text` or `html`, `idempotencyKey`, optional `replyAll` |
| `updateThreadLabels` | `threadId`, `addLabels`, `removeLabels` |
| `updateMessageLabels` | `messageId`, `addLabels`, `removeLabels` |
| `getCustomDomain` | `{}` |
| `connectCustomDomain` | `domain`, `username` |
| `disconnectCustomDomain` | `{}` |

Sends and replies accept optional attachments with `filename`, `contentType`,
and base64 `content`, up to ten files and 2 MiB combined. Use a new random
`idempotencyKey` for each intended message. Retry an uncertain request with the
same key and identical contents. Never make a new key just because a receipt
was lost. The mailbox service refuses unresolved duplicate sends.

Pagination returns `nextPageToken`. Treat it as opaque. Received messages have
the `received` label, sent messages have `sent`, and unread messages have `unread`.
Trash and quarantine use `trash` and `quarantined`. Mailbox tokens cannot remove
quarantine holds or read held bodies. The owner dashboard reviews and releases
messages only when the attachment scan is clean.

## Platform operations

`POST /rpc/<operation>` requires `MAIL_API_TOKEN`. It supports the shared email
operations and explicit `inboxId`, plus `createInbox`, `listInboxes`, `deleteInbox`,
`createDomain`, `listDomains`, `verifyDomain`, `deleteDomain`, `reviewThread`,
and `releaseQuarantine`. Domain operations accept `domain` when creating and
`domainId` when verifying or deleting. The dashboard calls an allowlisted subset
through its authenticated server.

Schemas and response types live in
[`contracts.ts`](../apps/email/src/contracts.ts). The platform credential has
deployment-wide access. Put your own tenant authorization before those calls
if you build a multi-tenant product. Bezalel's policies are not included here.

## Webhooks

Incoming and delivery events use `svix-id`, `svix-timestamp`, and `svix-signature`.
Verify the HMAC-SHA256 over `<id>.<timestamp>.<raw body>` using the base64-decoded
part after `whsec_`. Compare signatures in constant time, reject stale timestamps,
and deduplicate event IDs. Respond with 2xx only after durably accepting the event.
The outbox retries failures and does not follow redirects.

See [security.ts](../apps/email/src/security.ts) for the signing format and
[the Worker guide](../apps/email/README.md#product-mailbox-access) for rotation
and per-mailbox limits. Email content is untrusted input, including messages
that pass sender authentication.
