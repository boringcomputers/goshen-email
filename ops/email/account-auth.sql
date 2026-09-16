-- Public account rollout, including the customer ownership schema.
-- Review and obtain production migration approval before execution.
-- Apply using the schema owner; existing default application grants must be present.
BEGIN;
SET LOCAL ROLE postgres;
create table if not exists mail.customers (
    id uuid primary key default gen_random_uuid(), email text not null unique,
    display_name text, access_subject text unique, created_at timestamptz not null default now(),
    signed_in_at timestamptz, disabled_at timestamptz,
    inbox_limit integer not null default 5 check (inbox_limit between 1 and 100),
    check (email = lower(email))
  );

create table if not exists mail.customer_inboxes (
    customer_id uuid not null references mail.customers(id),
    inbox_id uuid primary key references mail.inboxes(id)
  );

alter table mail.customer_inboxes add column if not exists route_ready boolean not null default true;

alter table mail.customer_inboxes alter column route_ready set default false;

create index if not exists customer_inboxes_owner on mail.customer_inboxes(customer_id);

alter table mail.clients alter column webhook_url drop not null;

drop function if exists mail.provision_customer_inbox(uuid, text, text, text);

create or replace function mail.provision_customer_inbox(p_customer uuid, p_address text,
      p_domain text, p_name text, p_owner boolean) returns uuid language plpgsql as $$
    declare active uuid; capacity integer;
    begin
      select inbox_limit into capacity from mail.customers
        where id = p_customer and disabled_at is null for update;
      if not found then raise exception 'CUSTOMER_DISABLED'; end if;
      select i.id into active from mail.customer_inboxes c join mail.inboxes i on i.id = c.inbox_id
        where c.customer_id = p_customer and i.address = p_address and i.deleted_at is null;
      if active is not null then return active; end if;
      if not p_owner and (select count(*) from mail.customer_inboxes c join mail.inboxes i on i.id = c.inbox_id
          where c.customer_id = p_customer and i.deleted_at is null) >= capacity
        then raise exception 'CUSTOMER_INBOX_LIMIT'; end if;
      active := mail.provision_client('dashboard_' || gen_random_uuid()::text,
        p_address, p_domain, p_name, null, 250);
      insert into mail.customer_inboxes(customer_id, inbox_id) values (p_customer, active);
      return active;
    end $$;

create or replace function mail.set_customer_access(p_customer uuid, p_enabled boolean)
    returns void language plpgsql as $$
    begin
      perform 1 from mail.customers where id = p_customer for update;
      update mail.customers set disabled_at = case when p_enabled then null else now() end where id = p_customer;
      if not p_enabled then
        update mail.clients set token_version = token_version + 1
          where inbox_id in (select inbox_id from mail.customer_inboxes where customer_id = p_customer);
      end if;
    end $$;

create schema if not exists "mail";

create table if not exists "mail"."auth_users" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table if not exists "mail"."auth_sessions" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" uuid not null references "mail"."auth_users" ("id") on delete cascade);

create table if not exists "mail"."auth_accounts" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "accountId" text not null, "providerId" text not null, "userId" uuid not null references "mail"."auth_users" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table if not exists "mail"."auth_verifications" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table if not exists "mail"."auth_rate_limits" ("id" uuid default pg_catalog.gen_random_uuid() not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index if not exists "auth_sessions_userId_idx" on "mail"."auth_sessions" ("userId");

create index if not exists "auth_accounts_userId_idx" on "mail"."auth_accounts" ("userId");

create index if not exists "auth_verifications_identifier_idx" on "mail"."auth_verifications" ("identifier");

alter table mail.customers add column if not exists auth_user_id uuid unique references mail.auth_users(id);
COMMIT;
