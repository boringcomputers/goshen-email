# Custom-domain SMTP gateway

The native email Worker stores every custom-domain inbox in the email project's PlanetScale Postgres
and R2 storage. This gateway adds SMTP sending and receiving for domains at
any DNS provider. Managed-domain inboxes keep Cloudflare transport.
Customers add DNS records; they do not move their domain into our Cloudflare
account.

Merging alone does not enable customer domains. Deploy this gateway, migrate
and configure the email Worker, then start the standalone dashboard. This
runbook does not provision a host or change production DNS.

## Host and DNS

Use a Linux host with Docker Compose and a static public IPv4 address.
Confirm that the hosting provider permits incoming and outgoing TCP port 25.
It must also let you set reverse DNS for that address. The gateway speaks IPv4
SMTP only.

1. Choose a hostname such as `mx.example.com`. Add a DNS-only A record pointing
   to the host. Do not enable Cloudflare's HTTP proxy for this hostname.
2. Set the IP's PTR record to that hostname through the hosting provider.
   Confirm both forward and reverse lookups match.
3. Allow public TCP ports 25, 80, and 443. Ports 8080, 10025, and 10031 stay
   inside the containers. Restrict management access to the operations network.
4. Reserve disk space for the Postfix queue and delivery journal and monitor it.
   Mail accepted during an outage occupies this disk until delivery or bounce.
5. Allow at least 6 GiB of host RAM for the gateway and scanners. ClamAV has a
   4 GiB container limit; its initial signature download can take several minutes.
   Rspamd needs outbound DNS and ClamAV needs HTTPS access for signature updates.
   Scanner ports 11333 and 3310 stay on the private Compose network.

Port 443 accepts authenticated send requests from the Worker. Caddy obtains
and renews the TLS certificate. The gateway validates the certificate, key,
hostname, and expiry, then stages one atomic PEM file for Postfix. Postfix
reloads after renewal. Incoming SMTP offers STARTTLS; outgoing SMTP uses TLS when the
recipient server offers it.

