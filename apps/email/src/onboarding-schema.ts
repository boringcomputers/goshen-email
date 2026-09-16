export const onboardingMigrations = [
  `alter table mail.clients add column if not exists connected_at timestamptz`,
  `alter table mail.clients add column if not exists connected_token_version integer`,
]
