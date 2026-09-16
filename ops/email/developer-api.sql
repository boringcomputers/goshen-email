-- Apply after inbox-onboarding.sql as the schema owner, with migration approval.
BEGIN;
SET LOCAL ROLE postgres;
do $$ begin
    if exists (select 1 from information_schema.columns where table_schema = 'mail'
        and table_name = 'customers' and column_name = 'inbox_limit' and is_nullable = 'NO') then
      alter table mail.customers alter column inbox_limit drop not null;
      alter table mail.customers alter column inbox_limit set default null;
      update mail.customers set inbox_limit = null where inbox_limit = 5;
    end if;
  end $$;

alter table mail.customer_inboxes add column if not exists group_name text
    check (group_name ~ '^[a-z0-9][a-z0-9_-]{0,63}$');

create index if not exists customer_inboxes_group on mail.customer_inboxes(customer_id, group_name);

drop function if exists mail.provision_customer_inbox(uuid, text, text, text, boolean);

create or replace function mail.provision_customer_inbox(p_customer uuid, p_address text,
      p_domain text, p_name text, p_owner boolean, p_group text default null) returns uuid language plpgsql as $$
    declare active uuid; capacity integer;
    begin
      select inbox_limit into capacity from mail.customers
        where id = p_customer and disabled_at is null for update;
      if not found then raise exception 'CUSTOMER_DISABLED'; end if;
      select i.id into active from mail.customer_inboxes c join mail.inboxes i on i.id = c.inbox_id
        where c.customer_id = p_customer and i.address = p_address and i.deleted_at is null;
      if active is not null then return active; end if;
      if not p_owner and capacity is not null and
          (select count(*) from mail.customer_inboxes c join mail.inboxes i on i.id = c.inbox_id
           where c.customer_id = p_customer and i.deleted_at is null) >= capacity
        then raise exception 'CUSTOMER_INBOX_LIMIT'; end if;
      active := mail.provision_client('dashboard_' || gen_random_uuid()::text,
        p_address, p_domain, p_name, null, 250);
      insert into mail.customer_inboxes(customer_id, inbox_id, group_name) values (p_customer, active, p_group);
      return active;
    end $$;

create table if not exists mail.api_keys (
    id uuid primary key, customer_id uuid not null references mail.customers(id),
    name text not null, token_hash text not null unique, prefix text not null,
    scopes text[] not null, created_at timestamptz not null default now(),
    expires_at timestamptz, revoked_at timestamptz, last_used_at timestamptz
  );

create index if not exists api_keys_customer on mail.api_keys(customer_id);

create or replace function mail.create_api_key(p_customer uuid, p_id uuid, p_name text, p_hash text, p_prefix text, p_scopes text[], p_expires timestamptz)
    returns boolean language plpgsql as $$
    begin
      perform 1 from mail.customers where id = p_customer and disabled_at is null for update;
      if not found then return false; end if;
      if (select count(*) from mail.api_keys where customer_id = p_customer and revoked_at is null and (expires_at is null or expires_at > now())) >= 20 then return false; end if;
      insert into mail.api_keys(id, customer_id, name, token_hash, prefix, scopes, expires_at)
        values(p_id, p_customer, p_name, p_hash, p_prefix, p_scopes, p_expires);
      return true;
    end $$;

create or replace function mail.set_customer_access(p_customer uuid, p_enabled boolean)
    returns void language plpgsql as $$
    begin
      perform 1 from mail.customers where id = p_customer for update;
      update mail.customers set disabled_at = case when p_enabled then null else now() end where id = p_customer;
      if not p_enabled then
        update mail.clients set token_version = token_version + 1
          where inbox_id in (select inbox_id from mail.customer_inboxes where customer_id = p_customer);
        update mail.api_keys set revoked_at = coalesce(revoked_at, now()) where customer_id = p_customer;
      end if;
    end $$;
COMMIT;
