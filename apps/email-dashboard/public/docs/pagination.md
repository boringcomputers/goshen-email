# Pagination

Lists return a page and a token for the next one. Pass the token back unchanged.

## How it works

`listInboxes`, `listMessages`, `searchMessages`, and `listThreads` return an array plus, when more items exist, a `nextPageToken`:

```json
{
  "messages": [ ... ],
  "nextPageToken": "eyJvZmZzZXQiOjIwfQ"
}
```

Send it back as `pageToken` to get the next page. Keep every other parameter the same between pages: the same `group`, `labels`, `query`, and triage filters. The token is opaque; do not build or edit one.

| Operation | Default page | Maximum |
| --- | --- | --- |
| `listInboxes` | 50 | 100 |
| `listMessages`, `searchMessages`, `listThreads` | 20 | 100 |

Lists reflect current data. Mail that arrives while you are paging can shift items between pages, so a full traversal is a snapshot, not a transaction.

## Reading every page

Loop until a page comes back without `nextPageToken`:

```ts
let pageToken
do {
  const url = new URL(`/v1/inboxes/${encodeURIComponent(inboxId)}/messages`, process.env.GOSHENEMAIL_BASE_URL)
  url.searchParams.append('labels', 'received')
  if (pageToken) url.searchParams.set('pageToken', pageToken)
  const page = await (await fetch(url, { headers: { authorization: `Bearer ${process.env.GOSHENEMAIL_API_KEY}` } })).json()
  for (const message of page.messages) console.log(message.subject)
  pageToken = page.nextPageToken
} while (pageToken)
```

## Array parameters

Query parameters that take several values repeat the name:

```text
GET /v1/inboxes/{inboxId}/messages?labels=received&labels=unread
```

## Mailbox keys

A mailbox key lists only its own inbox, so `listInboxes` returns one item and does not accept `pageToken` or `group`. Message and thread paging work as usual.
