-- Apply after account-auth.sql using the schema owner, with migration approval.
BEGIN;
SET LOCAL ROLE postgres;
ALTER TABLE mail.clients ADD COLUMN IF NOT EXISTS connected_at timestamptz;
ALTER TABLE mail.clients ADD COLUMN IF NOT EXISTS connected_token_version integer;
COMMIT;
