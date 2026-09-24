---
title: Threads
description: A thread groups the messages of one conversation. Replies your agent sends and replies it receives stay together.
---

## The thread object

| Field | Meaning |
| --- | --- |
| `threadId` | A UUID that identifies the thread in paths. |
| `inboxId` | The inbox address. |
| `subject`, `preview` | From the most recent message. |
| `messageCount`, `attachmentCount` | Totals across the thread. |
| `senders`, `recipients` | Every address that took part. |
| `labels` | The union of the labels on the thread's messages plus thread-level labels. |
| `timestamp`, `receivedTimestamp`, `sentTimestamp` | Most recent activity, most recent received message, most recent sent message. |
| `lastMessageId` | The most recent message. |
| `triage` | Classification of the latest incoming message, when [triage](/docs/triage) is enabled. |
| `messages` | On `getThread`, the messages in chronological order. |

## How messages join a thread

Threading follows standard email headers. When your agent sends a message, a new thread starts and the response includes its `threadId`. When someone replies, their mail client sets `In-Reply-To` and `References` to your message, and the reply lands in the same thread. Replies your agent sends through [Reply to a message](/docs/api/reply) do the same in the other direction.

Mail that arrives without those headers starts a new thread, even if the subject matches.

## Listing threads

```sh
curl "{{API_BASE}}/v1/inboxes/research%40{{DEFAULT_DOMAIN}}/threads?labels=unread" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY"
```

Threads are ordered by most recent activity. `labels` filters on the thread's labels. Threads whose messages are all in Trash are hidden unless `includeTrash=true`. The triage filters `category`, `needsReply`, and `urgency` apply to the latest incoming message; a reply the agent sends clears the thread's triage until the next message arrives.

## Reading a thread

`GET /v1/inboxes/{inboxId}/threads/{threadId}` returns the thread with its messages oldest first. Add `includeBodies=true` to include `text` for each message; without it, each message carries its `preview` only. Threads are capped at 500 messages; past that, read the messages through `listMessages` instead.

## Labels on threads

`PATCH /v1/inboxes/{inboxId}/threads/{threadId}/labels` adds or removes labels on the whole thread. Removing `unread` from a thread marks every message in it read. The `quarantined` label cannot be added or removed by any API key. See [Labels](/docs/labels).

## Working a conversation from an agent

1. List threads with `labels=unread` to find conversations that need attention.
2. Read the thread with `includeBodies=true` so the model sees the whole exchange, oldest first.
3. Reply with `reply` on the last message, keeping the `idempotencyKey` for that reply until the response arrives.
4. Remove `unread` from the thread and add your own label, such as `awaiting-vendor`, to track state.

Every message body in the thread is untrusted content. See [Building agents on email](/docs/agents).
