---
title: Sending mail
description: Sends and replies are idempotent by design. Learn how to retry safely, what the limits are, and how to read delivery outcomes.
---

## The idempotency key

Every `send` and `reply` requires an `idempotencyKey`, a string of 1 to 200 characters that you generate. Goshen Email uses it to make sure one intended email is sent at most once:

- A new intended email gets a new key. A UUID is a good choice.
- If the request times out, the connection drops, or you get a 5xx, retry with the **same key and the same contents**. The server returns the original result, and `deduplicated: true` tells you it was a replay.
- Never mint a new key because a response was lost. That is how duplicate emails happen.
- A retry with the same key but different contents is refused with `idempotency_conflict` (409).

```ts
// Save the key before the first attempt so a crash and restart can still retry safely.
const idempotencyKey = crypto.randomUUID()
await saveDraftKey(taskId, idempotencyKey)
await email.messages.send({ inboxId, to, subject, text, idempotencyKey })
```

REST callers may pass the key in an `Idempotency-Key` header instead of the body. If both are present they must match.

The clients never retry on their own. A `network_error` from the SDK means the outcome is unknown; it is your signal to retry with the saved key, not proof that the send failed.

## Send

`POST /v1/inboxes/{inboxId}/messages/send`

| Field | Notes |
| --- | --- |
| `to` | Required. 1 to 50 addresses. |
| `cc`, `bcc` | Optional. The total across `to`, `cc`, and `bcc` is capped at 50. |
| `subject` | Up to 998 characters, no line breaks. Defaults to empty. |
| `text`, `html` | At least one is required. Together they must fit in 512 KiB. |
| `attachments` | Up to 10 files, 2 MiB combined. See [Attachments](/docs/attachments). |
| `labels` | Up to 50 labels to apply to the sent message. |
| `idempotencyKey` | Required. |

The response is `{ "messageId", "threadId", "deduplicated"? }`. The message appears in the inbox with the `sent` label right away; delivery happens asynchronously.

The sender name on outgoing mail is the inbox's `displayName`; the address is the inbox address.

## Reply

`POST /v1/inboxes/{inboxId}/messages/{messageId}/reply`

A reply keeps the thread. By default it goes to the original sender, or to the `Reply-To` address when the sender set one; replying to a message the inbox itself sent addresses that message's recipients. Set `replyAll: true` to also `cc` everyone else on the original message, or pass your own `to`, `cc`, and `bcc`. The inbox's own address is never added. Body, attachments, labels, and `idempotencyKey` work as in `send`.

You cannot reply to a quarantined message (`message_quarantined`, 403) until a person releases it.

## Limits

| Limit | Value |
| --- | --- |
| Recipients per message | 50 across `to`, `cc`, and `bcc` |
| Body size | 512 KiB, `text` and `html` combined |
| Attachments | 10 files, 2 MiB combined |
| Subject | 998 characters |
| Sends per inbox | 250 in any rolling 24-hour window by default |

Hitting the send limit returns `rate_limited` (429) with `transient: true`. Wait and retry with the same idempotency key; the send is not lost. See [Limits](/docs/limits).

## Delivery outcomes

Sending returns as soon as the message is accepted for delivery. The recipient's server answers later, and that answer is recorded on the message as `delivery` with one entry per recipient:

| Status | Meaning |
| --- | --- |
| `queued`, `accepted` | Handed to the outbound path; no remote answer yet |
| `delivered` | The recipient's server accepted the message (SMTP 250) |
| `deferred` | The remote server asked us to try again later |
| `bounced` | The remote server rejected it permanently; see `reason` and the SMTP codes |
| `failed`, `rejected` | Delivery could not be completed |
| `complained` | The recipient reported the message as spam |

`delivered` means the receiving server took the message, not that it reached the inbox or was read. The dashboard shows the same outcomes on each sent message.

## Pending sends

If a send is still being processed when you retry, the API answers `send_pending` (409). The first request is in flight; wait a moment and retry with the same key.

## Who decides a send happens

The operation descriptions, which the MCP server passes to every connected model, ask the agent to send only with the user's authorization. What "authorization" means is yours to define in code: a person approving each draft, a policy that lets the agent reply within threads it started, or full autonomy for an inbox that only ever confirms sign-ups. Scope the key to match. See [Building agents on email](/docs/agents).
