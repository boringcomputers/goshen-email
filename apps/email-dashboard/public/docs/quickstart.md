# Quickstart

Create an API key, create an inbox, send a message, and read the reply, in about five minutes.

## 1. Create an account and an API key

1. Sign in at [goshenemail.com/app](https://goshenemail.com/app). Sign-in is passwordless: enter your email and use the magic link or the six-digit code.
2. Open **API keys** in the sidebar and choose **New key**.
3. Give the key a name, pick its scopes (for this walkthrough, all five), and choose an expiration. Keys default to 30 days.
4. Copy the key. It is shown once. Goshen Email stores only its SHA-256 hash.

Account keys start with `bze_`. Put the key in your environment; never paste it into prompts, code, or browser storage.

```sh
export GOSHENEMAIL_API_KEY="bze_..."
export GOSHENEMAIL_BASE_URL="https://api.goshenemail.com"
```

## 2. Create an inbox

```sh
curl "$GOSHENEMAIL_BASE_URL/v1/inboxes" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"username":"research","displayName":"Research agent","group":"agents"}'
```

```json
{
  "inboxId": "research@agents.goshenemail.com",
  "address": "research@agents.goshenemail.com",
  "displayName": "Research agent",
  "group": "agents",
  "createdAt": "2026-09-20T18:04:11.000Z",
  "deliveryStatus": "ready"
}
```

`inboxId` is the inbox's canonical email address. Use the returned value in every later call. If the response is lost, call the same request again with the same `username`; a retry returns the same inbox instead of creating a second one.

If `deliveryStatus` is `pending`, delivery routing did not finish. The address stays reserved; call [Finish inbox setup](/docs/api/finish-inbox-setup) to retry.

## 3. Send a message

Every send needs an `idempotencyKey` that you generate and keep. Retrying with the same key and the same contents never sends twice.

```sh
curl "$GOSHENEMAIL_BASE_URL/v1/inboxes/research%40agents.goshenemail.com/messages/send" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": ["vendor@example.net"],
    "subject": "Quote request",
    "text": "Hello, could you send the current quote for 200 units?",
    "idempotencyKey": "2f7c1c1e-6d1a-4a3b-9b0e-0c9b3f5c8a11"
  }'
```

```json
{ "messageId": "<20260920180512.7f3a@agents.goshenemail.com>", "threadId": "0b8d0e7f-3444-4bb7-a250-c2793dd5944d" }
```

Path segments are URL encoded, so `@` becomes `%40`. The CLI does this for you.

## 4. Read the reply

When the vendor answers, the reply lands in the same inbox with the `received` and `unread` labels and joins the same thread.

```sh
curl "$GOSHENEMAIL_BASE_URL/v1/inboxes/research%40agents.goshenemail.com/messages?labels=received&labels=unread" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY"
```

To read the whole conversation in order:

```sh
curl "$GOSHENEMAIL_BASE_URL/v1/inboxes/research%40agents.goshenemail.com/threads/0b8d0e7f-3444-4bb7-a250-c2793dd5944d?includeBodies=true" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY"
```

## 5. Reply in the thread

```sh
curl "$GOSHENEMAIL_BASE_URL/v1/inboxes/research%40agents.goshenemail.com/messages/<message-id>/reply" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"Thanks. Does the quote include shipping?","idempotencyKey":"9d5a0f0e-1b7c-4c1e-8f3a-6c2d1e0b9a77"}'
```

`reply` addresses the original sender and keeps the thread. Set `replyAll: true` to include everyone on the original message, or pass `to`, `cc`, and `bcc` to choose recipients yourself.

## Next

- [MCP server](/docs/mcp) gives an agent the inbox as tools instead of HTTP calls.
- [Sending mail](/docs/sending) explains idempotency, retries, attachments, and limits.
- [Labels](/docs/labels) covers the system labels (`received`, `sent`, `unread`, `trash`, `quarantined`) and your own.
- [Quarantine](/docs/quarantine) explains why some incoming mail waits for a person.
