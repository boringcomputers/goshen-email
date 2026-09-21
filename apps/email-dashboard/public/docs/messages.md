# Messages

A message is one email, sent or received. Read, list, search, and label messages in an inbox.

## The message object

| Field | Meaning |
| --- | --- |
| `messageId` | The RFC 5322 Message-ID. Identifies the message in paths; URL encode it. |
| `threadId` | The thread this message belongs to. See [Threads](/docs/threads). |
| `inboxId` | The inbox address. |
| `from`, `to`, `cc`, `bcc`, `replyTo` | Addresses. `cc`, `bcc`, and `replyTo` appear when present. |
| `subject`, `preview` | The subject and a short plain-text preview. |
| `timestamp` | When the message was sent or received, ISO 8601. |
| `labels` | System and custom labels. See [Labels](/docs/labels). |
| `attachments` | `attachmentId`, `filename`, `contentType`, and `size` for each file. See [Attachments](/docs/attachments). |
| `text`, `html` | Bodies. `text` is included on reads; `html` is returned on `getMessage` when you ask for it. |
| `protection` | Scanner results for incoming mail: SPF, DKIM, DMARC, spam score, antivirus, and quarantine status. See [Quarantine](/docs/quarantine). |
| `triage` | Optional classification of incoming mail. See [Triage](/docs/triage). |
| `delivery` | For sent mail, per-recipient delivery outcomes. See below. |

## Listing messages

```sh
curl "https://bezalel-email-standalone.michaelwasihun96.workers.dev/v1/inboxes/research%40agents.goshenemail.com/messages?labels=received&labels=unread&limit=20" \
  -H "Authorization: Bearer $BEZALEL_API_KEY"
```

Lists are newest first. `labels` repeats for each label and matches messages that carry all of them. Pages hold up to 100 messages (default 20). When [triage](/docs/triage) is enabled, `category`, `needsReply`, and `urgency` filter on the classification.

Quarantined messages are left out of lists and searches unless `labels` includes `quarantined`. Trashed messages are listed only when `labels` includes `trash`.

## Searching messages

`GET /v1/inboxes/{inboxId}/messages/search?query=invoice` runs a full-text search over one inbox. `query` is 1 to 1000 characters and supports the usual web-search syntax: quoted phrases, `-` to exclude a word, `or` between alternatives. Results are ranked by relevance, then by time. The same page and triage filters apply.

## Reading a message

`GET /v1/inboxes/{inboxId}/messages/{messageId}` returns the full message. Plain text is always present when the sender included it. Message IDs contain `<`, `>`, and `@`, so encode them: `%3C20260920.1@example.net%3E`.

A mailbox key cannot read the body of a quarantined message. Account keys see the message with its `protection` block, and the dashboard is where a person decides whether to release it.

## Sent mail and delivery outcomes

Messages you send carry the `sent` label. Once the receiving server answers, the message gains a `delivery` block:

```json
{
  "delivery": {
    "sentAt": "2026-09-20T18:05:12.000Z",
    "updatedAt": "2026-09-20T18:05:14.000Z",
    "recipients": [
      { "recipient": "vendor@example.net", "status": "delivered", "delivered": true, "smtpStatusCode": "250", "deliveryTimeMs": 1830 }
    ]
  }
}
```

`status` per recipient is one of `queued`, `accepted`, `delivered`, `deferred`, `bounced`, `failed`, `rejected`, or `complained`, and reflects what the remote server reported. A `250` from the recipient's server means it accepted the message; it does not prove inbox placement or that anyone read it. Bounces carry the server's `reason` and SMTP status codes.

## Marking as read

Reading a message through the API does not remove `unread`. Remove it explicitly when your agent has handled the message:

```sh
curl "https://bezalel-email-standalone.michaelwasihun96.workers.dev/v1/inboxes/research%40agents.goshenemail.com/messages/%3Cid%40example.net%3E/labels" \
  -H "Authorization: Bearer $BEZALEL_API_KEY" -X PATCH \
  -H "Content-Type: application/json" \
  -d '{"removeLabels":["unread"],"addLabels":["handled"]}'
```

## Untrusted content

Everything inside a message was written by someone else: the subject, the sender's display name, the body, and every attachment. Passing a message body to a model without framing it as data is how prompt injection happens. See [Building agents on email](/docs/agents).
