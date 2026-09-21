---
title: Authentication and API keys
description: Every request carries a bearer key. Account keys reach all of an account's inboxes within their scopes; mailbox keys reach one inbox.
---

## Sending a key

```sh
curl "{{API_BASE}}/v1/inboxes" \
  -H "Authorization: Bearer $BEZALEL_API_KEY"
```

The SDKs, CLI, and MCP server read the key from `BEZALEL_API_KEY`. No client accepts a key as a command-line flag or writes one to a config file, so keys stay in your secret manager or environment.

## Two kinds of key

| | Account key | Mailbox key |
| --- | --- | --- |
| Prefix | `bze_` | `gme_` |
| Created in | Dashboard, **API keys** | Dashboard, **Get started** for one inbox |
| Reaches | Every inbox the account owns, subject to scopes | One inbox |
| Can create or delete inboxes | With `inboxes:write` | No |
| Can list inboxes | Yes, with groups and paging | Only its own inbox |
| Can read quarantined bodies | Yes (release still needs a person) | No |
| Hosted MCP | Yes | No (stdio MCP works) |
| Expires | 1 to 365 days, default 30 | Until replaced |

Use an account key for anything that manages a fleet of inboxes. Use a mailbox key when one agent should be unable to touch any other inbox, even if it is compromised.

Neither key can create other keys, change account settings, or release quarantine. The platform credential that runs the service is never accepted on these endpoints.

## Scopes

An account key carries one or more scopes, chosen when it is created. Each operation names the scope it needs, shown on its [reference page](/docs/api).

| Scope | Allows |
| --- | --- |
| `inboxes:read` | List and inspect inboxes |
| `inboxes:write` | Create, group, finish setup for, and permanently delete inboxes |
| `messages:read` | Read and search messages and threads, get attachment download URLs |
| `messages:write` | Add and remove labels on messages and threads |
| `messages:send` | Send and reply |

A request outside the key's scopes fails with `forbidden` (403). The MCP server lists only the tools the key's scopes allow.

Pick the smallest set that does the job. An agent that reads support mail and drafts replies for a person to approve needs `messages:read` and `messages:write`, not `messages:send`.

## Creating and rotating account keys

1. Sign in at [goshenemail.com/app](https://goshenemail.com/app) and open **API keys**.
2. **Create API key.** Name it, select scopes, choose an expiration.
3. Copy the key. It is displayed once; Goshen Email keeps only its SHA-256 hash, so it cannot be shown again.
4. **Revoke** stops a key immediately. Revocation cannot be undone.

An account can hold up to 20 active keys, which leaves room to rotate without downtime: create the new key, deploy it, then revoke the old one. Disabling an account revokes all of its keys.

## Mailbox keys

Open an inbox, choose **Get started**, then **Get a mailbox key**. The key is masked until you choose **Copy key**. Save it as `BEZALEL_MAILBOX_KEY` in the agent's environment; the dashboard's **Copy command** gives you a `curl` call that references that variable rather than embedding the key.

Requesting a new mailbox key replaces the old one. The dashboard's **Check connection** turns green after the first successful request with the current key, which confirms the key reached the API. It does not prove that your agent's automation is running or that mail is being delivered.

## Errors you will see

| Code | Status | Meaning |
| --- | --- | --- |
| `unauthorized` | 401 | Missing, malformed, expired, or revoked key |
| `forbidden` | 403 | Valid key without the required scope, or a mailbox key reaching for another inbox |
| `access_denied` | 403 | The account is disabled |

See [Errors](/docs/errors) for the full list.

## Keeping keys out of prompts

Agents leak what they are given. Keep keys in the process environment, never in the model's context. If a model needs to send mail, expose a tool that holds the key (the [MCP server](/docs/mcp) does this) rather than pasting a `curl` command with the key into a prompt.
