# Groups

Groups organize the inboxes in one account by project, team, or agent fleet.

## What a group is

A group is a label on an inbox. An account with a few dozen inboxes can put the research agents in `research`, the support agents in `support`, and each customer's inboxes in a group named after the customer.

Group names are 1 to 64 characters of lowercase letters, digits, underscores, and hyphens, starting with a letter or digit. They need no separate creation step: the first inbox that uses a name creates the group, and removing the last inbox from it makes it disappear.

## What a group is not

Groups are organizational only. An account key with `inboxes:read` sees every group; a key cannot be limited to one group. If you need isolation between tenants, use separate accounts, each with its own keys, or give an agent a [mailbox key](/docs/authentication) that reaches a single inbox.

## Assigning a group

At creation:

```sh
curl "https://bezalel-email-standalone.michaelwasihun96.workers.dev/v1/inboxes" \
  -H "Authorization: Bearer $BEZALEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"username":"acme-support","group":"acme"}'
```

Later, with [Update an inbox](/docs/api/update-inbox):

```sh
curl "https://bezalel-email-standalone.michaelwasihun96.workers.dev/v1/inboxes/acme-support%40agents.goshenemail.com" \
  -H "Authorization: Bearer $BEZALEL_API_KEY" -X PATCH \
  -H "Content-Type: application/json" \
  -d '{"group":"acme-eu"}'
```

Send `{"group":null}` to remove the inbox from its group. Retrying an inbox creation keeps whatever group the inbox already has.

## Listing by group

```sh
curl "https://bezalel-email-standalone.michaelwasihun96.workers.dev/v1/inboxes?group=acme" \
  -H "Authorization: Bearer $BEZALEL_API_KEY"
```

Keep the same `group` filter while paging through results. Mailbox keys cannot filter by group.

In the dashboard, the **Inboxes** page has a group selector that filters the list the same way.
