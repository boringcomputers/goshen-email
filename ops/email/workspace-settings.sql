-- Apply as the schema owner before deploying the settings API and dashboard.
-- Preserves existing accounts, inbox ownership, and authentication.
BEGIN;
SET LOCAL ROLE postgres;

alter table mail.customers add column if not exists organization_name text not null default 'Your workspace'
  check (length(btrim(organization_name)) between 1 and 100);

COMMIT;
