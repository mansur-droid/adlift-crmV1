-- Phase 3: AI voice-agent database foundation
-- Keeps existing CRM/cold-call prospect records in public.crm_records and adds
-- transactional relational tables for AI calling. No telephony provider is connected here.

begin;

create extension if not exists pgcrypto;

create or replace function public.ai_current_role()
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

create or replace function public.ai_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.ai_assert_stats_prospect()
returns trigger
language plpgsql
as $$
declare
  prospect_type text;
begin
  if new.prospect_record_id is null then
    return new;
  end if;

  select type into prospect_type
  from public.crm_records
  where id = new.prospect_record_id;

  if prospect_type is distinct from 'stats' then
    raise exception 'AI voice prospect_record_id % must reference a crm_records row with type=stats', new.prospect_record_id;
  end if;

  return new;
end;
$$;

create table if not exists public.ai_provider_configs (
  id uuid primary key default gen_random_uuid(),
  provider_kind text not null check (provider_kind in ('telephony','stt','llm','tts','calendar','storage')),
  provider_slug text not null,
  display_name text not null,
  enabled boolean not null default false,
  settings jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider_kind, provider_slug)
);
comment on column public.ai_provider_configs.settings is 'Non-secret provider configuration only. Secrets remain server-side.';

create table if not exists public.ai_call_campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'draft' check (status in ('draft','active','paused','stopped','archived')),
  enabled boolean not null default false,
  telephony_provider_slug text,
  stt_provider_slug text,
  llm_provider_slug text,
  tts_provider_slug text,
  calendar_provider_slug text,
  storage_provider_slug text,
  calling_window_start time not null default '09:00',
  calling_window_end time not null default '17:00',
  calling_days smallint[] not null default array[1,2,3,4,5]::smallint[],
  timezone_strategy text not null default 'lead_local' check (timezone_strategy in ('lead_local','fixed')),
  fixed_timezone text,
  max_attempts_per_prospect integer not null default 3 check (max_attempts_per_prospect between 1 and 100),
  min_retry_delay_minutes integer not null default 60 check (min_retry_delay_minutes >= 0),
  max_calls_per_day integer not null default 100 check (max_calls_per_day > 0),
  max_connected_minutes_per_day integer not null default 600 check (max_connected_minutes_per_day > 0),
  max_concurrent_calls integer not null default 1 check (max_concurrent_calls between 1 and 100),
  recording_enabled boolean not null default false,
  recording_disclosure_required boolean not null default false,
  recording_consent_mode text not null default 'disabled' check (recording_consent_mode in ('disabled','one_party','all_party','explicit')),
  recording_retention_days integer check (recording_retention_days is null or recording_retention_days >= 0),
  ai_disclosure_mode text not null default 'configurable' check (ai_disclosure_mode in ('configurable','always','never')),
  transfer_enabled boolean not null default false,
  compliance_settings jsonb not null default '{}'::jsonb,
  cost_settings jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (calling_window_start <> calling_window_end),
  check (array_length(calling_days,1) is not null)
);

create table if not exists public.ai_campaign_instructions (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.ai_call_campaigns(id) on delete cascade,
  instruction_type text not null default 'guidance' check (instruction_type in ('objective','audience','opening','qualification','objection','closing','guidance')),
  title text not null,
  content text not null,
  priority integer not null default 100,
  enabled boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_company_knowledge (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  title text not null,
  content text not null,
  tags text[] not null default '{}'::text[],
  status text not null default 'draft' check (status in ('draft','verified','retired')),
  source_label text,
  source_url text,
  verified_by uuid references auth.users(id) on delete set null,
  verified_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status <> 'verified') or verified_at is not null)
);

