export const customerMigrations = [
  `create table if not exists mail.customers (
    id uuid primary key default gen_random_uuid(), email text not null unique,
    display_name text, access_subject text unique, created_at timestamptz not null default now(),
    signed_in_at timestamptz, disabled_at timestamptz,
    inbox_limit integer not null default 5 check (inbox_limit between 1 and 100),
    check (email = lower(email))
  )`,
  `create table if not exists mail.customer_inboxes (
    customer_id uuid not null references mail.customers(id),
    inbox_id uuid primary key references mail.inboxes(id)
  )`,
  `create index if not exists customer_inboxes_owner on mail.customer_inboxes(customer_id)`,
  `alter table mail.clients alter column webhook_url drop not null`,
  `create or replace function mail.provision_customer_inbox(p_customer uuid, p_address text,
      p_domain text, p_name text) returns uuid language plpgsql as $$
    declare active uuid; capacity integer;
    begin
      select inbox_limit into capacity from mail.customers
        where id = p_customer and disabled_at is null for update;
      if not found then raise exception 'CUSTOMER_DISABLED'; end if;
      select i.id into active from mail.customer_inboxes c join mail.inboxes i on i.id = c.inbox_id
        where c.customer_id = p_customer and i.address = p_address and i.deleted_at is null;
      if active is not null then return active; end if;
      if (select count(*) from mail.customer_inboxes c join mail.inboxes i on i.id = c.inbox_id
          where c.customer_id = p_customer and i.deleted_at is null) >= capacity
        then raise exception 'CUSTOMER_INBOX_LIMIT'; end if;
      active := mail.provision_client('dashboard_' || gen_random_uuid()::text,
        p_address, p_domain, p_name, null, 250);
      insert into mail.customer_inboxes(customer_id, inbox_id) values (p_customer, active);
      return active;
    end $$`,
  `create or replace function mail.set_customer_access(p_customer uuid, p_enabled boolean)
    returns void language plpgsql as $$
    begin
      perform 1 from mail.customers where id = p_customer for update;
      update mail.customers set disabled_at = case when p_enabled then null else now() end where id = p_customer;
      if not p_enabled then
        update mail.clients set token_version = token_version + 1
          where inbox_id in (select inbox_id from mail.customer_inboxes where customer_id = p_customer);
      end if;
    end $$`,
]
