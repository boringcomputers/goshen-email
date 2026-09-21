# Get usage

Read the account's plan, inbox count, and remaining monthly balances. A 402 billing_limit error on another operation means a balance here is spent; upgrading is done by a person in the dashboard.

`GET /v1/usage`

Requires scope `inboxes:read`. MCP tool `get_usage`. SDK `email.account.usage()`. CLI `bezalel-email account usage`.

## Request

## Response

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `billing` | `"metered" \| "exempt" \| "disabled"` | Yes |  |
| `plan` | `object \| null` | Yes |  |
|   `planId` | `string` |  |  |
|   `status` | `string` |  |  |
|   `currentPeriodEnd` | `string \| null` |  |  |
|   `canceledAt` | `string \| null` |  |  |
| `inboxes` | `object` | Yes |  |
|   `count` | `number` | Yes |  |
|   `limit` | `number \| null` | Yes |  |
| `features` | `object[]` | Yes |  |
|   `feature` | `string` | Yes |  |
|   `granted` | `number \| null` | Yes |  |
|   `used` | `number` | Yes |  |
|   `remaining` | `number \| null` | Yes |  |
|   `unlimited` | `boolean` | Yes |  |
|   `resetsAt` | `string \| null` | Yes |  |

Errors return `{ "error": { "code", "message", "transient" } }` with a 4xx or 5xx status.

## Examples

```sh
curl "https://bezalel-email-standalone.michaelwasihun96.workers.dev/v1/usage" \
  -H "Authorization: Bearer $BEZALEL_API_KEY"
```

### TypeScript

```ts
const result = await email.account.usage()
```

### Python

```python
result = email.account.usage()
```

### CLI

```sh
bezalel-email account usage
```

