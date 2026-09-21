---
title: Dashboard
description: The same inboxes your agents use, in a browser. Read, reply, review quarantine, manage keys and domains.
---

## Signing in

Go to [goshenemail.com/app](https://goshenemail.com/app). There is no password. Enter your email address and choose a magic link or a six-digit code; both arrive by email and work once, within ten minutes. A new address creates an account on first sign-in.

One account owns one workspace. Sign-in is limited to three link or code requests per ten minutes per address.

## Inboxes

The **Inboxes** page lists every inbox you own with its group and delivery status, and a **Create inbox** button that does what [Create an inbox](/docs/api/create-inbox) does. Open an inbox to see its conversations.

Inside an inbox: **Inbox**, **Sent**, **All mail**, **Quarantine**, and **Trash** are views over [labels](/docs/labels). Search runs the same full-text search as the API. Select a conversation to read it in order, open attachments, add or remove labels, move it to Trash, and reply. Replies you write here and replies your agent sends through the API land in the same thread.

Compose starts a new conversation from the selected inbox. The dashboard keeps your draft in the open tab and, if a send's outcome is uncertain, keeps its idempotency key so a retry cannot duplicate the message.

## Get started

A new workspace opens with a guided setup: choose a username on `{{DEFAULT_DOMAIN}}`, create the inbox, copy its address, send it a test message from elsewhere, and confirm arrival. **Check for email** reports only that a message arrived, not its contents. If delivery routing failed, **Retry delivery setup** repeats it for the same reserved address.

The guide also hands out a mailbox key for a single agent and a `curl` command that references it from the environment. **Check connection** confirms the first successful request with that key. See [Authentication](/docs/authentication).

## API keys

Create, name, scope, expire, and revoke account keys. Keys are shown once. Up to 20 can be active at a time. See [Authentication](/docs/authentication).

## Integrations

Shows the API base URL, a link to the OpenAPI document, and a link to manage keys. Configuration snippets for the SDKs, CLI, and MCP are in these docs: [TypeScript](/docs/typescript), [Python](/docs/python), [CLI](/docs/cli), [MCP](/docs/mcp).

## Domains

Add a domain, see the DNS records to publish, verify them, and remove the domain. See [Custom domains](/docs/custom-domains).

## Quarantine

Each inbox has a **Quarantine** view listing held messages with the scanner's reasons. A message can be released when its antivirus result is clean; released mail moves to the inbox and gets the `received` and `unread` labels. Only a signed-in person can release; no API key can. See [Quarantine](/docs/quarantine).

## Settings

Change the organization name (shown in the breadcrumb) and your profile name (shown in the account menu), and turn on notifications for new mail in your inboxes:

- **Desktop notifications** show a browser alert while the dashboard is open. The browser asks for permission when you turn it on.
- **Email notifications** send a short "New mail in Goshen Email" message to your sign-in address. The notification names the inbox and never includes message contents.

Both are off by default and skip quarantined, spam, and trashed mail. Your sign-in email is read-only.

## What the dashboard cannot do

It cannot show you an API key after creation, cannot add or remove the `quarantined` label except through **Release**, and cannot read inboxes owned by other accounts. Deployment administrators may see an additional read-only view of the upstream platform's inboxes; that view is not part of the customer product.
