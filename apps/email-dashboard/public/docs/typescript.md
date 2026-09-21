# TypeScript and JavaScript SDK

A typed client for Node.js 24 and other modern runtimes. One method per API operation, plus page iteration.

## Availability

The package is `@bezalel/email-sdk`. It is built from the Goshen Email repository and is not yet published to npm. Build it from a checkout (`pnpm install --frozen-lockfile && pnpm build`), then either use it as a workspace package or pack a tarball with `pnpm --filter @bezalel/email-sdk pack --pack-destination /tmp` and install that in your project. The [REST API](/docs/api) works from any HTTP client in the meantime.

The client has no runtime dependencies and uses the platform `fetch`.

## Create a client

```ts
import { BezalelEmail } from '@bezalel/email-sdk'

const email = new BezalelEmail({
  apiKey: process.env.BEZALEL_API_KEY!,
  baseUrl: process.env.BEZALEL_BASE_URL, // defaults to the hosted API
  timeoutMs: 30_000,                      // default
})
```

| Option | Meaning |
| --- | --- |
| `apiKey` | An account key (`bze_`) or mailbox key (`gme_`). Required. |
| `baseUrl` | API origin. Defaults to `https://bezalel-email-standalone.michaelwasihun96.workers.dev`. |
| `timeoutMs` | Per-request timeout. Default 30 seconds. |
| `fetch` | A custom `fetch` for testing or proxies. |

## Methods

Each method takes one object with the path, query, and body fields of its operation, and returns the parsed JSON response, fully typed from the OpenAPI document.

| Method | Operation |
| --- | --- |
| `email.inboxes.list(input?)` | [List inboxes](/docs/api/list-inboxes) |
| `email.inboxes.create(input)` | [Create an inbox](/docs/api/create-inbox) |
| `email.inboxes.get(input)` | [Get an inbox](/docs/api/get-inbox) |
| `email.inboxes.update(input)` | [Update an inbox](/docs/api/update-inbox) |
| `email.inboxes.delete(input)` | [Delete an inbox](/docs/api/delete-inbox) |
| `email.inboxes.finishSetup(input)` | [Finish inbox setup](/docs/api/finish-inbox-setup) |
| `email.messages.list(input)` | [List messages](/docs/api/list-messages) |
| `email.messages.search(input)` | [Search messages](/docs/api/search-messages) |
| `email.messages.get(input)` | [Get a message](/docs/api/get-message) |
| `email.messages.send(input)` | [Send a message](/docs/api/send) |
| `email.messages.reply(input)` | [Reply to a message](/docs/api/reply) |
| `email.messages.updateLabels(input)` | [Update message labels](/docs/api/update-message-labels) |
| `email.messages.getAttachment(input)` | [Get an attachment](/docs/api/get-attachment) |
| `email.threads.list(input)` | [List threads](/docs/api/list-threads) |
| `email.threads.get(input)` | [Get a thread](/docs/api/get-thread) |
| `email.threads.updateLabels(input)` | [Update thread labels](/docs/api/update-thread-labels) |

`email.request(operation, input, { signal })` calls any operation by its id and accepts an `AbortSignal`.

## Example

```ts
const inbox = await email.inboxes.create({ username: 'research', group: 'agents' })

const idempotencyKey = crypto.randomUUID() // save it before sending
await email.messages.send({
  inboxId: inbox.inboxId, to: ['vendor@example.net'], subject: 'Quote request',
  text: 'Could you send the current quote for 200 units?', idempotencyKey,
})

const thread = await email.threads.get({ inboxId: inbox.inboxId, threadId: '...', includeBodies: true })
for (const message of thread.messages) console.log(message.from, message.text)
```

## Paging

```ts
for await (const page of email.pages('listThreads', { inboxId: inbox.inboxId, labels: ['unread'] })) {
  for (const thread of page.threads) console.log(thread.subject)
}
```

`pages` accepts `listInboxes`, `listMessages`, `searchMessages`, and `listThreads`, follows `nextPageToken` until it runs out, and stops if the API repeats a token.

## Errors

Failures throw `BezalelError` with `status`, `code`, and `transient`:

```ts
import { BezalelError } from '@bezalel/email-sdk'

try {
  await email.messages.send({ ... })
} catch (error) {
  if (error instanceof BezalelError) {
    if (error.code === 'network_error') retryLaterWithSameKey()          // outcome unknown
    else if (error.transient) retryLaterWithSameKey()                    // 429, 502, 503
    else if (error.code === 'request_cancelled') { /* your signal fired */ }
    else report(error.code, error.message)                               // fix the request
  }
}
```

- `network_error` means the request may or may not have reached the server. For a send, retry with the same `idempotencyKey`.
- `request_cancelled` is raised when your `AbortSignal` fires. It does not undo a send the server already accepted.
- The client never retries on its own.

## Types

```ts
import type { Operation, Input, Result } from '@bezalel/email-sdk'

type SendInput = Input<'send'>
type Thread = Result<'getThread'>
```

The types are generated from the same OpenAPI document as the API, so a contract change is a type error before it is a runtime error.
