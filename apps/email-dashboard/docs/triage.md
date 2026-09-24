---
title: Triage
description: Optional classification of incoming mail: a category, whether a reply is needed, and how urgent it is.
---

## What triage adds

When the operator enables triage on a deployment, each new incoming message is analyzed after it is stored, and the result is attached to the message as `triage`. Lists, searches, and thread reads carry it, and they accept filters on it.

Triage describes the message. It does not authorize anything: it never sends, labels, releases quarantine, or takes any other action. Use it to decide what your agent looks at first.

## The triage object

`triage.status` is `pending`, `complete`, or `failed`. A completed result looks like this:

```json
"triage": {
  "status": "complete",
  "model": "jev-latest",
  "version": 1,
  "analyzedAt": "2026-09-20T18:07:46.000Z",
  "durationMs": 640,
  "bodyTruncated": false,
  "usage": { "inputTokens": 812, "outputTokens": 40 },
  "category": { "value": "sales", "confidence": 0.91, "probabilities": { "sales": 0.91, "support": 0.05, "other": 0.04 } },
  "needsReply": { "value": true, "probability": 0.88 },
  "urgency": { "value": "normal", "score": 1.2, "confidence": 0.74, "probabilities": { "low": 0.2, "normal": 0.6, "high": 0.18, "critical": 0.02 } }
}
```

| Field | Meaning |
| --- | --- |
| `category.value` | `billing`, `support`, `sales`, `personal`, `notification`, or `other`. |
| `category.confidence`, `category.probabilities` | How sure the model is, and the full distribution. |
| `needsReply.probability` | Probability that the message called for a response when it arrived. |
| `needsReply.value` | `true` at 0.8 or above, `false` at 0.2 or below, otherwise `null` (uncertain). |
| `urgency.score` | Probability-weighted position from 0 (low) to 3 (critical). |
| `urgency.value` | The rounded score as `low`, `normal`, `high`, or `critical`, or `null` when confidence is below 0.5. |
| `model`, `version`, `analyzedAt`, `bodyTruncated` | Which model and rubric produced the result, when, and whether the input was cut. |

A `failed` result carries a fixed `code` (`provider_unavailable`, `provider_rejected`, or `invalid_response`) and `failedAt`. Failures never block reading or replying.

## Filtering

`listMessages`, `searchMessages`, and `listThreads` accept:

| Parameter | Values |
| --- | --- |
| `category` | `billing`, `support`, `sales`, `personal`, `notification`, `other` |
| `needsReply` | `yes`, `no`, `uncertain` |
| `urgency` | `low`, `normal`, `high`, `critical` |

```sh
curl "{{API_BASE}}/v1/inboxes/support%40{{DEFAULT_DOMAIN}}/threads?needsReply=yes&urgency=high" \
  -H "Authorization: Bearer $GOSHENEMAIL_API_KEY"
```

On a thread, the filters apply to the latest incoming message. Once the agent replies, the thread's triage is cleared until the next message arrives, so `needsReply=yes` naturally lists conversations waiting on you.

## What the model sees

The sender, up to 50 recipients, the subject, the received time, and the first 32,768 characters of the plain-text body. It does not see HTML, attachments, the Bcc list, or any credential. `bodyTruncated: true` marks a cut body.

Quarantined messages are not analyzed. If a person releases one, analysis runs then.

## Reading the thresholds

The 0.8/0.2 reply thresholds and the 0.5 urgency confidence floor are display rules, not accuracy guarantees. The dashboard shows a "Maybe" category when confidence is below 0.5 and calls out uncertain reply and urgency judgments. Test on your own mail before letting triage drive automation, and keep a person in the loop for anything the model marks `critical`.

## When triage is absent

Deployments without a TypeSafe key store mail normally and omit `triage` entirely. The initial `email.received` webhook can carry `status: "pending"`; read the message again for the completed result. There is no separate completion webhook and no backfill of older mail.
