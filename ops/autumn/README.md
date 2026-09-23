# Autumn pricing config

`autumn.config.ts` defines the Free, Developer, and Team plans and the six
features they meter. Autumn holds the live copy; this file is the reviewed
source. See [docs/pricing.md](../../docs/pricing.md) for the reasoning.

## Push a change

```sh
cd ops/autumn
npm ci                   # installs atmn; the config imports it for types
npx atmn env             # confirms which org and environment the key targets
npx atmn push            # preview the diff against that environment
npx atmn push --yes      # apply it
```

`atmn` reads `AUTUMN_SECRET_KEY` from the environment or `.env` in this folder
(`.env` is gitignored). Use a sandbox key first when one exists. After a push,
the CLI writes `internalId` fields into the config; commit them so renames are
recognized later. The current ids belong to the `goshen_email` production org,
pushed on 2026-09-23.

Autumn refuses balance locks on allocated features (`consumable: false`), so
the Worker consumes those at once and refunds with a negative event; only
consumable features use locks. Keep `allocatedFeatures` in
`apps/email/src/billing.ts` in step with the `consumable` flags here.

The Worker never reads this file. It calls Autumn with feature ids, so the ids
here and in `apps/email/src/billing.ts` must match; `pnpm test` checks that.

Pushing a plan that customers are already on drafts a migration in Autumn and
prints its link. Confirm it there.
