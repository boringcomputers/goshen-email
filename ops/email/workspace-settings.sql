-- Apply as the schema owner before deploying the Worker and dashboard.
BEGIN;
SET LOCAL ROLE postgres;
alter table mail.customers add column if not exists organization_name text not null default 'Your workspace'
    check (length(btrim(organization_name)) between 1 and 100);
alter table mail.customers add column if not exists desktop_notifications boolean not null default false;
alter table mail.customers add column if not exists email_notifications boolean not null default false;
create table if not exists mail.notifications (
    id uuid primary key default gen_random_uuid(),
    customer_id uuid not null references mail.customers(id),
    message_id uuid not null references mail.messages(id) on delete cascade,
    created_at timestamptz not null default now(),
    desktop_requested boolean not null, email_requested boolean not null,
    email_state text not null default 'pending' check (email_state in ('pending', 'attempted', 'accepted', 'failed')),
    unique(customer_id, message_id)
  );
create index if not exists notifications_customer on mail.notifications(customer_id, created_at);
create index if not exists notifications_pending on mail.notifications(created_at) where email_requested and email_state = 'pending';
COMMIT;
