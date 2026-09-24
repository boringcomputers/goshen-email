# Security policy

Goshen Email stores other people's mail and holds credentials that can send as
them. Please report security problems privately.

## Report a vulnerability

Don't open a public issue, pull request, or discussion. Use GitHub's private
reporting: open this repository's **Security** tab and choose
**Report a vulnerability**, or go straight to
<https://github.com/boringcomputers/goshen-email/security/advisories/new>.
Only the maintainers can see the report.

Include:

- what you found and what an attacker could do with it,
- steps to reproduce, or a proof of concept,
- the commit, package version, or deployment you tested.

We'll reply in the advisory, work on the fix there, and credit you when it's
published unless you'd rather stay anonymous.

## What we care about most

- A mailbox key reading or sending from another inbox, or an account key
  reaching another account.
- Getting quarantined mail or its body past the hold without an owner's
  release.
- Forging webhook signatures, or delivery and feedback reports.
- A send going out twice for one idempotency key.
- Tokens, secrets, or other accounts' data reaching a browser or a log.
- Anything that lets a sender's message pick a different recipient's inbox.

## Testing the hosted service

Prefer the local fixture from the [README](README.md#try-it-locally); it
reproduces most of the API and dashboard with no real mail. If you must test
<https://goshenemail.com>:

- use only accounts and inboxes you created,
- send mail only to addresses you control,
- stop and report as soon as you can see data that isn't yours,
- don't run load tests or anything that degrades the service.

## Supported versions

There are no releases yet. Fixes land on `main`, and the hosted service runs
`main`.
