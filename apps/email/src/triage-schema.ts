export const triageMigrations = [
  `alter table mail.messages add column if not exists triage jsonb`,
  `alter table mail.messages add column if not exists triage_attempts integer not null default 0`,
  `alter table mail.messages add column if not exists triage_available_at timestamptz not null default now()`,
  `alter table mail.messages add column if not exists triage_lease uuid`,
  `create index if not exists mail_triage_pending on mail.messages(triage_available_at, id) where triage->>'status' = 'pending' and coalesce(protection->>'status', '') <> 'quarantined'`,
]
