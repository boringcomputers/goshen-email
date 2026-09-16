// Generated from Better Auth 1.7.5; review before applying to any database.
export const accountMigrations = [
  "create schema if not exists \"mail\"",
  "create table if not exists \"mail\".\"auth_users\" (\"id\" uuid default pg_catalog.gen_random_uuid() not null primary key, \"name\" text not null, \"email\" text not null unique, \"emailVerified\" boolean not null, \"image\" text, \"createdAt\" timestamptz default CURRENT_TIMESTAMP not null, \"updatedAt\" timestamptz default CURRENT_TIMESTAMP not null)",
  "create table if not exists \"mail\".\"auth_sessions\" (\"id\" uuid default pg_catalog.gen_random_uuid() not null primary key, \"expiresAt\" timestamptz not null, \"token\" text not null unique, \"createdAt\" timestamptz default CURRENT_TIMESTAMP not null, \"updatedAt\" timestamptz not null, \"ipAddress\" text, \"userAgent\" text, \"userId\" uuid not null references \"mail\".\"auth_users\" (\"id\") on delete cascade)",
  "create table if not exists \"mail\".\"auth_accounts\" (\"id\" uuid default pg_catalog.gen_random_uuid() not null primary key, \"accountId\" text not null, \"providerId\" text not null, \"userId\" uuid not null references \"mail\".\"auth_users\" (\"id\") on delete cascade, \"accessToken\" text, \"refreshToken\" text, \"idToken\" text, \"accessTokenExpiresAt\" timestamptz, \"refreshTokenExpiresAt\" timestamptz, \"scope\" text, \"password\" text, \"createdAt\" timestamptz default CURRENT_TIMESTAMP not null, \"updatedAt\" timestamptz not null)",
  "create table if not exists \"mail\".\"auth_verifications\" (\"id\" uuid default pg_catalog.gen_random_uuid() not null primary key, \"identifier\" text not null, \"value\" text not null, \"expiresAt\" timestamptz not null, \"createdAt\" timestamptz default CURRENT_TIMESTAMP not null, \"updatedAt\" timestamptz default CURRENT_TIMESTAMP not null)",
  "create table if not exists \"mail\".\"auth_rate_limits\" (\"id\" uuid default pg_catalog.gen_random_uuid() not null primary key, \"key\" text not null unique, \"count\" integer not null, \"lastRequest\" bigint not null)",
  "create index if not exists \"auth_sessions_userId_idx\" on \"mail\".\"auth_sessions\" (\"userId\")",
  "create index if not exists \"auth_accounts_userId_idx\" on \"mail\".\"auth_accounts\" (\"userId\")",
  "create index if not exists \"auth_verifications_identifier_idx\" on \"mail\".\"auth_verifications\" (\"identifier\")",
  "alter table mail.customers add column if not exists auth_user_id uuid unique references mail.auth_users(id)"
]
