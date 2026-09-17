export const settingsMigrations = [
  `alter table mail.customers add column if not exists organization_name text not null default 'Your workspace'
    check (length(btrim(organization_name)) between 1 and 100)`,
]