create table if not exists public.ai_company_regulations (
  id uuid primary key default gen_random_uuid(),
  category text not null,
  title text not null,
  rule_text text not null,
  enforcement_level text not null default 'hard' check (enforcement_level in ('hard','required','advisory')),
  priority integer not null default 100,
  enabled boolean not null default true,
  rationale text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_call_attempts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.ai_call_campaigns(id) on delete restrict,
  prospect_record_id uuid not null references public.crm_records(id) on delete restrict,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  lead_timezone text,
  timezone_source text check (timezone_source is null or timezone_source in ('crm','phone_lookup','campaign','manual','inferred')),
  attempt_number integer not null check (attempt_number > 0),
  status text not null default 'queued' check (status in (
    'queued','claimed','initiating','ringing','connected','active_conversation',
    'completed','no_answer','voicemail','callback_requested','not_interested',
    'interested','qualified','appointment_booked','transferred','do_not_call',
    'invalid_number','provider_failed','agent_failed','cancelled'
  )),
  queue_available_at timestamptz not null default now(),
  lock_token uuid,
  locked_by text,
  locked_at timestamptz,
  lock_expires_at timestamptz,
  telephony_provider_slug text,
  provider_call_id text,
  provider_metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  ringing_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  connected_seconds integer check (connected_seconds is null or connected_seconds >= 0),
  failure_code text,
  failure_reason text,
  estimated_cost numeric(12,6) check (estimated_cost is null or estimated_cost >= 0),
  actual_cost numeric(12,6) check (actual_cost is null or actual_cost >= 0),
  cost_currency text not null default 'USD',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, prospect_record_id, attempt_number),
  check ((lock_token is null and locked_at is null and lock_expires_at is null) or
         (lock_token is not null and locked_at is not null and lock_expires_at is not null)),
  check (ended_at is null or started_at is null or ended_at >= started_at)
);

create table if not exists public.ai_call_events (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.ai_call_attempts(id) on delete cascade,
  event_type text not null,
  event_source text not null default 'system' check (event_source in ('system','provider','voice_worker','llm','tool','admin')),
  occurred_at timestamptz not null default now(),
  sequence_no bigint,
  provider_slug text,
  provider_event_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (attempt_id, sequence_no)
);

create table if not exists public.ai_provider_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider_kind text not null check (provider_kind in ('telephony','stt','llm','tts','calendar','storage')),
  provider_slug text not null,
  provider_event_id text not null,
  attempt_id uuid references public.ai_call_attempts(id) on delete set null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'received' check (processing_status in ('received','processing','processed','ignored','failed')),
  processing_error text,
  payload jsonb not null default '{}'::jsonb,
  unique (provider_slug, provider_event_id)
);

create table if not exists public.ai_transcript_segments (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.ai_call_attempts(id) on delete cascade,
  sequence_no integer not null check (sequence_no >= 0),
  speaker text not null check (speaker in ('prospect','agent','human','system','unknown')),
  start_ms integer not null check (start_ms >= 0),
  end_ms integer check (end_ms is null or end_ms >= start_ms),
  text text not null,
  is_final boolean not null default true,
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  provider_slug text,
  provider_segment_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (attempt_id, sequence_no)
);

create table if not exists public.ai_callbacks (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid references public.ai_call_campaigns(id) on delete set null,
  prospect_record_id uuid not null references public.crm_records(id) on delete restrict,
  originating_attempt_id uuid references public.ai_call_attempts(id) on delete set null,
  evidence_segment_id uuid references public.ai_transcript_segments(id) on delete set null,
  status text not null default 'scheduled' check (status in ('scheduled','due','claimed','completed','cancelled','superseded','failed')),
  requested_text text,
  scheduled_for timestamptz not null,
  scheduled_until timestamptz,
  lead_timezone text not null,
  timezone_source text check (timezone_source is null or timezone_source in ('crm','phone_lookup','campaign','manual','inferred')),
  clarification_needed boolean not null default false,
  context_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (scheduled_until is null or scheduled_until >= scheduled_for)
);

