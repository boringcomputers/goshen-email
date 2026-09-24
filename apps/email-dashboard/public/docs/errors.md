# Errors

Every error code the API returns, its HTTP status, what it means, and what to do.

## The error shape

```json
{
  "error": {
    "code": "idempotency_conflict",
    "message": "Idempotency key was used for a different email",
    "transient": false
  }
}
```

`code` is stable and meant for programs. `message` is for people and may change. `transient: true` means the same request may succeed if you retry later; `false` means retrying without a change will fail the same way.

The CLI prints the same object on stderr and exits 1. The MCP server returns it as the tool result with `isError: true`.

## Codes

### Authentication and access

| Code | Status | Meaning | What to do |
| --- | --- | --- | --- |
| `unauthorized` | 401 | Missing, malformed, expired, or revoked key | Create or rotate the key in the dashboard |
| `invalid_token` | 401 | The bearer value is not a recognized key | Check the environment variable |
| `forbidden` | 403 | The key lacks the operation's scope, or a mailbox key reached for another inbox | Use a key with the right scope |
| `access_denied` | 403 | The account is disabled | Contact the operator |
| `quarantine_review_required` | 403 | An API key tried to add or remove `quarantined` | Release from the dashboard |
| `message_quarantined` | 403 | Reply to, or read the body of, a quarantined message | Release from the dashboard first |
| `malware_blocked` | 403 | The message's attachments failed scanning | Cannot be released |

### Requests

| Code | Status | Meaning | What to do |
| --- | --- | --- | --- |
| `invalid_request` | 400, 415, 422 | Malformed JSON, wrong content type, or a bad path | Fix the request |
| `invalid_argument` | 422 | A field failed validation; the message names it | Fix the field |
| `not_found` | 404 | Inbox, message, thread, attachment, or route does not exist, or is not visible to this key | Check the identifier and encoding |
| `inbox_retired` | 410 | The inbox was deleted | Create a new inbox with a different username |

### Inboxes and domains

| Code | Status | Meaning | What to do |
| --- | --- | --- | --- |
| `inbox_conflict` | 409 | The address exists under a different owner | Choose another username |
| `inbox_limit` | 422 | The account's operator-set inbox quota is reached | Delete an inbox or ask for a higher quota |
| `billing_limit` | 402 | The plan's inbox, send, or triage allowance is spent | A person upgrades or adds capacity in the dashboard; then retry (sends with the same `idempotencyKey`) |
| `key_limit` | 422 | The account already has 20 active API keys | Revoke one |
| `routing_conflict` | 409 | The address already has a delivery rule that is not ours | Choose another username |
| `domain_not_configured` | 422 | The domain is not set up on this deployment | Add it in the dashboard |
| `domain_not_ready` | 422 | The domain's DNS records are not verified | Publish the records and verify |
| `domain_conflict` | 409 | The domain is claimed by another account | Use a different domain |
| `customer_exists` | 409 | An account with that identity already exists | Sign in instead |

### Sending

| Code | Status | Meaning | What to do |
| --- | --- | --- | --- |
| `idempotency_conflict` | 409 | The key was used with different contents | Use a new key for the new message |
| `send_pending` | 409 | A send with this key is still in progress | Wait, then retry with the same key |
| `rate_limited` | 429 | The inbox reached its rolling 24-hour send limit | Wait, then retry with the same key |
| `delivery_uncertain` | 502 | The outbound path did not confirm; the send may or may not have gone | Retry with the same key; the server resolves it |
| `delivery_busy` | 503 | Outbound capacity is saturated | Retry with the same key later |
| `message_pending` | 503 | The message is still being processed | Retry shortly |
| `attachment_storage_error` | 503 | Attachment storage was unavailable | Retry with the same key |

### Service

| Code | Status | Meaning | What to do |
| --- | --- | --- | --- |
| `not_configured` | 503 | A feature is not enabled on this deployment | Operator action |
| `billing_unavailable` | 503 | The billing provider did not answer, so a metered operation was refused | Retry; sends keep the same `idempotencyKey` |
| `dns_unavailable` | 503 | DNS lookups failed during verification | Retry |
| `scanner_unavailable`, `scan_required` | 503 | Inbound scanning is unavailable or incomplete | Retry |
| `provider_error`, `provider_response`, `provider_unavailable`, `gateway_error` | 502 | An upstream provider failed or answered unexpectedly | Retry; report if it persists |
| `internal_error` | 500 | Unexpected failure | Retry; report if it persists |

### Client-side (CLI and stdio MCP server)

| Code | Meaning |
| --- | --- |
| `network_error` | The request did not complete. The outcome is unknown; retry a send with the same `idempotencyKey`. `transient: true`. |

## Retrying

- Retry on `transient: true` and on `network_error`, with backoff.
- For `send` and `reply`, always retry with the **same** `idempotencyKey` and contents. The server returns the original result with `deduplicated: true` if the first attempt went through.
- Do not retry 4xx errors other than `send_pending`, `rate_limited`, and `billing_limit` (after the plan changes) without changing the request.
