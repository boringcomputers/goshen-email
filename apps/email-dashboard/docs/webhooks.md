---
title: Webhooks and polling
description: How to learn that mail arrived. Polling works for every key today; signed webhooks exist for platform-provisioned inboxes.
---

## Where things stand

Self-service webhook subscriptions for account API keys are not available yet. Today there are two ways to react to incoming mail:

1. **Poll.** Works with every key and every client, including MCP. This is the path most agents should start with.
2. **Platform-provisioned webhooks.** Inboxes created by a platform integration through `POST /clients/provision` get a webhook URL and signing secret at provisioning time. If you are integrating Goshen Email into your own product on that path, the event and signature details below apply.

Webhook management through the account API is the next planned increment, along with WebSockets. This page will change when it lands.

## Polling well

List with the labels that describe "new to me" and clear them as you go:

```ts
const { messages } = await email.messages.list({ inboxId, labels: ['received', 'unread'], limit: 50 })
for (const message of messages) {
  await handle(message)
  await email.messages.updateLabels({ inboxId, messageId: message.messageId, removeLabels: ['unread'], addLabels: ['handled'] })
}
```

- Poll `listThreads` with `labels=unread` when your agent thinks in conversations rather than messages.
- With [triage](/docs/triage) enabled, `needsReply=yes` narrows the list to mail that wants an answer.
- A reasonable interval for an agent is 30 to 60 seconds. Quarantined mail never shows up in these lists, which is the point.
- Idempotent handling matters: mark a message handled in the same step you act on it, so a crash between the two does not repeat the action.

## Events

For inboxes that have a webhook, Goshen Email posts JSON events:

| Type | When | Payload |
| --- | --- | --- |
| `email.received` | A message arrived and was not quarantined | `inboxId`, `occurredAt`, and `message` with the message summary, `text` up to 64 KiB (`bodyTruncated` marks a cut), attachments, labels, and `triage` when enabled |
| `email.delivery_updated` | A recipient's server answered for a sent message | `inboxId`, `occurredAt`, `message` (`messageId`, `threadId`, `inboxId`), and the `delivery` block |
| `email.bounced` | A sent message bounced | Bounce details for the affected recipient |

Quarantined messages do not produce `email.received`. If a person releases one, the message appears in lists but no delayed event is sent. `email.received` can carry `triage.status: "pending"`; read the message again for the completed result.

## Verifying signatures

Each delivery carries `svix-id`, `svix-timestamp`, and `svix-signature` headers, following the Standard Webhooks format. To verify:

1. Take the signing secret you were given, strip the `whsec_` prefix, and base64-decode the rest.
2. Compute HMAC-SHA256 over `<svix-id>.<svix-timestamp>.<raw request body>`.
3. Base64-encode the result and compare it, in constant time, against the value after `v1,` in `svix-signature`. The header may list several signatures separated by spaces; any match is valid.
4. Reject timestamps more than a few minutes old, and deduplicate on `svix-id`.

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

export function verify(headers: Headers, rawBody: string, secret: string) {
  const id = headers.get('svix-id')!, timestamp = headers.get('svix-timestamp')!
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64')
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest()
  return (headers.get('svix-signature') ?? '').split(' ').some((part) => {
    const [, value] = part.split(',')
    const given = Buffer.from(value ?? '', 'base64')
    return given.length === expected.length && timingSafeEqual(given, expected)
  })
}
```

Respond with a 2xx only after you have durably accepted the event. Goshen Email retries failures and does not follow redirects.

## Treat payloads as untrusted

Everything under `message` came from an outside sender. Verify the signature to know the event came from Goshen Email; that says nothing about the honesty of the email inside it. See [Building agents on email](/docs/agents).
