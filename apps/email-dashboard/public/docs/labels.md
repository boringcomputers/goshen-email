# Labels

Labels mark state on messages and threads. Five are set by Goshen Email; the rest are yours.

## System labels

| Label | Set when |
| --- | --- |
| `received` | The message arrived from outside. |
| `sent` | The inbox sent the message. |
| `unread` | The message arrived and nobody has removed the label yet. |
| `trash` | The message or thread was moved to Trash. Trashed mail is hidden from lists unless you ask for it. |
| `quarantined` | The scanner held the message. Only a person can release it from the dashboard. See [Quarantine](/docs/quarantine). |

`quarantined` is the one label no API key can add or remove; the request fails with `quarantine_review_required`. `received` and `sent` are set by Goshen Email when mail arrives or leaves. The API does not stop you from removing them, but the dashboard's Inbox and Sent views depend on them, so leave them alone. `unread` and `trash` are meant to be changed.

## Your labels

Any other label is yours to define. Labels are 1 to 64 characters. A message can carry up to 50 labels when sent. Typical uses:

- **Workflow state.** `needs-human`, `awaiting-vendor`, `done`.
- **Campaign or task.** `q3-outreach`, `ticket-4821`.
- **Classification your agent made.** `invoice`, `newsletter`, `spam-suspect`.

Labels are free text, so decide on a vocabulary before your agents start inventing their own.

## Adding and removing labels

On a message:

```sh
curl "https://api.goshenemail.com/v1/inboxes/research%40agents.goshenemail.com/messages/%3Cid%40example.net%3E/labels" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY" -X PATCH \
  -H "Content-Type: application/json" \
  -d '{"addLabels":["invoice","needs-human"],"removeLabels":["unread"]}'
```

On a thread, `PATCH /v1/inboxes/{inboxId}/threads/{threadId}/labels` takes the same body and applies to every message in the thread.

Both operations need the `messages:write` scope. They return an empty 200 on success.

## Labels on outgoing mail

`send` and `reply` accept a `labels` array so a message is tagged from the moment it leaves. The `sent` label is added regardless.

## Filtering by label

`listMessages` and `listThreads` take `labels` as a repeated query parameter and return items that carry every label given:

```sh
curl "https://api.goshenemail.com/v1/inboxes/research%40agents.goshenemail.com/messages?labels=received&labels=invoice" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY"
```

## In the dashboard

The dashboard shows labels on each conversation and lets you add or remove them, move mail to Trash, and mark it read. Inbox, Sent, All mail, Quarantine, and Trash are views over these labels, not separate folders.
