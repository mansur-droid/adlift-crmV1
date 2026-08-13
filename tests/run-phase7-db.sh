#!/usr/bin/env bash
set -euo pipefail
export PGPASSWORD="${PGPASSWORD:-postgres}"
DB_HOST="${DB_HOST:-localhost}"
DB_USER="${DB_USER:-postgres}"
DB_NAME="${DB_NAME:-postgres}"
PSQL=(psql -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1)

"${PSQL[@]}" <<'SQL'
create extension if not exists pgcrypto;
do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
create schema if not exists auth;
create table if not exists auth.users(id uuid primary key default gen_random_uuid());
create or replace function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;
create table if not exists public.crm_records(
 id uuid primary key default gen_random_uuid(),
 type text not null,
 payload jsonb not null default '{}'::jsonb,
 created_by uuid references auth.users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
SQL

for migration in \
 supabase/migrations/20260812010000_ai_voice_phase3_foundation.sql \
 supabase/migrations/20260812020000_ai_voice_phase4_admin_fields.sql \
 supabase/migrations/20260812030000_ai_voice_phase5_eligibility.sql \
 supabase/migrations/20260812040000_ai_voice_phase6_twilio.sql \
 supabase/migrations/20260814010000_ai_voice_phase7_realtime.sql; do
  "${PSQL[@]}" -f "$migration"
done

"${PSQL[@]}" -f tests/phase5-regression.sql
"${PSQL[@]}" -f tests/phase6-db.sql
"${PSQL[@]}" -f tests/phase7-db.sql
