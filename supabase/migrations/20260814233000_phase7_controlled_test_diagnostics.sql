-- Phase 7 controlled-test diagnostics and attempt accounting correction.
-- Additive/replacement-only: does not originate calls, alter queue workers, or weaken Phase 5 safeguards.
begin;

-- Phase 5 predates the Phase 6 controlled_test flag. Diagnostic controlled calls must not
-- consume a prospect's normal campaign attempt limit or retry cooldown. They still count
-- toward real resource limits (daily calls, concurrency, connected minutes and spend).
create or replace function public.ai_evaluate_call_eligibility(
  p_campaign_id uuid,
  p_prospect_record_id uuid,
  p_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  c public.ai_call_campaigns;
  r public.crm_records;
  phone text; tz text; local_ts timestamp; local_day int; local_time time;
  open_cb public.ai_callbacks;
  attempts_count int; next_attempt_no int; last_attempt timestamptz; active_campaign int; active_phone int;
  daily_calls int; total_calls int; connected_seconds_total bigint; daily_spend numeric; total_spend numeric;
  daily_limit numeric; total_spend_limit numeric;
  terminal_status text; callback_due boolean := false;
  details jsonb := '{}'::jsonb;
begin
  select * into c from public.ai_call_campaigns where id=p_campaign_id;
  if not found then return jsonb_build_object('eligible',false,'reason_code','campaign_not_found'); end if;
  if not c.enabled then return jsonb_build_object('eligible',false,'reason_code','campaign_disabled'); end if;
  if c.status <> 'active' then return jsonb_build_object('eligible',false,'reason_code','campaign_not_active','status',c.status); end if;

  select * into r from public.crm_records where id=p_prospect_record_id;
  if not found then return jsonb_build_object('eligible',false,'reason_code','prospect_not_found'); end if;
  if r.type <> 'stats' then return jsonb_build_object('eligible',false,'reason_code','not_stats_prospect'); end if;
  if coalesce((r.payload->>'deleted')::boolean,false) then return jsonb_build_object('eligible',false,'reason_code','prospect_deleted'); end if;

  terminal_status := lower(coalesce(r.payload->>'status',''));
  if terminal_status in ('booked') then
    return jsonb_build_object('eligible',false,'reason_code','terminal_status','cold_call_status',terminal_status);
  end if;

  if nullif(trim(r.payload->>'phone'),'') is null then return jsonb_build_object('eligible',false,'reason_code','phone_missing'); end if;
  phone := public.ai_normalize_phone(r.payload->>'phone');
  if phone is null then return jsonb_build_object('eligible',false,'reason_code','phone_invalid_or_ambiguous','raw_phone',r.payload->>'phone'); end if;

  if exists(select 1 from public.ai_suppressions s where s.active and s.starts_at<=p_at and (s.expires_at is null or s.expires_at>p_at)
    and (s.prospect_record_id=r.id or s.phone_e164=phone)
    and (s.scope='global' or (s.scope='campaign' and s.campaign_id=c.id))) then
    return jsonb_build_object('eligible',false,'reason_code','suppressed_or_dnc','phone_e164',phone);
  end if;

  select * into open_cb from public.ai_callbacks cb
   where cb.prospect_record_id=r.id and cb.status in ('scheduled','due','claimed')
     and (cb.campaign_id is null or cb.campaign_id=c.id)
   order by cb.scheduled_for asc limit 1;
  callback_due := found;
  if callback_due and open_cb.scheduled_for>p_at then
    return jsonb_build_object('eligible',false,'reason_code','callback_scheduled','callback_id',open_cb.id,'scheduled_for',open_cb.scheduled_for,'lead_timezone',open_cb.lead_timezone);
  end if;

  tz := case when callback_due and open_cb.lead_timezone is not null and public.ai_valid_timezone(open_cb.lead_timezone) then open_cb.lead_timezone else public.ai_effective_timezone(c,r.payload) end;
  if tz is null then return jsonb_build_object('eligible',false,'reason_code','timezone_unresolved','phone_e164',phone); end if;
  local_ts := p_at at time zone tz;
  local_day := extract(dow from local_ts)::int;
  local_time := local_ts::time;
  if not (local_day = any(c.calling_days)) then return jsonb_build_object('eligible',false,'reason_code','calling_day_not_allowed','lead_timezone',tz,'local_time',local_ts); end if;
  if c.calling_window_start < c.calling_window_end then
    if not (local_time>=c.calling_window_start and local_time<c.calling_window_end) then return jsonb_build_object('eligible',false,'reason_code','outside_calling_window','lead_timezone',tz,'local_time',local_ts); end if;
  else
    if not (local_time>=c.calling_window_start or local_time<c.calling_window_end) then return jsonb_build_object('eligible',false,'reason_code','outside_calling_window','lead_timezone',tz,'local_time',local_ts); end if;
  end if;

  if exists(select 1 from public.ai_call_attempts where prospect_record_id=r.id and status in ('queued','claimed','initiating','ringing','connected','active_conversation')) then
    return jsonb_build_object('eligible',false,'reason_code','prospect_already_queued_or_active');
  end if;
  select count(*) into active_phone from public.ai_call_attempts where phone_e164=phone and status in ('claimed','initiating','ringing','connected','active_conversation');
  if active_phone>0 then return jsonb_build_object('eligible',false,'reason_code','phone_already_active','phone_e164',phone); end if;

  -- Only normal campaign attempts consume attempt/cooldown policy. Controlled diagnostics
  -- are real calls, but they are not campaign retry attempts.
  select count(*), max(coalesce(ended_at,started_at,created_at)) into attempts_count,last_attempt
  from public.ai_call_attempts where campaign_id=c.id and prospect_record_id=r.id and not controlled_test;
  select coalesce(max(attempt_number),0)+1 into next_attempt_no
  from public.ai_call_attempts where campaign_id=c.id and prospect_record_id=r.id;
  if attempts_count>=c.max_attempts_per_prospect then return jsonb_build_object('eligible',false,'reason_code','attempt_limit_reached','attempts',attempts_count); end if;
  if last_attempt is not null and p_at < last_attempt + make_interval(mins=>c.min_retry_delay_minutes) then
    return jsonb_build_object('eligible',false,'reason_code','retry_cooldown','retry_after',last_attempt + make_interval(mins=>c.min_retry_delay_minutes));
  end if;

  select count(*) into active_campaign from public.ai_call_attempts where campaign_id=c.id and status in ('claimed','initiating','ringing','connected','active_conversation');
  if active_campaign>=c.max_concurrent_calls then return jsonb_build_object('eligible',false,'reason_code','concurrency_limit_reached','active_calls',active_campaign); end if;

  select count(*), coalesce(sum(connected_seconds),0), coalesce(sum(coalesce(actual_cost,estimated_cost,0)),0)
    into daily_calls,connected_seconds_total,daily_spend
  from public.ai_call_attempts a where a.campaign_id=c.id and ((a.created_at at time zone tz)::date = local_ts::date);
  if daily_calls>=c.max_calls_per_day then return jsonb_build_object('eligible',false,'reason_code','daily_call_limit_reached','daily_calls',daily_calls); end if;
  if connected_seconds_total >= c.max_connected_minutes_per_day*60 then return jsonb_build_object('eligible',false,'reason_code','daily_connected_minutes_limit_reached','connected_seconds',connected_seconds_total); end if;

  select count(*),coalesce(sum(coalesce(actual_cost,estimated_cost,0)),0) into total_calls,total_spend from public.ai_call_attempts where campaign_id=c.id;
  if c.max_calls_total is not null and total_calls>=c.max_calls_total then return jsonb_build_object('eligible',false,'reason_code','campaign_call_limit_reached','total_calls',total_calls); end if;

  begin daily_limit := nullif(c.cost_settings->>'max_daily_spend','')::numeric; exception when others then daily_limit := null; end;
  begin total_spend_limit := nullif(c.cost_settings->>'max_campaign_spend','')::numeric; exception when others then total_spend_limit := null; end;
  if daily_limit is not null and daily_spend>=daily_limit then return jsonb_build_object('eligible',false,'reason_code','daily_spend_limit_reached','daily_spend',daily_spend); end if;
  if total_spend_limit is not null and total_spend>=total_spend_limit then return jsonb_build_object('eligible',false,'reason_code','campaign_spend_limit_reached','campaign_spend',total_spend); end if;

  details := jsonb_build_object(
    'eligible',true,'reason_code','eligible','phone_e164',phone,'lead_timezone',tz,
    'timezone_source',case when callback_due then 'callback' when c.timezone_strategy='fixed' then 'campaign' else 'crm' end,
    'attempt_number',next_attempt_no,'normal_attempts',attempts_count,'callback_due',callback_due,'callback_id',case when callback_due then open_cb.id else null end,
    'local_time',local_ts,'daily_calls',daily_calls,'total_calls',total_calls,'active_calls',active_campaign,
    'connected_seconds_today',connected_seconds_total,'daily_spend',daily_spend,'campaign_spend',total_spend
  );
  return details;
end;$$;

-- Safe, read-only diagnostic RPC for the admin controlled-test endpoint.
create or replace function public.ai_controlled_test_diagnostics(
  p_campaign_id uuid,
  p_phone_e164 text,
  p_at timestamptz default now()
) returns jsonb
language plpgsql
security definer
set search_path=public
as $$
declare
  c public.ai_call_campaigns; r public.crm_records; matches int; elig jsonb; tz text; local_ts timestamp;
  normal_attempts int; controlled_attempts int; total_attempts int; last_normal timestamptz; retry_after timestamptz;
begin
  if p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' then return jsonb_build_object('eligible',false,'reason_code','invalid_e164'); end if;
  select * into c from public.ai_call_campaigns where id=p_campaign_id;
  if not found then return jsonb_build_object('eligible',false,'reason_code','campaign_not_found'); end if;
  select count(*) into matches from public.crm_records x where x.type='stats' and coalesce((x.payload->>'deleted')::boolean,false)=false and public.ai_normalize_phone(x.payload->>'phone')=p_phone_e164;
  if matches=0 then return jsonb_build_object('eligible',false,'reason_code','stats_prospect_not_found'); end if;
  if matches>1 then return jsonb_build_object('eligible',false,'reason_code','ambiguous_stats_prospect_match','matches',matches); end if;
  select * into r from public.crm_records x where x.type='stats' and coalesce((x.payload->>'deleted')::boolean,false)=false and public.ai_normalize_phone(x.payload->>'phone')=p_phone_e164 limit 1;
  elig:=public.ai_evaluate_call_eligibility(c.id,r.id,p_at);
  tz:=public.ai_effective_timezone(c,r.payload);
  if tz is not null then local_ts:=p_at at time zone tz; end if;
  select count(*) filter(where not controlled_test),count(*) filter(where controlled_test),count(*),max(coalesce(ended_at,started_at,created_at)) filter(where not controlled_test)
    into normal_attempts,controlled_attempts,total_attempts,last_normal
  from public.ai_call_attempts where campaign_id=c.id and prospect_record_id=r.id;
  retry_after:=case when last_normal is null then null else last_normal+make_interval(mins=>c.min_retry_delay_minutes) end;
  return jsonb_build_object(
    'eligible',coalesce((elig->>'eligible')::boolean,false),
    'reason_code',coalesce(elig->>'reason_code','unknown'),
    'eligibility',elig,
    'prospect_record_id',r.id,
    'phone_e164',p_phone_e164,
    'lead_timezone',tz,
    'lead_local_time',local_ts,
    'timezone_strategy',c.timezone_strategy,
    'calling_days',c.calling_days,
    'calling_window_start',c.calling_window_start,
    'calling_window_end',c.calling_window_end,
    'normal_attempts',normal_attempts,
    'controlled_attempts',controlled_attempts,
    'total_attempts',total_attempts,
    'max_attempts',c.max_attempts_per_prospect,
    'retry_minutes',c.min_retry_delay_minutes,
    'retry_after',retry_after,
    'active_campaign_calls',(select count(*) from public.ai_call_attempts a where a.campaign_id=c.id and a.status in ('claimed','initiating','ringing','connected','active_conversation')),
    'active_or_queued_for_prospect',(select count(*) from public.ai_call_attempts a where a.prospect_record_id=r.id and a.status in ('queued','claimed','initiating','ringing','connected','active_conversation'))
  );
end;$$;

revoke all on function public.ai_controlled_test_diagnostics(uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.ai_controlled_test_diagnostics(uuid,text,timestamptz) to service_role;

commit;
