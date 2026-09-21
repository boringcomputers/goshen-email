# Developer platform scope

Reviewed AgentMail's public documentation on 2026-09-16. This is a capability
comparison, not API compatibility: Bezalel retains its own identifiers, payloads,
security model, and license.

| Surface | AgentMail documents | This developer release |
| --- | --- | --- |
| API | Account keys and resource endpoints | 17 versioned operations; account and mailbox keys; OpenAPI |
| SDKs | TypeScript/Node and Python | Typed TypeScript/JavaScript client and synchronous Python client |
| CLI | Resource commands, schemas, dry runs, several output formats | Resource commands, schemas, dry runs, JSON/stdin; Node 24 required |
| MCP | Hosted server with OAuth or API keys; stdio bridge | Hosted account-key authentication and stdio; OAuth remains future work |
| Inboxes and mail | Inbox lifecycle, sends/replies, threads, attachments, labels | Multiple inboxes per account with no default count cap; named groups, pagination, lifecycle and mail operations |
| Credentials | Fine-grained keys | Expiring account keys with five scopes, single reveal, revocation; existing mailbox keys |
| Events | Webhooks and WebSockets | Existing signed webhook delivery remains; self-service webhook management and WebSockets are future work |
| Other resources | Drafts, scheduled sends, pods, lists, provider sign-in, framework integrations | Future work; no claim of complete AgentMail parity |

Bezalel groups organize inboxes under the same account key. They do not provide
the isolated tenant namespaces represented by AgentMail pods.

Sources: [API overview](https://docs.agentmail.to/api-reference),
[CLI](https://docs.agentmail.to/integrations/cli),
[MCP](https://docs.agentmail.to/integrations/mcp), and
[documentation index](https://docs.agentmail.to/llms.txt).

The next API increment should add webhook subscription management and a local
webhook-verification helper, then persisted drafts and scheduled sending.
OAuth for MCP and agent framework adapters can follow the stable API. New
surfaces must reuse Worker ownership, quarantine, limits, and send reservation
logic rather than implementing separate mail behavior.
