# PlanetScale Postgres through Hyperdrive

The email Worker uses `env.HYPERDRIVE.connectionString` with the `pg` driver.
PlanetScale owns the PostgreSQL database; Hyperdrive pools connections from
Cloudflare Workers. R2 continues to store MIME and attachments.

The `mail` schema and mailbox API stay the same. The standalone project no longer
uses the Neon driver. Original Bezalel deployments keep their existing configuration.

## Create the database connection

1. Create a dedicated PlanetScale **Postgres** database and choose its region.
   You can create it from the Cloudflare dashboard to use Cloudflare billing,
   or connect an existing PlanetScale database.
2. Use the primary's direct PostgreSQL endpoint on port 5432. Hyperdrive handles
   connection pooling. Use TLS certificate verification, `sslmode=verify-full`.
3. Run the migrations with a database owner role. Put its direct connection URL
   in an ignored `apps/email/.env`, using `.env.example` as a reference, then run
   `pnpm migrate`. Keep development and production credentials separate. For an
   existing deployment, migrate its data and verify a staging copy before changing
   the Worker's database connection; running this command only creates the schema.
4. Create an application role for Hyperdrive with `USAGE` on the `mail` schema,
   read/write access to its tables, and `EXECUTE` on its functions. Apply grants
   for both existing and future objects created by the migration role.
5. In Cloudflare's Hyperdrive page, create a configuration named
   `bezalel-email-standalone` using that role's primary connection. Disable query
   caching. Copy its ID into `apps/email/wrangler.jsonc` under `HYPERDRIVE`,
   replacing the all-zero placeholder.
6. Check the configuration before deployment:

   ```sh
   pnpm --filter @bezalel/email exec wrangler hyperdrive update YOUR_HYPERDRIVE_ID --caching-disabled --sslmode verify-full
   pnpm --filter @bezalel/email exec wrangler hyperdrive get YOUR_HYPERDRIVE_ID
   ```

   Confirm `caching.disabled` is `true`, the origin is the intended primary,
   and the origin SSL mode verifies the server certificate and hostname.

Hyperdrive's query cache must stay disabled for this application. Mailbox access,
token revocation, quarantine, suppression, and send reservations depend on current
state. Some `SELECT` statements invoke functions that also write data. Hyperdrive
still pools connections when caching is disabled. The Worker binding contains only
the configuration ID; caching and origin TLS are settings on the Hyperdrive resource.

The checked-in `localConnectionString` applies only during local development.
It contains disposable local credentials. The deployed Worker receives its
connection details from Hyperdrive and has no `DATABASE_URL` secret.

Cloudflare's [PlanetScale integration](https://developers.cloudflare.com/hyperdrive/planetscale/),
[connection guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/planetscale-postgres/),
and [query caching guide](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)
describe the provider configuration. See PlanetScale's
[Postgres compatibility guide](https://planetscale.com/docs/postgres/postgres-compatibility)
for supported database features and role permissions.

## Deploy and verify

Finish the [Worker setup](../apps/email/README.md#set-up-cloudflare), including
the R2 bucket, delivery queues, domain mapping, and Worker secrets. Then:

```sh
pnpm build
pnpm check
pnpm deploy:worker
```

Check `/healthz` for configuration errors. This endpoint does not query the
database. Use an authenticated `listInboxes` request to prove the database
connection, then create a test inbox and verify sending, receiving, search,
replay of an idempotent send, and delivery updates. Keep the platform token out
of browser JavaScript and command output.

For an existing mailbox deployment, back up the source database and complete
data transfer before switching the binding. Coordinate the switch with incoming
mail and background processing. After a successful cutover, remove the unused
`DATABASE_URL` Worker secret. Database rollback must account for writes accepted
after the switch; pointing back at an older copy can lose mail or send reservations.

Each SQL call opens and closes a client inside its current Worker event.
Hyperdrive reuses origin connections. Atomic mailbox operations live in database
functions, so they do not depend on keeping a client open between separate calls.
Socket cleanup also runs after errors, without retrying uncertain writes.

## Local development

Start a dedicated PostgreSQL server on an unused port. The checked-in local
configuration uses port 5434:

```sh
docker run --name bezalel-email-dev -d \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bezalel_email_dev \
  -p 127.0.0.1:5434:5432 -v bezalel-email-dev:/var/lib/postgresql postgres:18-bookworm
cp apps/email/.env.example apps/email/.env
cp apps/email/.dev.vars.example apps/email/.dev.vars
pnpm migrate
pnpm dev:worker
```

Wait for `pg_isready` to succeed before migrating. Populate the non-database
development secrets in `.dev.vars` before calling the Worker. Its configured
Cloudflare transport can send real email.

For another local port or a dedicated remote development database, set
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE` in the shell that runs
Wrangler. Give `DATABASE_URL` in `.env` the same direct development connection
for migrations. Keep private connection strings out of `wrangler.jsonc` and Git.
See [Hyperdrive local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/).

## Verification

`pnpm test` runs the existing embedded PostgreSQL tests plus adapter failure and
configuration checks. To test the production `pg` driver and the Hyperdrive
binding against PostgreSQL 18, start an isolated test server:

```sh
docker run --rm --name bezalel-email-postgres-test -d \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=bezalel_email_test \
  -p 127.0.0.1:5435:5432 postgres:18-bookworm
docker exec bezalel-email-postgres-test pg_isready -U postgres -d bezalel_email_test
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5435/bezalel_email_test pnpm test:postgres
docker stop bezalel-email-postgres-test
```

On the homelab, use `homelab-job` for the suite and pass the test URL to its child:

```sh
homelab-job run --title "Email PostgreSQL tests" --memory-mib 4096 --cpus 2 --timeout 3600 -- \
  env TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5435/bezalel_email_test pnpm test:postgres
```

The test URL must point to a local database ending in `_test`, without URL
query parameters. Its user must be allowed to create databases. Every fixture
creates a randomly named database and removes only that database on completion.
The suite fails if `TEST_DATABASE_URL` is missing. CI runs both test modes.

The runtime tests exercise production HTTP and incoming-mail handlers, background
processing, concurrent reads, and send replay through Wrangler's local Hyperdrive
binding. Provider responses are test doubles and R2 is local. These tests do not
prove PlanetScale credentials, Cloudflare's deployed pooling/cache settings,
SMTP delivery, or public DNS; verify those during deployment.
