alter table public.crm_records
  add column if not exists assigned_to_user_id uuid,
  add column if not exists created_by_user_id uuid;

create index if not exists crm_records_type_assigned_to_user_id_idx
  on public.crm_records(type, assigned_to_user_id);

create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  user_email text,
  action text not null,
  record_type text not null,
  record_id uuid,
  before_payload jsonb,
  after_payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists activity_logs_created_at_idx
  on public.activity_logs(created_at desc);

create index if not exists activity_logs_record_idx
  on public.activity_logs(record_type, record_id);