The staged private key stays readable only by root, as required by
[Postfix's TLS guide](https://www.postfix.org/TLS_README.html). Postfix loads it
before dropping privileges. The gateway proves a STARTTLS handshake against
the staged certificate before reporting ready, and checks again every 30 seconds.
Invalid credentials stop startup; a later TLS failure makes health return 503.

## Configure and deploy

Run these commands from the repository root on the SMTP host:

```sh
cp ops/email/.env.example ops/email/.env
chmod 600 ops/email/.env
```

Set `MAIL_GATEWAY_HOSTNAME` and `MAIL_WORKER_URL` in that file. Generate a new
random token of at least 32 characters for `MAIL_GATEWAY_TOKEN` and store it
in the team's secret manager. This token permits SMTP submission and the
Worker's domain, recipient, receive, and delivery-report endpoints, plus the
gateway's scan endpoint. It cannot list or read
mailboxes. Do not reuse the Worker's `MAIL_API_TOKEN`.

```sh
docker compose --env-file ops/email/.env -f ops/email/compose.yml up -d --build
docker compose --env-file ops/email/.env -f ops/email/compose.yml ps
```

The gateway waits for Caddy's certificate before starting SMTP. Health also
requires the delivery journal, Rspamd, and ClamAV to be ready. Check
`https://YOUR_GATEWAY_HOSTNAME/healthz` for HTTP 200 and `{"ready":true}`.
The gateway needs the existing email Worker to answer recipient lookups
before it can accept mail.

Set these values on the email Worker with
`pnpm --filter @bezalel/email exec wrangler secret put NAME`:

| Name | Value |
| --- | --- |
| `MAIL_GATEWAY_URL` | HTTPS origin of the gateway |
| `MAIL_GATEWAY_HOSTNAME` | The same DNS hostname as the host configuration |
| `MAIL_GATEWAY_IPV4` | Its public sending IPv4 address |
| `MAIL_GATEWAY_TOKEN` | The same gateway token |
| `MAIL_DOMAIN_ENCRYPTION_KEY` | 32 independent random bytes encoded as 64 hex characters |

Back up the encryption key securely. Replacing it makes existing DKIM private
keys unreadable. Key rotation needs a separate decrypt-and-reencrypt migration.
Gateway token rotation requires updating both services together.

Use the existing mailbox database and R2 bucket. No new Cloudflare API token,
zone permission, Email Routing rule, or R2 credential is needed per customer.
The Worker keeps using its existing R2 binding and mailbox API credential.

```sh
pnpm --filter @bezalel/email migrate
pnpm --filter @bezalel/email deploy
```

Migration adds domain credentials, delivery and suppression tables, incoming scan
metadata, and the atomic quarantine-release function. It preserves existing mail
and provider mappings.
Restart the standalone dashboard after the Worker. Its `MAIL_WORKER_URL` and
`MAIL_API_TOKEN` stay the same. The dashboard is for one owner or a trusted team;
Bezalel's multi-tenant domain limits are not part of this deployment.

## Upgrade delivery tracking and protection

On an existing SMTP deployment, use this order:

1. Back up PostgreSQL, R2, the domain encryption key, and the stopped gateway's queue
   volume. Keep that volume attached throughout the upgrade.
2. Run the mailbox migration, then deploy the Worker. The new Worker requires
   scan metadata on custom-domain receive requests. An old gateway temporarily
   defers these deliveries in Postfix while the upgrade finishes.
3. Deploy the updated Compose stack, including Rspamd and ClamAV. Wait for
   `/healthz` to return 200 and for ClamAV to finish loading signatures. Check
   `postqueue -p` and verify held messages drain after scanning.
4. Restart the dashboard for protection metadata and owner release.
5. Set `MAIL_INBOUND_SCAN_ENABLED=true` on the Worker to scan managed-domain
   incoming jobs too. Set it only after the scanners pass the canary.
6. For each enrolled feedback-loop provider, confirm its DKIM signing domain and
   set the Worker's comma-separated `MAIL_FEEDBACK_SIGNERS`. Route its reports to
   `feedback@MAIL_GATEWAY_HOSTNAME` and verify a signed ARF report. Leaving this
   value empty disables the feedback address. Gmail aggregate reports and other
   formats that omit an identifiable recipient cannot create a suppression.

No new Cloudflare credentials are required for these features. The Worker uses
its existing R2 and Hyperdrive bindings, and shared gateway token. Feedback-loop
enrollment and managed-domain scanning are operator configuration steps.

Custom-domain mail submitted before the journal upgrade keeps its existing queued
status: it has no durable submission-to-queue mapping. Do not infer historical
success from an empty Postfix queue. New submissions keep delivery reports in
SQLite until the Worker acknowledges them, including across process restarts.

Rspamd recomputes authentication instead of trusting message headers. ClamAV scans
raw MIME, including attachments and archives, with bounded size, nesting, time,
and concurrency. Encrypted content and exceeded scan limits stay quarantined.
This stack does not configure Bayesian training or provider-specific allowlists.
Scanner failures make health fail and incoming delivery retry. They also pause
new gateway send requests until readiness recovers.

## Customer setup

1. Open Email > Custom domains and add a domain the customer owns. Prefer
   `agents.example.com` when the main domain already receives mail elsewhere.
   Changing MX records moves incoming mail to Bezalel.
2. Copy the five records into the customer's DNS provider. The ownership
   challenge and DKIM selector are unique to that registration.
3. Keep a single SPF record. If one exists, add the displayed `ip4:` mechanism
   before its final `all` mechanism. Preserve an existing DMARC policy.
4. Select Verify after the records propagate. Every record must pass before
   the domain can send, receive, or create inboxes.
5. Create an inbox and select the verified domain. Agents can use the same
   inbox through existing email tools.

Keep the ownership TXT and DKIM records in DNS. The Worker checks DNS again
during use after five minutes. DNS lookup failures temporarily defer SMTP.
Removed or invalid records stop the domain after the cached check expires.
If registration is removed and added again, replace the old challenge and
DKIM records. Remove active inboxes before removing their domain.

## Deployment canary

Use a domain and external inbox controlled by the operator. Record the commit,
hostname, timestamps, message IDs, and results without copying credentials.

1. Before publishing DNS, verify that the dashboard marks the domain pending
   and refuses custom-domain inbox creation.
2. Add the records and verify all five. Create a canary inbox. Send a message
   with an attachment and a BCC recipient controlled by the operator.
3. Inspect the external message headers. DKIM must pass with the customer
   domain and selector, SPF must pass for the gateway IP, and DMARC must pass.
   Confirm the attachment bytes and that the BCC address is absent from headers.
4. Reply externally and read the reply in Bezalel, including its attachment.
   Confirm the signed inbound event reaches the intended agent.
5. Connect to public SMTP with `openssl s_client -starttls smtp -connect
   YOUR_GATEWAY_HOSTNAME:25 -servername YOUR_GATEWAY_HOSTNAME`. Verify the
   certificate. SMTP RCPT must reject an unrelated domain and an unknown
   inbox on the canary domain before DATA.
6. In an isolated staging deployment, make the Worker receive endpoint
   temporarily unavailable after recipient lookup. Accepted mail must remain
   in `postqueue -p`. Restart the gateway with its queue volume intact, restore
   the Worker, then run `postqueue -f` inside the gateway. Confirm one message
   reaches the mailbox and the queue drains.
7. Send to controlled success, temporary-failure, and permanent-failure SMTP
   endpoints. Verify per-recipient delivered/deferred/bounced states in Sent and
   the signed delivery event. Repeat a hard-bounced recipient with an allowed
   BCC recipient: only the latter may appear in the actual SMTP envelope.
8. Hold the Worker's delivery-report endpoint unavailable in staging, send a
   message, and restart the gateway. Restore the endpoint and verify the pending
   report arrives without another SMTP submission.
9. Receive authenticated clean mail, GTUBE spam, an EICAR test attachment, and an
   unsigned message with forged Authentication-Results. Verify computed checks,
   quarantine reasons, and no incoming agent event for held mail. Malware must
   have neither a release button nor an attachment download. Release cleanly
   scanned spam as its owner and verify one event, including on a repeated call.
10. Stop ClamAV in staging, accept an incoming message, and restart the gateway.
    Restore ClamAV and verify the queue survives and delivers the message once.
    Repeat through managed-domain Email Routing after enabling its scan flag.
11. Send an enrolled provider's signed ARF complaint and replay it. Verify one
    complaint transition, inbox-scoped suppression, and no SMTP submission when
    all recipients are suppressed. Unsigned and unmatched reports must do nothing.
12. Try to remove the domain while its inbox exists. It must fail. A mailbox-scoped
   credential must not verify, remove, or create inboxes on this domain.

Local tests cover SQL ownership and deletion races, DNS responses, DKIM
signing, recipient routing, and SMTP submission. They use local DNS, SMTP,
and storage fixtures. They do not establish public port-25 reachability,
sender reputation, inbox placement, or live Cloudflare R2 delivery.

## Operations

Use `docker compose --env-file ops/email/.env -f ops/email/compose.yml exec
gateway postqueue -p` to inspect pending mail. Gateway logs include SMTP
addresses and message IDs, so restrict access. Request bodies, DKIM keys,
and API credentials are not logged.

Postfix retries temporary failures for up to five days and sends permanent
failure notices to the envelope sender. Custom sends start queued and then update
from the gateway's durable delivery journal. The Worker validates the stored
sender, recipient, message ID, and tracking ID before recording a report. A hard
bounce or verified complaint adds its suppression in the same transaction.
Inspect SMTP logs and bounce messages when delivery is uncertain. Never resend
an uncertain message just because its HTTP receipt was lost.

The journal lives at `/var/spool/postfix/bezalel/journal.sqlite` with the SMTP log.
Postfix queue IDs bind outcomes to submissions; incoming Message-ID headers cannot
claim another send. Logs rotate at 20 MiB. Fully read rotated logs remain for at
least a day; acknowledged events and completed submissions remain for 30 days.
Unacknowledged reports and uncertain submissions stay available for recovery.
Restrict access to this directory: it contains sender and recipient addresses.
Monitor old unacknowledged events, incoming retries, queue age, disk space, scanner
health, and ClamAV signature freshness. Restrict scanner logs as email metadata.

Keep the `queue`, `certificates`, `rspamd-data`, and `virus-signatures` volumes when updating the image. Do not run
`docker compose down -v` on a live gateway. Back up the queue while Postfix is
stopped, along with PostgreSQL, R2, and the domain encryption key. Monitor queue age,
disk usage, certificate expiry, health status, and the Worker's incoming jobs.

To stop provisioning, restrict access to the dashboard and platform API.
Existing inboxes still need the Worker and gateway. Do not remove the
gateway or its Worker configuration while customers' MX records point at it.
SMTP refuses unauthenticated relaying and uses exact recipient lookups.
Outbound DNS filters reject private and reserved destination addresses.

## Application mailbox domains

The scoped `/inbox-rpc` API supports `getCustomDomain`,
`connectCustomDomain` (`domain`, `username`), and `disconnectCustomDomain`.
All three accept the instance's optional canonical `inboxId`; another inbox
or an injected client/domain selector is rejected. Ownership comes from the
mailbox credential. One non-deleted domain is allowed per client, and global
Bezalel domain operations cannot adopt a client-owned registration.

Apply `pnpm --filter @bezalel/email migrate` before deploying this Worker
version. It adds domain client ownership, a current custom mailbox address,
historical sender aliases, and atomic verification/disconnection functions.
Update the consuming application after the Worker and gateway are ready. No extra secret
or custom-domain environment variable is required on client instances.

Verification activates an alias on the existing mailbox. Native `getInbox`
keeps `inboxId` stable and returns the active address in `address`. Sending
uses that address and its DKIM key; inbound mail resolves the alias to the
same mailbox. Messages, thread IDs, webhook destination/signatures,
idempotency keys, and daily allowances retain the original mailbox identity.
Provisioning again must keep the canonical username; it preserves the alias.

Disconnect clears the active alias and retires the domain while retaining
mail history. It waits for any unresolved send. Reconnecting or transferring
a retired domain requires fresh ownership proof and a new DKIM key. Deleting
an instance also retires its domain. Historical aliases are used only to
exclude the mailbox's previous addresses from reply-all recipients.

If the gateway is not configured, domain status returns `available: false`
and connection returns 503. Default-domain email remains available. Local
PGlite tests exercise the complete domain lifecycle, tenant isolation,
concurrent verification/disconnection, sending identity, and quota behavior;
real SMTP delivery still needs the deployed canary described above.

Delivery and complaint reports resolve the original sent message by its tracking
ID and sender before looking up an active address. Reports received after a
domain is disconnected or transferred therefore update the original mailbox
and its suppressions; they cannot deliver new mail to a retired alias. Each
DNS verification has a unique token recorded before lookup, so an older
observation cannot overwrite the most recently started check's result.
