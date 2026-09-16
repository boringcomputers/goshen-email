export const apiKeyMigrations = [
  `create table if not exists mail.api_keys (
    id uuid primary key, customer_id uuid not null references mail.customers(id),
    name text not null, token_hash text not null unique, prefix text not null,
    scopes text[] not null, created_at timestamptz not null default now(),
    expires_at timestamptz, revoked_at timestamptz, last_used_at timestamptz
  )`,
  `create index if not exists api_keys_customer on mail.api_keys(customer_id)`,
  `create or replace function mail.create_api_key(p_customer uuid, p_id uuid, p_name text, p_hash text, p_prefix text, p_scopes text[], p_expires timestamptz)
    returns boolean language plpgsql as $$
    begin
      perform 1 from mail.customers where id = p_customer and disabled_at is null for update;
      if not found then return false; end if;
      if (select count(*) from mail.api_keys where customer_id = p_customer and revoked_at is null and (expires_at is null or expires_at > now())) >= 20 then return false; end if;
      insert into mail.api_keys(id, customer_id, name, token_hash, prefix, scopes, expires_at)
        values(p_id, p_customer, p_name, p_hash, p_prefix, p_scopes, p_expires);
      return true;
    end $$`,
  `create or replace function mail.set_customer_access(p_customer uuid, p_enabled boolean)
    returns void language plpgsql as $$
    begin
      perform 1 from mail.customers where id = p_customer for update;
      update mail.customers set disabled_at = case when p_enabled then null else now() end where id = p_customer;
      if not p_enabled then
        update mail.clients set token_version = token_version + 1
          where inbox_id in (select inbox_id from mail.customer_inboxes where customer_id = p_customer);
        update mail.api_keys set revoked_at = coalesce(revoked_at, now()) where customer_id = p_customer;
      end if;
    end $$`,
]
