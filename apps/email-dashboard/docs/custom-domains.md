---
title: Custom domains
description: Send and receive from addresses on a domain you own, with the DNS records to publish and how verification works.
---

## Default domain first

Every account can create inboxes on `{{DEFAULT_DOMAIN}}` with no setup. Use it to build and test. Move to your own domain when the sender address matters to the people your agents write to, or when you want your own sending reputation.

## What you need

- A domain you control, with access to its DNS.
- The deployment's SMTP gateway. Custom-domain mail flows through a gateway that runs Postfix with Rspamd and ClamAV scanning, operated by whoever runs the deployment. On the hosted service that is Goshen Email; on a self-hosted deployment, follow the gateway runbook in the repository.

## Connect a domain

1. Sign in and open **Domains** in the dashboard.
2. **Add domain** and enter the domain name, for example `mail.example.com`.
3. The dashboard shows the records to publish. The domain stays `PENDING` until they resolve.
4. Publish the records at your DNS provider, then choose **Verify DNS**. Verification checks each record and marks it `verified` or `pending`.
5. When every record is verified, the domain becomes `VERIFIED` and you can create inboxes on it.

## The records

| Type | Name | Value | Purpose |
| --- | --- | --- | --- |
| TXT | `_bezalel.<domain>` | A challenge string unique to your account | Proves you control the domain |
| MX | `<domain>` | The gateway hostname, priority 10 | Routes incoming mail to Goshen Email |
| TXT | `<domain>` | `v=spf1 ip4:<gateway address> ~all` | Authorizes the gateway to send for your domain |
| TXT | `<selector>._domainkey.<domain>` | `v=DKIM1; k=rsa; p=<public key>` | Lets receivers verify the signature on your mail |
| TXT | `_dmarc.<domain>` | `v=DMARC1; p=none` | Tells receivers how to treat authentication failures |

The exact hostname, address, selector, and key come from the dashboard; copy them from there rather than from this page. The DKIM key pair is generated for your domain and the private half never leaves the service.

If the domain already has an SPF record, merge the `ip4:` term into it instead of publishing a second `v=spf1` record; two SPF records make SPF fail. `p=none` on DMARC is a monitoring policy; tighten it to `quarantine` or `reject` once your mail is flowing and authenticated.

## Create an inbox on the domain

```sh
curl "{{API_BASE}}/v1/inboxes" \
  -H "Authorization: Bearer $BEZALEL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"username":"research","domain":"mail.example.com"}'
```

Until the domain is `VERIFIED` this fails with `domain_not_ready` (422). A domain that another account already claimed fails with `domain_conflict` (409).

## Delivery outcomes

Mail sent from a custom domain goes out through the gateway, and the receiving server's answer is recorded on the message as `delivery`, per recipient. Bounces include the remote SMTP codes and reason. See [Sending mail](/docs/sending).

## Removing a domain

**Remove** in the dashboard deletes the domain's configuration. Do it only after retiring the inboxes on it. Remove the DNS records afterwards, or mail for that domain will keep arriving at a gateway that no longer knows it.
