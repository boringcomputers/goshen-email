export const accountInboxMigrations = [
  // Historical values may be operator-assigned; change the default without rewriting them.
  `alter table mail.customers alter column inbox_limit drop not null`,
  `alter table mail.customers alter column inbox_limit set default null`,
  `alter table mail.customer_inboxes add column if not exists group_name text
    check (group_name ~ '^[a-z0-9][a-z0-9_-]{0,63}$')`,
  `create index if not exists customer_inboxes_group on mail.customer_inboxes(customer_id, group_name)`,
  `drop function if exists mail.provision_customer_inbox(uuid, text, text, text, boolean)`,
  `create or replace function mail.provision_customer_inbox(p_customer uuid, p_address text,
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
    end $$`,
]
