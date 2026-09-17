import { clientDomainMigrations } from "./client-domains-schema.js"

const searchExpression = `
  setweight(to_tsvector('simple', left(coalesce(data->>'subject', ''), 4096)), 'A') ||
  setweight(to_tsvector('simple', left(coalesce(data->>'from', ''), 4096) || ' ' || left(coalesce(data->>'to', ''), 8192)), 'B') ||
  setweight(to_tsvector('simple', left(coalesce(data->>'text', ''), 131072)), 'C')`

export const migrations = [
  `create schema if not exists mail`,
  `create table if not exists mail.schema_migrations (
    id text primary key, applied_at timestamptz not null default now()
  )`,
  `create table if not exists mail.domains (
    domain text primary key, info jsonb not null
  )`,
  `alter table mail.domains add column if not exists credentials jsonb`,
  `alter table mail.domains add column if not exists verified_at timestamptz`,
  `create table if not exists mail.inboxes (
    id uuid primary key, address text not null unique,
    domain text not null references mail.domains(domain), display_name text,
    created_at timestamptz not null default now(), deleted_at timestamptz
  )`,
  `alter table mail.inboxes add column if not exists testing boolean not null default false`,
  `create table if not exists mail.clients (
    client_id text primary key, inbox_id uuid not null unique references mail.inboxes(id),
    webhook_url text not null, token_version integer not null default 1,
    daily_send_limit integer not null default 250 check (daily_send_limit between 1 and 10000)
  )`,
  `create or replace function mail.provision_client(p_client text, p_address text, p_domain text,
      p_name text, p_webhook text, p_limit integer)
    returns uuid language plpgsql as $$
    declare active uuid;
    begin
      perform pg_advisory_xact_lock(hashtext('mail-client:' || p_client));
      select inbox_id into active from mail.clients where client_id = p_client;
      if active is not null then
        if not exists(select 1 from mail.inboxes where id = active and address = p_address) then
          raise exception 'MAIL_CLIENT_CONFLICT';
        end if;
        update mail.clients set webhook_url = p_webhook, daily_send_limit = p_limit where client_id = p_client;
        return active;
      end if;
      perform 1 from mail.domains where domain = p_domain and info->>'status' = 'VERIFIED' for update;
      if not found then raise exception 'MAIL_DOMAIN_NOT_READY'; end if;
      active := gen_random_uuid();
      insert into mail.inboxes(id, address, domain, display_name) values(active, p_address, p_domain, p_name);
      insert into mail.clients(client_id, inbox_id, webhook_url, daily_send_limit)
        values(p_client, active, p_webhook, p_limit);
      return active;
    end $$`,
  `create table if not exists mail.messages (
    id uuid primary key, inbox_id uuid not null references mail.inboxes(id),
    wire_id text not null, thread_id uuid not null, timestamp timestamptz not null,
    direction text not null check (direction in ('received', 'sent')),
    labels text[] not null default '{}', data jsonb not null,
    search tsvector generated always as (${searchExpression}) stored,
    unique (inbox_id, wire_id)
  )`,
  `alter table mail.messages add column if not exists delivery jsonb`,
  `alter table mail.messages add column if not exists protection jsonb`,
  `create index if not exists mail_messages_page on mail.messages(inbox_id, timestamp desc, id desc)`,
  `create index if not exists mail_messages_threads on mail.messages(inbox_id, thread_id, timestamp)`,
  `do $$ begin
    perform pg_advisory_xact_lock(hashtext('bezalel-email-bounded-search'));
    if not exists(select 1 from mail.schema_migrations where id = 'bounded-search-v1') then
      drop index if exists mail.mail_messages_search;
      alter table mail.messages drop column search;
      alter table mail.messages add column search tsvector generated always as (${searchExpression}) stored;
      create index mail_messages_search on mail.messages using gin(search);
      insert into mail.schema_migrations(id) values ('bounded-search-v1');
    end if;
  end $$`,
  `create table if not exists mail.sends (
    inbox_id uuid not null references mail.inboxes(id), key text not null,
    fingerprint text not null, state text not null check (state in ('pending', 'sent', 'failed')),
    result jsonb, error jsonb, created_at timestamptz not null default now(),
    primary key (inbox_id, key)
  )`,
  `create index if not exists mail_sends_window on mail.sends(inbox_id, created_at)
    where state in ('pending', 'sent')`,
  `create table if not exists mail.outbox (
    id text primary key, inbox_id uuid not null references mail.inboxes(id),
    payload jsonb not null, attempts integer not null default 0,
    available_at timestamptz not null default now(), delivered_at timestamptz
  )`,
  `create index if not exists mail_outbox_pending on mail.outbox(available_at) where delivered_at is null`,
  `create table if not exists mail.garbage (
    prefix text primary key, created_at timestamptz not null default now(),
    available_at timestamptz not null default now()
  )`,
  `create table if not exists mail.incoming (
    object_key text primary key, inbox_id uuid not null references mail.inboxes(id),
    recipient text not null, attempts integer not null default 0,
    available_at timestamptz not null default now()
  )`,
  `alter table mail.incoming add column if not exists envelope_sender text`,
  `create or replace function mail.release_quarantine(p_inbox uuid, p_message uuid, p_protection jsonb, p_event jsonb)
    returns text language plpgsql as $$
    declare current_protection jsonb;
    begin
      perform id from mail.inboxes where id = p_inbox and deleted_at is null for update;
      if not found then return 'missing'; end if;
      select protection into current_protection from mail.messages where id = p_message and inbox_id = p_inbox for update;
      if not found then return 'missing'; end if;
      if current_protection->>'status' is distinct from 'quarantined' then return 'already'; end if;
      if current_protection->'antivirus'->>'status' is distinct from 'clean' then return 'infected'; end if;
      update mail.messages set protection = p_protection,
        labels = array(select distinct value from unnest(labels || array['received','unread']) value where value not in ('quarantined','trash'))
        where id = p_message;
      if p_event is not null then
        insert into mail.outbox(id, inbox_id, payload) values ('release:' || p_message::text, p_inbox, p_event) on conflict do nothing;
      end if;
      return 'released';
    end $$`,
  `create or replace function mail.apply_delivery(p_inbox uuid, p_message uuid, p_version int, p_delivery jsonb, p_event jsonb)
    returns text language plpgsql as $$
    declare active uuid; current_version int;
    begin
      select id into active from mail.inboxes where id = p_inbox and deleted_at is null for update;
      if active is null then return 'missing'; end if;
      select coalesce((delivery->>'version')::int, 0) into current_version
        from mail.messages where id = p_message and inbox_id = p_inbox for update;
      if not found then return 'missing'; end if;
      if current_version <> p_version then return 'retry'; end if;
      update mail.messages set delivery = p_delivery where id = p_message;
      if p_event is not null then
        insert into mail.outbox(id, inbox_id, payload)
          values ('delivery:' || p_message::text || ':' || (p_delivery->>'version'), p_inbox, p_event)
          on conflict do nothing;
      end if;
      return 'updated';
    end $$`,
  `create table if not exists mail.recipient_suppressions (
    inbox_id uuid not null references mail.inboxes(id), recipient text not null,
    reason text not null check (reason in ('hard_bounce', 'complaint')),
    event_id text not null, created_at timestamptz not null default now(),
    primary key (inbox_id, recipient)
  )`,
  `create or replace function mail.apply_gateway_delivery(
    p_inbox uuid, p_message uuid, p_version int, p_delivery jsonb, p_event jsonb, p_suppression jsonb)
    returns text language plpgsql as $$
    declare result text;
    begin
      result := mail.apply_delivery(p_inbox, p_message, p_version, p_delivery, p_event);
      if result = 'updated' and p_suppression is not null then
        insert into mail.recipient_suppressions(inbox_id, recipient, reason, event_id)
          values (p_inbox, p_suppression->>'recipient', p_suppression->>'reason', p_suppression->>'eventId')
          on conflict (inbox_id, recipient) do update
            set reason = case when excluded.reason = 'complaint' then 'complaint' else mail.recipient_suppressions.reason end,
                event_id = excluded.event_id;
      end if;
      return result;
    end $$`,
  `create or replace function mail.reserve_send(p_inbox uuid, p_key text, p_fingerprint text)
    returns boolean language plpgsql as $$
    declare active uuid; inserted uuid;
    begin
      select id into active from mail.inboxes where id = p_inbox and deleted_at is null for update;
      if active is null then return false; end if;
      if not exists(select 1 from mail.sends where inbox_id = p_inbox and key = p_key
          and (state <> 'failed' or error->>'code' not in ('rate_limited', 'attachment_storage_error')))
        and exists(select 1 from mail.clients c where c.inbox_id = p_inbox and
          (select count(*) from mail.sends where inbox_id = p_inbox and state in ('pending', 'sent')
            and created_at > now() - interval '24 hours') >= c.daily_send_limit) then
        raise exception 'MAIL_DAILY_SEND_LIMIT';
      end if;
      insert into mail.sends(inbox_id, key, fingerprint, state) values (p_inbox, p_key, p_fingerprint, 'pending')
        on conflict do nothing returning inbox_id into inserted;
      if inserted is not null then return true; end if;
      update mail.sends set state = 'pending', error = null, created_at = now()
        where inbox_id = p_inbox and key = p_key and fingerprint = p_fingerprint
          and state = 'failed' and error->>'code' in ('rate_limited', 'attachment_storage_error')
        returning inbox_id into inserted;
      return inserted is not null;
    end $$`,
  ...clientDomainMigrations,
  `create or replace function mail.delete_domain(p_domain text)
    returns text language plpgsql as $$
    begin
      perform 1 from mail.domains where domain = p_domain and info->>'status' <> 'DELETED' for update;
      if not found then return 'absent'; end if;
      if exists(select 1 from mail.inboxes where domain = p_domain and deleted_at is null)
        or exists(select 1 from mail.domains where domain = p_domain and client_id is not null)
        then return 'in_use'; end if;
      update mail.domains set info = jsonb_set(info, '{status}', '"DELETED"'), verified_at = null where domain = p_domain;
      return 'deleted';
    end $$`,
  `create or replace function mail.delete_inbox(p_address text)
    returns text language plpgsql as $$
    declare active uuid;
    begin
      select id into active from mail.inboxes where address = p_address and deleted_at is null for update;
      if active is null then return 'absent'; end if;
      if exists(select 1 from mail.sends where inbox_id = active and state = 'pending') then return 'pending'; end if;
      update mail.inboxes set deleted_at = now(), custom_address = null where id = active;
      update mail.domains set info = jsonb_set(info, '{status}', '"DELETED"'), verified_at = null
        where client_id in (select client_id from mail.clients where inbox_id = active);
      delete from mail.messages where inbox_id = active;
      delete from mail.outbox where inbox_id = active;
      delete from mail.incoming where inbox_id = active;
      delete from mail.sends where inbox_id = active;
      delete from mail.recipient_suppressions where inbox_id = active;
      insert into mail.garbage(prefix) values (active::text || '/') on conflict do nothing;
      return 'deleted';
    end $$`
]
