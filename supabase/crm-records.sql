-- AdLift CRM shared Supabase storage
-- Run this once in Supabase SQL Editor with role set to postgres before merging/deploying the shared-data PR.

create table if not exists public.crm_records (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('leads', 'clients', 'freelancers', 'submissions', 'stats')),
  payload jsonb not null default '{}'::jsonb,
  created_by uuid not null default auth.uid() references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists crm_records_type_idx on public.crm_records(type);
create index if not exists crm_records_created_by_idx on public.crm_records(created_by);
create index if not exists crm_records_created_at_idx on public.crm_records(created_at desc);

create or replace function public.current_adlift_role()
returns text
language sql
stable
as $$
  select coalesce(
    auth.jwt() -> 'app_metadata' ->> 'role',
    auth.jwt() -> 'user_metadata' ->> 'role',
    ''
  );
$$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_crm_records_updated_at on public.crm_records;
create trigger set_crm_records_updated_at
before update on public.crm_records
for each row execute function public.set_updated_at();

alter table public.crm_records enable row level security;

drop policy if exists "Admins can manage all crm records" on public.crm_records;
drop policy if exists "Freelancers can read own work records" on public.crm_records;
drop policy if exists "Freelancers can create own work records" on public.crm_records;
drop policy if exists "Freelancers can update own work records" on public.crm_records;

create policy "Admins can manage all crm records"
on public.crm_records
for all
to authenticated
using (public.current_adlift_role() = 'admin')
with check (public.current_adlift_role() = 'admin');

create policy "Freelancers can read own work records"
on public.crm_records
for select
to authenticated
using (
  public.current_adlift_role() = 'freelancer'
  and type in ('submissions', 'stats')
  and created_by = auth.uid()
);

create policy "Freelancers can create own work records"
on public.crm_records
for insert
to authenticated
with check (
  public.current_adlift_role() = 'freelancer'
  and type in ('submissions', 'stats')
  and created_by = auth.uid()
);

create policy "Freelancers can update own work records"
on public.crm_records
for update
to authenticated
using (
  public.current_adlift_role() = 'freelancer'
  and type in ('submissions', 'stats')
  and created_by = auth.uid()
)
with check (
  public.current_adlift_role() = 'freelancer'
  and type in ('submissions', 'stats')
  and created_by = auth.uid()
);