create table if not exists public.ai_suppressions (
  id uuid primary key default gen_random_uuid(),
  prospect_record_id uuid references public.crm_records(id) on delete restrict,
  phone_e164 text check (phone_e164 is null or phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  campaign_id uuid references public.ai_call_campaigns(id) on delete cascade,
  scope text not null default 'global' check (scope in ('global','campaign')),
  suppression_type text not null default 'do_not_call' check (suppression_type in ('do_not_call','manual','legal','invalid_number','temporary')),
  reason text,
  source_attempt_id uuid references public.ai_call_attempts(id) on delete set null,
  source_event_id uuid references public.ai_call_events(id) on delete set null,
  active boolean not null default true,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (prospect_record_id is not null or phone_e164 is not null),
  check ((scope = 'global' and campaign_id is null) or (scope = 'campaign' and campaign_id is not null)),
  check (expires_at is null or expires_at > starts_at)
);

create table if not exists public.ai_recordings (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references public.ai_call_attempts(id) on delete cascade,
  provider_slug text,
  provider_recording_id text,
  storage_provider_slug text,
  storage_key text,
  mime_type text,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  bytes bigint check (bytes is null or bytes >= 0),
  recording_status text not null default 'pending' check (recording_status in ('pending','recording','available','failed','not_permitted','deleted')),
  disclosure_required boolean not null default false,
  disclosure_completed boolean not null default false,
  disclosure_event_id uuid references public.ai_call_events(id) on delete set null,
  consent_required boolean not null default false,
  consent_status text not null default 'not_required' check (consent_status in ('not_required','pending','granted','denied','withdrawn')),
  consent_event_id uuid references public.ai_call_events(id) on delete set null,
  retention_until timestamptz,
  deletion_status text not null default 'retained' check (deletion_status in ('retained','scheduled','deleting','deleted','failed')),
  deletion_requested_at timestamptz,
  deleted_at timestamptz,
  deletion_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (attempt_id, provider_recording_id),
  check ((recording_status <> 'available') or provider_recording_id is not null or storage_key is not null),
  check ((deletion_status <> 'deleted') or deleted_at is not null)
);

create table if not exists public.ai_call_outcomes (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null unique references public.ai_call_attempts(id) on delete cascade,
  outcome text not null check (outcome in ('no_answer','voicemail','callback_requested','not_interested','interested','qualified','appointment_booked','transferred','do_not_call','invalid_number','failed','other')),
  summary text,
  interest_level text check (interest_level is null or interest_level in ('unknown','low','medium','high')),
  qualification_status text check (qualification_status is null or qualification_status in ('unknown','unqualified','partially_qualified','qualified')),
  objections jsonb not null default '[]'::jsonb,
  pain_points jsonb not null default '[]'::jsonb,
  important_facts jsonb not null default '[]'::jsonb,
  current_solution text,
  previous_experiences jsonb not null default '[]'::jsonb,
  goals jsonb not null default '[]'::jsonb,
  buying_motivations jsonb not null default '[]'::jsonb,
  concerns jsonb not null default '[]'::jsonb,
  questions jsonb not null default '[]'::jsonb,
  budget_context text,
  decision_context text,
  timeline_context text,
  requested_follow_up boolean not null default false,
  next_action text,
  appointment_status text check (appointment_status is null or appointment_status in ('none','requested','booked','failed','cancelled')),
  appointment_start_at timestamptz,
  appointment_timezone text,
  transfer_status text check (transfer_status is null or transfer_status in ('not_attempted','attempted','connected','failed')),
  extracted_by_provider_slug text,
  extracted_by_model text,
  extraction_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.ai_pre_call_briefs (
  id uuid primary key default gen_random_uuid(),
  prospect_record_id uuid not null references public.crm_records(id) on delete restrict,
  source_attempt_id uuid not null references public.ai_call_attempts(id) on delete restrict,
  version integer not null default 1 check (version > 0),
  status text not null default 'draft' check (status in ('draft','ready','superseded','invalidated')),
  headline text,
  executive_summary text,
  recommended_sales_angle text,
  appointment_start_at timestamptz,
  appointment_timezone text,
  generated_by_provider_slug text,
  generated_by_model text,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_attempt_id, version)
);

create table if not exists public.ai_pre_call_brief_facts (
  id uuid primary key default gen_random_uuid(),
  brief_id uuid not null references public.ai_pre_call_briefs(id) on delete cascade,
  category text not null,
  label text,
  value_text text not null,
  source_type text not null check (source_type in ('explicit','inferred','system')),
  confidence numeric(5,4) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  display_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.ai_pre_call_brief_fact_evidence (
  fact_id uuid not null references public.ai_pre_call_brief_facts(id) on delete cascade,
  transcript_segment_id uuid not null references public.ai_transcript_segments(id) on delete restrict,
  quote_start_char integer check (quote_start_char is null or quote_start_char >= 0),
  quote_end_char integer,
  created_at timestamptz not null default now(),
  primary key (fact_id, transcript_segment_id),
  check (quote_end_char is null or quote_start_char is null or quote_end_char >= quote_start_char)
);

-- Existing CRM prospect references must continue to point to Cold Call `stats` rows.
create trigger ai_call_attempts_assert_stats_prospect
before insert or update of prospect_record_id on public.ai_call_attempts
for each row execute function public.ai_assert_stats_prospect();

create trigger ai_callbacks_assert_stats_prospect
before insert or update of prospect_record_id on public.ai_callbacks
for each row execute function public.ai_assert_stats_prospect();

create trigger ai_suppressions_assert_stats_prospect
before insert or update of prospect_record_id on public.ai_suppressions
for each row when (new.prospect_record_id is not null)
execute function public.ai_assert_stats_prospect();

create trigger ai_pre_call_briefs_assert_stats_prospect
before insert or update of prospect_record_id on public.ai_pre_call_briefs
for each row execute function public.ai_assert_stats_prospect();

-- updated_at triggers
create trigger ai_provider_configs_set_updated_at before update on public.ai_provider_configs for each row execute function public.ai_set_updated_at();
create trigger ai_call_campaigns_set_updated_at before update on public.ai_call_campaigns for each row execute function public.ai_set_updated_at();
create trigger ai_campaign_instructions_set_updated_at before update on public.ai_campaign_instructions for each row execute function public.ai_set_updated_at();
create trigger ai_company_knowledge_set_updated_at before update on public.ai_company_knowledge for each row execute function public.ai_set_updated_at();
create trigger ai_company_regulations_set_updated_at before update on public.ai_company_regulations for each row execute function public.ai_set_updated_at();
create trigger ai_call_attempts_set_updated_at before update on public.ai_call_attempts for each row execute function public.ai_set_updated_at();
create trigger ai_callbacks_set_updated_at before update on public.ai_callbacks for each row execute function public.ai_set_updated_at();
create trigger ai_suppressions_set_updated_at before update on public.ai_suppressions for each row execute function public.ai_set_updated_at();
create trigger ai_recordings_set_updated_at before update on public.ai_recordings for each row execute function public.ai_set_updated_at();
create trigger ai_call_outcomes_set_updated_at before update on public.ai_call_outcomes for each row execute function public.ai_set_updated_at();
create trigger ai_pre_call_briefs_set_updated_at before update on public.ai_pre_call_briefs for each row execute function public.ai_set_updated_at();

-- Queue/concurrency indexes.
create index if not exists ai_call_attempts_queue_idx
  on public.ai_call_attempts(status, queue_available_at, created_at)
  where status in ('queued','claimed');
create index if not exists ai_call_attempts_campaign_status_idx on public.ai_call_attempts(campaign_id, status, created_at desc);
create index if not exists ai_call_attempts_prospect_idx on public.ai_call_attempts(prospect_record_id, created_at desc);
create index if not exists ai_call_attempts_phone_idx on public.ai_call_attempts(phone_e164, created_at desc);
create index if not exists ai_call_attempts_provider_call_idx on public.ai_call_attempts(telephony_provider_slug, provider_call_id) where provider_call_id is not null;
create unique index if not exists ai_call_attempts_provider_call_uniq on public.ai_call_attempts(telephony_provider_slug, provider_call_id) where provider_call_id is not null;
create unique index if not exists ai_call_attempts_one_active_prospect_uniq
  on public.ai_call_attempts(prospect_record_id)
  where status in ('queued','claimed','initiating','ringing','connected','active_conversation');
create unique index if not exists ai_call_attempts_one_active_phone_uniq
  on public.ai_call_attempts(phone_e164)
  where status in ('claimed','initiating','ringing','connected','active_conversation');

-- Lifecycle, webhook idempotency and analytics indexes.
create index if not exists ai_call_events_attempt_time_idx on public.ai_call_events(attempt_id, occurred_at, created_at);
create unique index if not exists ai_call_events_provider_event_uniq on public.ai_call_events(provider_slug, provider_event_id) where provider_event_id is not null;
create index if not exists ai_provider_webhook_events_attempt_idx on public.ai_provider_webhook_events(attempt_id, received_at desc);
create index if not exists ai_provider_webhook_events_status_idx on public.ai_provider_webhook_events(processing_status, received_at);
create index if not exists ai_transcript_segments_attempt_time_idx on public.ai_transcript_segments(attempt_id, start_ms, sequence_no);
create index if not exists ai_transcript_segments_provider_idx on public.ai_transcript_segments(provider_slug, provider_segment_id) where provider_segment_id is not null;
create index if not exists ai_callbacks_due_idx on public.ai_callbacks(status, scheduled_for) where status in ('scheduled','due');
create index if not exists ai_callbacks_prospect_idx on public.ai_callbacks(prospect_record_id, scheduled_for desc);
create unique index if not exists ai_callbacks_one_open_per_prospect_uniq on public.ai_callbacks(prospect_record_id) where status in ('scheduled','due','claimed');
create index if not exists ai_suppressions_prospect_idx on public.ai_suppressions(prospect_record_id) where active;
create index if not exists ai_suppressions_phone_idx on public.ai_suppressions(phone_e164) where active;
create index if not exists ai_suppressions_expiry_idx on public.ai_suppressions(expires_at) where active and expires_at is not null;
create unique index if not exists ai_suppressions_global_prospect_uniq on public.ai_suppressions(prospect_record_id, suppression_type) where active and scope='global' and prospect_record_id is not null;
create unique index if not exists ai_suppressions_global_phone_uniq on public.ai_suppressions(phone_e164, suppression_type) where active and scope='global' and phone_e164 is not null;
create index if not exists ai_recordings_attempt_idx on public.ai_recordings(attempt_id, created_at desc);
create index if not exists ai_recordings_retention_idx on public.ai_recordings(retention_until) where deletion_status in ('retained','scheduled') and retention_until is not null;
create index if not exists ai_call_outcomes_outcome_idx on public.ai_call_outcomes(outcome, created_at desc);
create index if not exists ai_call_outcomes_qualification_idx on public.ai_call_outcomes(qualification_status, created_at desc);
create index if not exists ai_pre_call_briefs_prospect_idx on public.ai_pre_call_briefs(prospect_record_id, generated_at desc);
create index if not exists ai_pre_call_briefs_status_idx on public.ai_pre_call_briefs(status, appointment_start_at);
create index if not exists ai_pre_call_brief_facts_brief_idx on public.ai_pre_call_brief_facts(brief_id, display_order);
create index if not exists ai_pre_call_brief_fact_evidence_segment_idx on public.ai_pre_call_brief_fact_evidence(transcript_segment_id);
create index if not exists ai_campaign_instructions_campaign_idx on public.ai_campaign_instructions(campaign_id, enabled, priority);
create index if not exists ai_company_knowledge_status_idx on public.ai_company_knowledge(status, category);
create index if not exists ai_company_knowledge_tags_gin_idx on public.ai_company_knowledge using gin(tags);
create index if not exists ai_company_knowledge_search_idx on public.ai_company_knowledge using gin(to_tsvector('english', coalesce(title,'') || ' ' || coalesce(content,'')));
create index if not exists ai_company_regulations_enabled_idx on public.ai_company_regulations(enabled, enforcement_level, priority);

-- Atomic queue claim. Server-side workers should call this through a trusted service-role path.
create or replace function public.ai_claim_next_call_attempt(
  p_worker_id text,
  p_lease_seconds integer default 120,
  p_campaign_id uuid default null
)
returns public.ai_call_attempts
language plpgsql
security definer
set search_path = public
as $$
declare
  claimed public.ai_call_attempts;
begin
  if coalesce(length(trim(p_worker_id)),0) = 0 then
    raise exception 'worker id is required';
  end if;
  if p_lease_seconds < 15 or p_lease_seconds > 3600 then
    raise exception 'lease seconds must be between 15 and 3600';
  end if;

  with candidate as (
    select a.id
    from public.ai_call_attempts a
    join public.ai_call_campaigns c on c.id = a.campaign_id
    where c.enabled = true
      and c.status = 'active'
      and (p_campaign_id is null or a.campaign_id = p_campaign_id)
      and a.queue_available_at <= now()
      and (
        a.status = 'queued'
        or (a.status = 'claimed' and a.lock_expires_at < now())
      )
      and not exists (
        select 1
        from public.ai_suppressions s
        where s.active = true
          and s.starts_at <= now()
          and (s.expires_at is null or s.expires_at > now())
          and (s.prospect_record_id = a.prospect_record_id or s.phone_e164 = a.phone_e164)
          and (s.scope = 'global' or s.campaign_id = a.campaign_id)
      )
      and not exists (
        select 1
        from public.ai_callbacks cb
        where cb.prospect_record_id = a.prospect_record_id
          and cb.status in ('scheduled','due','claimed')
          and cb.scheduled_for > now()
      )
    order by a.queue_available_at asc, a.created_at asc
    for update of a skip locked
    limit 1
  )
  update public.ai_call_attempts a
  set status = 'claimed',
      lock_token = gen_random_uuid(),
      locked_by = p_worker_id,
      locked_at = now(),
      lock_expires_at = now() + make_interval(secs => p_lease_seconds),
      updated_at = now()
  from candidate
  where a.id = candidate.id
  returning a.* into claimed;

  return claimed;
end;
$$;

revoke all on function public.ai_claim_next_call_attempt(text, integer, uuid) from public;
revoke all on function public.ai_claim_next_call_attempt(text, integer, uuid) from anon;
revoke all on function public.ai_claim_next_call_attempt(text, integer, uuid) from authenticated;
grant execute on function public.ai_claim_next_call_attempt(text, integer, uuid) to service_role;

-- RLS: browser users never receive implicit access. Admins can configure/read AI data;
-- operational writes are intended to go through trusted server-side service-role code.
alter table public.ai_provider_configs enable row level security;
alter table public.ai_call_campaigns enable row level security;
alter table public.ai_campaign_instructions enable row level security;
alter table public.ai_company_knowledge enable row level security;
alter table public.ai_company_regulations enable row level security;
alter table public.ai_call_attempts enable row level security;
alter table public.ai_call_events enable row level security;
alter table public.ai_provider_webhook_events enable row level security;
alter table public.ai_transcript_segments enable row level security;
alter table public.ai_callbacks enable row level security;
alter table public.ai_suppressions enable row level security;
alter table public.ai_recordings enable row level security;
alter table public.ai_call_outcomes enable row level security;
alter table public.ai_pre_call_briefs enable row level security;
alter table public.ai_pre_call_brief_facts enable row level security;
alter table public.ai_pre_call_brief_fact_evidence enable row level security;

-- Admin-managed configuration tables.
create policy "Admins manage AI provider configs" on public.ai_provider_configs for all to authenticated using (public.ai_current_role()='admin') with check (public.ai_current_role()='admin');
create policy "Admins manage AI campaigns" on public.ai_call_campaigns for all to authenticated using (public.ai_current_role()='admin') with check (public.ai_current_role()='admin');
create policy "Admins manage AI campaign instructions" on public.ai_campaign_instructions for all to authenticated using (public.ai_current_role()='admin') with check (public.ai_current_role()='admin');
create policy "Admins manage AI company knowledge" on public.ai_company_knowledge for all to authenticated using (public.ai_current_role()='admin') with check (public.ai_current_role()='admin');
create policy "Admins manage AI company regulations" on public.ai_company_regulations for all to authenticated using (public.ai_current_role()='admin') with check (public.ai_current_role()='admin');
create policy "Admins manage AI callbacks" on public.ai_callbacks for all to authenticated using (public.ai_current_role()='admin') with check (public.ai_current_role()='admin');
create policy "Admins manage AI suppressions" on public.ai_suppressions for all to authenticated using (public.ai_current_role()='admin') with check (public.ai_current_role()='admin');

-- Operational tables are admin-readable from the CRM; writes belong to trusted server processes.
create policy "Admins read AI call attempts" on public.ai_call_attempts for select to authenticated using (public.ai_current_role()='admin');
create policy "Admins read AI call events" on public.ai_call_events for select to authenticated using (public.ai_current_role()='admin');
create policy "Admins read AI webhook events" on public.ai_provider_webhook_events for select to authenticated using (public.ai_current_role()='admin');
create policy "Admins read AI transcript segments" on public.ai_transcript_segments for select to authenticated using (public.ai_current_role()='admin');
create policy "Admins read AI recordings" on public.ai_recordings for select to authenticated using (public.ai_current_role()='admin');
create policy "Admins read AI call outcomes" on public.ai_call_outcomes for select to authenticated using (public.ai_current_role()='admin');
create policy "Admins read AI pre call briefs" on public.ai_pre_call_briefs for select to authenticated using (public.ai_current_role()='admin');
create policy "Admins read AI pre call brief facts" on public.ai_pre_call_brief_facts for select to authenticated using (public.ai_current_role()='admin');
create policy "Admins read AI brief evidence" on public.ai_pre_call_brief_fact_evidence for select to authenticated using (public.ai_current_role()='admin');

-- No direct anon privileges. RLS is defense-in-depth; service_role bypasses RLS server-side.
revoke all on table public.ai_provider_configs from anon;
revoke all on table public.ai_call_campaigns from anon;
revoke all on table public.ai_campaign_instructions from anon;
revoke all on table public.ai_company_knowledge from anon;
revoke all on table public.ai_company_regulations from anon;
revoke all on table public.ai_call_attempts from anon;
revoke all on table public.ai_call_events from anon;
revoke all on table public.ai_provider_webhook_events from anon;
revoke all on table public.ai_transcript_segments from anon;
revoke all on table public.ai_callbacks from anon;
revoke all on table public.ai_suppressions from anon;
revoke all on table public.ai_recordings from anon;
revoke all on table public.ai_call_outcomes from anon;
revoke all on table public.ai_pre_call_briefs from anon;
revoke all on table public.ai_pre_call_brief_facts from anon;
revoke all on table public.ai_pre_call_brief_fact_evidence from anon;

-- Explicit authenticated grants allow RLS policies to decide browser access.
grant select, insert, update, delete on public.ai_provider_configs to authenticated;
grant select, insert, update, delete on public.ai_call_campaigns to authenticated;
grant select, insert, update, delete on public.ai_campaign_instructions to authenticated;
grant select, insert, update, delete on public.ai_company_knowledge to authenticated;
grant select, insert, update, delete on public.ai_company_regulations to authenticated;
grant select on public.ai_call_attempts to authenticated;
grant select on public.ai_call_events to authenticated;
grant select on public.ai_provider_webhook_events to authenticated;
grant select on public.ai_transcript_segments to authenticated;
grant select, insert, update, delete on public.ai_callbacks to authenticated;
grant select, insert, update, delete on public.ai_suppressions to authenticated;
grant select on public.ai_recordings to authenticated;
grant select on public.ai_call_outcomes to authenticated;
grant select on public.ai_pre_call_briefs to authenticated;
grant select on public.ai_pre_call_brief_facts to authenticated;
grant select on public.ai_pre_call_brief_fact_evidence to authenticated;

-- Service-role worker/API access.
grant all on public.ai_provider_configs to service_role;
grant all on public.ai_call_campaigns to service_role;
grant all on public.ai_campaign_instructions to service_role;
grant all on public.ai_company_knowledge to service_role;
grant all on public.ai_company_regulations to service_role;
grant all on public.ai_call_attempts to service_role;
grant all on public.ai_call_events to service_role;
grant all on public.ai_provider_webhook_events to service_role;
grant all on public.ai_transcript_segments to service_role;
grant all on public.ai_callbacks to service_role;
grant all on public.ai_suppressions to service_role;
grant all on public.ai_recordings to service_role;
grant all on public.ai_call_outcomes to service_role;
grant all on public.ai_pre_call_briefs to service_role;
grant all on public.ai_pre_call_brief_facts to service_role;
grant all on public.ai_pre_call_brief_fact_evidence to service_role;

commit;
