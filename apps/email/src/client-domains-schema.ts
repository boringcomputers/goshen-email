export const clientDomainMigrations = [
  `alter table mail.inboxes add column if not exists custom_address text`,
  `alter table mail.inboxes add column if not exists email_aliases text[] not null default '{}'`,
  `create unique index if not exists mail_inboxes_custom_address on mail.inboxes(custom_address)
    where custom_address is not null`,
  `alter table mail.domains add column if not exists client_id text references mail.clients(client_id)`,
  `alter table mail.domains add column if not exists client_address text`,
  `alter table mail.domains add column if not exists verification_token text`,
  `create unique index if not exists mail_domains_one_per_client on mail.domains(client_id)
    where client_id is not null and info->>'status' <> 'DELETED'`,
  `create or replace function mail.verify_client_domain(p_client text, p_domain text,
      p_challenge text, p_info jsonb, p_ready boolean, p_verification text)
    returns jsonb language plpgsql as $$
    declare active uuid; destination text; current_info jsonb; current_verification text;
    begin
      select i.id into active from mail.inboxes i join mail.clients c on c.inbox_id = i.id
        where c.client_id = p_client and i.deleted_at is null for update of i;
      if active is null then return null; end if;
      select client_address, info, verification_token into destination, current_info, current_verification from mail.domains
        where domain = p_domain and client_id = p_client and credentials->>'challenge' = p_challenge
          and info->>'status' <> 'DELETED' for update;
      if destination is null then return null; end if;
      if current_verification is distinct from p_verification then return current_info; end if;
      if p_ready then
        if exists(select 1 from mail.inboxes where address = destination and id <> active) then
          raise exception 'MAIL_ADDRESS_CONFLICT';
        end if;
        update mail.inboxes set custom_address = destination,
          email_aliases = array(select distinct unnest(email_aliases || array[destination])) where id = active;
      else
        update mail.inboxes set custom_address = null where id = active and custom_address = destination;
      end if;
      update mail.domains set info = p_info, verified_at = case when p_ready then now() else null end
        where domain = p_domain;
      return p_info;
    end $$`,
  `create or replace function mail.disconnect_client_domain(p_client text)
    returns boolean language plpgsql as $$
    declare active uuid; connected text;
    begin
      select i.id into active from mail.inboxes i join mail.clients c on c.inbox_id = i.id
        where c.client_id = p_client and i.deleted_at is null for update of i;
      if active is null then return false; end if;
      select domain into connected from mail.domains
        where client_id = p_client and info->>'status' <> 'DELETED' for update;
      if connected is null then return true; end if;
      if exists(select 1 from mail.sends where inbox_id = active and state = 'pending') then
        raise exception 'MAIL_SEND_PENDING';
      end if;
      update mail.inboxes set custom_address = null where id = active;
      update mail.domains set info = jsonb_set(info, '{status}', '"DELETED"'), verified_at = null
        where domain = connected;
      return true;
    end $$`
] as const
