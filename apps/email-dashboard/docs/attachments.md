---
title: Attachments
description: Send files with a message and download the files that arrive.
---

## Sending attachments

`send` and `reply` accept an `attachments` array. Each entry has a `filename`, a `contentType`, and the file's bytes as base64 `content`.

```sh
curl "{{API_BASE}}/v1/inboxes/research%40{{DEFAULT_DOMAIN}}/messages/send" \
  -H "Authorization: Bearer $BEZALEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<'EOF'
{
  "to": ["vendor@example.net"],
  "subject": "Purchase order 0419",
  "text": "The signed purchase order is attached.",
  "attachments": [
    { "filename": "po-0419.pdf", "contentType": "application/pdf", "content": "JVBERi0xLjQK..." }
  ],
  "idempotencyKey": "6a1f7d2c-0b3e-4f7a-9c1d-2e8b5a4c3d10"
}
EOF
```

Limits per message: up to 10 files, 2 MiB combined after base64 decoding, filenames of 1 to 200 characters, and a `contentType` in `type/subtype` form. Bodies (`text` plus `html`) are limited separately to 512 KiB. See [Limits](/docs/limits).

In the TypeScript SDK:

```ts
import { readFile } from 'node:fs/promises'

await email.messages.send({
  inboxId, to: ['vendor@example.net'], subject: 'Purchase order 0419', text: 'The signed purchase order is attached.',
  attachments: [{ filename: 'po-0419.pdf', contentType: 'application/pdf', content: (await readFile('po-0419.pdf')).toString('base64') }],
  idempotencyKey: crypto.randomUUID(),
})
```

## Receiving attachments

Messages list their attachments with an id, name, type, and size:

```json
"attachments": [
  { "attachmentId": "4f40dbb7-c2aa-4288-af1e-2966ca55b6b7", "filename": "quote.pdf", "contentType": "application/pdf", "size": 48213 }
]
```

The bytes are not inlined. Ask for a download URL:

```sh
curl "{{API_BASE}}/v1/inboxes/research%40{{DEFAULT_DOMAIN}}/messages/%3Cid%40example.net%3E/attachments/4f40dbb7-c2aa-4288-af1e-2966ca55b6b7" \
  -H "Authorization: Bearer $BEZALEL_API_KEY"
```

```json
{
  "downloadUrl": "{{API_BASE}}/attachments/...?expires=1758400000&signature=...",
  "attachmentId": "4f40dbb7-c2aa-4288-af1e-2966ca55b6b7",
  "expiresAt": "2026-09-20T18:10:12.000Z",
  "filename": "quote.pdf",
  "contentType": "application/pdf",
  "size": 48213
}
```

The URL is signed and valid for five minutes. Fetch it without an `Authorization` header. Request a new URL if it expires; the attachment stays with the message.

Threads report `attachmentCount`, and `getThread` includes each message's attachment list, so an agent can find files across a conversation without reading every message.

## Scanning

Incoming attachments are scanned for malware along with the rest of the message. A message with a flagged attachment goes to [quarantine](/docs/quarantine), and it cannot be released while the antivirus result is anything other than clean. Attachment content is untrusted data even when it passes the scan: a PDF or spreadsheet can carry text that reads like instructions. See [Building agents on email](/docs/agents).
