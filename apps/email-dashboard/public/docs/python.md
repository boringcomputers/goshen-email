# Python SDK

A synchronous client for Python 3.10 and later, built on the standard library. One method per API operation.

## Availability

The package is `bezalel_email`. It is built from the Goshen Email repository and is not yet published to PyPI. From a checkout, `python3 -m pip install ./packages/email-python` installs it. It has no third-party dependencies. The [REST API](/docs/api) works from `requests`, `httpx`, or `urllib` in the meantime.

## Create a client

```python
import os
from bezalel_email import BezalelEmail

email = BezalelEmail(
    api_key=os.environ['BEZALEL_API_KEY'],
    base_url=os.environ.get('BEZALEL_BASE_URL', 'https://bezalel-email-standalone.michaelwasihun96.workers.dev'),
    timeout=30,  # seconds, default
)
```

`base_url` must be an HTTPS origin (HTTP is allowed only on loopback for local development). `timeout` is between 0 and 300 seconds. The client is synchronous; wrap calls in a thread pool if you need concurrency.

## Methods

Keyword arguments use snake case. Responses are plain dictionaries with the API's camel-case field names.

| Method | Operation |
| --- | --- |
| `email.inboxes.list(**kw)` | [List inboxes](/docs/api/list-inboxes) |
| `email.inboxes.create(**kw)` | [Create an inbox](/docs/api/create-inbox) |
| `email.inboxes.get(**kw)` | [Get an inbox](/docs/api/get-inbox) |
| `email.inboxes.update(**kw)` | [Update an inbox](/docs/api/update-inbox) |
| `email.inboxes.delete(**kw)` | [Delete an inbox](/docs/api/delete-inbox) |
| `email.inboxes.finish_setup(**kw)` | [Finish inbox setup](/docs/api/finish-inbox-setup) |
| `email.messages.list(**kw)` | [List messages](/docs/api/list-messages) |
| `email.messages.search(**kw)` | [Search messages](/docs/api/search-messages) |
| `email.messages.get(**kw)` | [Get a message](/docs/api/get-message) |
| `email.messages.send(**kw)` | [Send a message](/docs/api/send) |
| `email.messages.reply(**kw)` | [Reply to a message](/docs/api/reply) |
| `email.messages.update_labels(**kw)` | [Update message labels](/docs/api/update-message-labels) |
| `email.messages.get_attachment(**kw)` | [Get an attachment](/docs/api/get-attachment) |
| `email.threads.list(**kw)` | [List threads](/docs/api/list-threads) |
| `email.threads.get(**kw)` | [Get a thread](/docs/api/get-thread) |
| `email.threads.update_labels(**kw)` | [Update thread labels](/docs/api/update-thread-labels) |

## Example

```python
import uuid

inbox = email.inboxes.create(username='research', group='agents')

idempotency_key = str(uuid.uuid4())  # store it before sending
email.messages.send(
    inbox_id=inbox['inboxId'], to=['vendor@example.net'], subject='Quote request',
    text='Could you send the current quote for 200 units?', idempotency_key=idempotency_key,
)

page = email.messages.list(inbox_id=inbox['inboxId'], labels=['received', 'unread'], limit=20)
for message in page['messages']:
    print(message['from'], message['subject'])
    email.messages.update_labels(inbox_id=inbox['inboxId'], message_id=message['messageId'], remove_labels=['unread'])
```

## Paging

```python
for page in email.pages('listThreads', inbox_id=inbox['inboxId'], labels=['unread']):
    for thread in page['threads']:
        print(thread['subject'])
```

`pages` takes the operation id in camel case (`listInboxes`, `listMessages`, `searchMessages`, `listThreads`) and follows `nextPageToken` until it runs out.

## Errors

Failures raise `BezalelError` with `status`, `code`, and `transient`:

```python
from bezalel_email import BezalelError

try:
    email.messages.send(...)
except BezalelError as error:
    if error.code == 'network_error' or error.transient:
        retry_later_with_same_key()      # outcome unknown, or 429 / 502 / 503
    else:
        report(error.code, error.message)  # fix the request
```

`network_error` means the request may have reached the server; retry a send with the same `idempotency_key`. The client never retries on its own.
