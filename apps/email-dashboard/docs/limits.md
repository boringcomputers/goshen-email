---
title: Limits
description: Sizes, counts, and rates the API enforces.
---

## Messages

| Limit | Value |
| --- | --- |
| Recipients per message | 50 across `to`, `cc`, and `bcc` |
| Body size | 512 KiB, `text` and `html` combined |
| Attachments per message | 10 |
| Attachment size | 2 MiB combined, after base64 decoding |
| Subject length | 998 characters, no line breaks |
| Labels per sent message | 50 |
| Label length | 1 to 64 characters |
| Idempotency key length | 1 to 200 characters |
| Search query length | 1 to 1000 characters |

## Sending rate

Each inbox may send 250 messages in any rolling 24-hour window by default. The 251st returns `rate_limited` (429) with `transient: true`. The send is not lost; retry later with the same `idempotencyKey`. Operators can set a different limit per inbox, between 1 and 10,000.

## Inboxes and accounts

| Limit | Value |
| --- | --- |
| Inboxes per account | No default cap; an operator can set a quota |
| Username | 1 to 64 characters: letters, digits, `.`, `_`, `-`, starting with a letter or digit |
| Display name | 200 characters |
| Group name | 1 to 64 characters: lowercase letters, digits, `_`, `-`, starting with a letter or digit |
| Active API keys per account | 20 |
| API key lifetime | 1 to 365 days, default 30 |

## Reading

| Limit | Value |
| --- | --- |
| Page size, inboxes | 50 default, 100 maximum |
| Page size, messages, search, threads | 20 default, 100 maximum |
| Messages per thread on `getThread` | 500; read larger threads through `listMessages` |
| Attachment download URL lifetime | 5 minutes |
| Text in `email.received` webhook payloads | 64 KiB, then `bodyTruncated: true` |
| Text sent to triage | 32,768 characters, then `bodyTruncated: true` |

## Sign-in

Three magic-link or code requests per ten minutes per email address, and ten verification attempts per minute. Links and codes expire after ten minutes.

## Requests

There is no general request-rate limit on the API beyond the send limit. Be a good neighbor: poll every 30 to 60 seconds rather than continuously, and use `listThreads` with label filters rather than reading every message.
