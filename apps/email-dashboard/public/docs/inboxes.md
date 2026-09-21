# Inboxes

An inbox is a real email address with its own message store. Create one per agent, per project, or per task.

## The inbox object

| Field | Meaning |
| --- | --- |
| `inboxId` | The canonical email address. This is the identifier in every path. |
| `address` | The same address, kept for readability. |
| `displayName` | Optional name shown as the sender's name on outgoing mail. Up to 200 characters. |
| `group` | Optional group label for organizing inboxes within an account. See [Groups](/docs/groups). |
| `createdAt` | ISO 8601 creation time. |
| `deliveryStatus` | `ready` when incoming mail is routed to the inbox, `pending` when routing has not finished. |
| `setupAvailable` | `true` when [Finish inbox setup](/docs/api/finish-inbox-setup) can retry routing. |

## Creating an inbox

```sh
curl "https://bezalel-email-standalone.michaelwasihun96.workers.dev/v1/inboxes" \
  -H "Authorization: Bearer $BEZALEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"username":"support","displayName":"Support agent"}'
```

`username` is required. It becomes the local part of the address on the default domain, `agents.goshenemail.com`. Usernames are 1 to 64 characters, start with a letter or digit, and may contain letters, digits, dots, underscores, and hyphens.

Pass `domain` to create the inbox on a [custom domain](/docs/custom-domains) that your account has verified. The API refuses domains that are not verified with `domain_not_ready`.

### Retries are safe

Creating an inbox is idempotent on `username`. If the request times out or the response is lost, send it again. You get the existing inbox back, and its group stays as it was. A different username means a different inbox.

### When routing is pending

Incoming mail reaches an inbox through a delivery route that Goshen Email configures when the inbox is created. If that step fails, the inbox exists with `deliveryStatus: "pending"` and the address stays reserved for you. Call `POST /v1/inboxes/{inboxId}/setup` to retry. Sending from a pending inbox works; receiving does not until routing is `ready`.

## Listing inboxes

```sh
curl "https://bezalel-email-standalone.michaelwasihun96.workers.dev/v1/inboxes?group=agents&limit=50" \
  -H "Authorization: Bearer $BEZALEL_API_KEY"
```

Lists return up to 100 inboxes per page (default 50), sorted by creation time. Pass `nextPageToken` back as `pageToken` to continue; see [Pagination](/docs/pagination). Filter by `group` to see one group.

A mailbox key (`gme_`) lists only its own inbox and cannot filter or page.

## Updating an inbox

The only mutable field is `group`. `PATCH /v1/inboxes/{inboxId}` with `{"group":"research"}` moves the inbox, and `{"group":null}` removes it from any group. Display names and addresses are fixed at creation.

## Deleting an inbox

`DELETE /v1/inboxes/{inboxId}` retires the inbox and deletes its mail permanently. The address cannot be reused afterwards, which prevents a new inbox from receiving mail meant for the old one. Requests for a retired inbox return `inbox_retired` (410).

## Quotas

Accounts have no inbox-count cap by default. An operator can set an explicit quota on an account; when it is reached, creation returns `inbox_limit` (422). Send limits still apply per inbox; see [Limits](/docs/limits).

## In the dashboard

**Inboxes** lists every inbox you own with its group and delivery status. New accounts see a **Get started** guide that creates the first inbox, shows the address to send a test message to, and confirms the first received message without exposing its contents. Any inbox opens to its conversations, where you can read and reply alongside the agent.
