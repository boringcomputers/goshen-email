# Autumn pricing config

`autumn.config.ts` defines the Free, Developer, and Team plans and the six
features they meter. Autumn holds the live copy; this file is the reviewed
source. See [docs/pricing.md](../../docs/pricing.md) for the reasoning.

## Push a change

```sh
cd ops/autumn
npx atmn@2 push          # preview the diff against the sandbox or live environment
npx atmn@2 push --yes    # apply it
```

`atmn` reads `AUTUMN_SECRET_KEY` from the environment or `.env` in this folder.
Use the sandbox key first. After a push, the CLI writes `internalId` fields
into the config; commit them so renames are recognized later.

The Worker never reads this file. It calls Autumn with feature ids, so the ids
here and in `apps/email/src/billing.ts` must match; `pnpm test` checks that.

Pushing a plan that customers are already on drafts a migration in Autumn and
prints its link. Confirm it there.
