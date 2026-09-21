# Quarantine

Incoming mail is scanned before an agent sees it. Messages that fail the checks wait for a person.

## Why quarantine exists

An agent reads whatever lands in its inbox. Anyone on the internet can send to that address. Quarantine puts a person between the two for the mail most likely to be hostile: forged senders, spam, and attachments that carry malware.

## What the scanner checks

When inbound scanning is enabled on the deployment, every incoming message is checked before it is stored, and the result is saved on the message as `protection`:

```json
"protection": {
  "status": "quarantined",
  "scannedAt": "2026-09-20T18:07:44.000Z",
  "authentication": { "spf": "fail", "dkim": "none", "dmarc": "fail", "signingDomains": [] },
  "spam": { "score": 7.4, "threshold": 6 },
  "antivirus": { "status": "clean", "signatures": [] },
  "reasons": ["spam", "authentication_failed"]
}
```

A message is quarantined when any of these apply:

| Reason | Rule |
| --- | --- |
| `malware` | The antivirus scan found a signature. |
| `scan_incomplete` | The antivirus scan could not examine the message, for example an encrypted archive. |
| `spam` | The spam score reached the threshold (6), or the spam filter's own verdict was reject, quarantine, discard, or rewrite. |
| `authentication_failed` | DMARC failed, or SPF failed with neither DKIM nor DMARC passing. |

A message with no `protection` block arrived on a deployment without scanning enabled and was not checked.

## What happens to a quarantined message

- It carries the `quarantined` label instead of `received` and `unread`.
- It is left out of message and thread lists unless the request asks for `labels=quarantined`.
- A [mailbox key](/docs/authentication) cannot read its body. An account key can read the message, including `protection`, so a supervising process can see why it was held.
- No `email.received` webhook fires for it.
- [Triage](/docs/triage) skips it.
- Notifications skip it.

## Releasing

Only a signed-in person can release a message, from the **Quarantine** view in the dashboard. Release is refused while the antivirus result is anything other than clean, so a message flagged for malware cannot be released at all.

A released message gets `received` and `unread`, its `protection.status` becomes `released` with `releasedAt` and `releasedBy`, and any pending triage runs. It then appears in lists like any other message.

No API key can add or remove the `quarantined` label; the request fails with `quarantine_review_required` (403). This is deliberate: an agent that could release its own quarantined mail would remove the protection.

## Designing around it

- Poll or list with the default filters and your agent never sees quarantined mail. That is the safe default.
- If a supervising process needs to know what is being held, list with `labels=quarantined` using an account key and surface the `reasons` to a person.
- Legitimate senders with broken DNS (no SPF or DKIM) will be quarantined on `authentication_failed`. Ask them to fix their domain rather than turning the check off.
