-- Phase 5: server/database authoritative eligibility engine and queue population.
-- No telephony calls are placed by this migration.
begin;

alter table public.ai_call_campaigns
  add column if not exists max_calls_total integer check (max_calls_total is null or max_calls_total > 0);

create or replace function public.ai_normalize_phone(p_phone text)
returns text language plpgsql immutable as $$
declare v text;
begin
  v := regexp_replace(coalesce(p_phone,''), '[^0-9+]', '', 'g');
  if v like '00%' then v := '+' || substr(v,3); end if;
  if v ~ '^\+[1-9][0-9]{7,14}$' then return v; end if;
  return null;
end;$$;

create or replace function public.ai_valid_timezone(p_tz text)
returns boolean language sql stable as $$
  select exists(select 1 from pg_timezone_names where name = p_tz);
$$;

create or replace function public.ai_effective_timezone(p_campaign public.ai_call_campaigns, p_payload jsonb)
returns text language plpgsql stable as $$
declare tz text;
begin
  if p_campaign.timezone_strategy='fixed' then
    tz := nullif(trim(p_campaign.fixed_timezone),'');
  else
    tz := coalesce(nullif(trim(p_payload->>'lead_timezone'),''), nullif(trim(p_payload->>'timezone'),''), nullif(trim(p_payload->>'time_zone'),''));
  end if;
  if tz is not null and public.ai_valid_timezone(tz) then return tz; end if;
  return null;
end;$$;

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
  attempts_count int; last_attempt timestamptz; active_campaign int; active_phone int;
  daily_calls int; total_calls int; connected_seconds_total bigint; daily_spend numeric; total_spend numeric;
  daily_limit numeric; total_spend_limit numeric;
  terminal_status text;
  reason text := 'eligible';
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
  if found and open_cb.scheduled_for>p_at then
    return jsonb_build_object('eligible',false,'reason_code','callback_scheduled','callback_id',open_cb.id,'scheduled_for',open_cb.scheduled_for,'lead_timezone',open_cb.lead_timezone);
  end if;

  tz := case when found and open_cb.lead_timezone is not null and public.ai_valid_timezone(open_cb.lead_timezone) then open_cb.lead_timezone else public.ai_effective_timezone(c,r.payload) end;
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

  select count(*), max(coalesce(ended_at,started_at,created_at)) into attempts_count,last_attempt
  from public.ai_call_attempts where campaign_id=c.id and prospect_record_id=r.id;
  if attempts_count>=c.max_attempts_per_prospect then return jsonb_build_object('eligible',false,'reason_code','attempt_limit_reached','attempts',attempts_count); end if;
  if last_attempt is not null and p_at < last_attempt + make_interval(mins=>c.min_retry_delay_minutes) then
    return jsonb_build_object('eligible',false,'reason_code','retry_cooldown','retry_after',last_attempt + make_interval(mins=>c.min_retry_delay_minutes));
  end if;

  if exists(select 1 from public.ai_call_attempts where prospect_record_id=r.id and status in ('queued','claimed','initiating','ringing','connected','active_conversation')) then
    return jsonb_build_object('eligible',false,'reason_code','prospect_already_queued_or_active');
  end if;
  select count(*) into active_phone from public.ai_call_attempts where phone_e164=phone and status in ('claimed','initiating','ringing','connected','active_conversation');
  if active_phone>0 then return jsonb_build_object('eligible',false,'reason_code','phone_already_active','phone_e164',phone); end if;

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
    'timezone_source',case when found then 'callback' when c.timezone_strategy='fixed' then 'campaign' else 'crm' end,
    'attempt_number',attempts_count+1,'callback_due',found,'callback_id',case when found then open_cb.id else null end,
    'local_time',local_ts,'daily_calls',daily_calls,'total_calls',total_calls,'active_calls',active_campaign,
    'connected_seconds_today',connected_seconds_total,'daily_spend',daily_spend,'campaign_spend',total_spend
  );
  return details;
end;$$;

create or replace function public.ai_preview_campaign_eligibility(
  p_campaign_id uuid,
  p_limit integer default 5000,
  p_at timestamptz default now()
) returns table(prospect_record_id uuid, eligible boolean, reason_code text, details jsonb)
language sql security definer set search_path=public as $$
  select r.id,
         coalesce((e.result->>'eligible')::boolean,false),
         e.result->>'reason_code',
         e.result
  from public.crm_records r
  cross join lateral (select public.ai_evaluate_call_eligibility(p_campaign_id,r.id,p_at) result) e
  where r.type='stats' and coalesce((r.payload->>'deleted')::boolean,false)=false
  order by r.created_at asc
  limit greatest(1,least(p_limit,10000));
$$;

create or replace function public.ai_queue_campaign_eligible(
  p_campaign_id uuid,
  p_limit integer default 100,
  p_at timestamptz default now()
) returns table(prospect_record_id uuid, queued boolean, attempt_id uuid, reason_code text, details jsonb)
language plpgsql security definer set search_path=public as $$
declare r record; e jsonb; new_id uuid; n int:=0;
begin
  for r in select id from public.crm_records where type='stats' and coalesce((payload->>'deleted')::boolean,false)=false order by created_at asc loop
    exit when n>=greatest(1,least(p_limit,1000));
    perform 1 from public.crm_records where id=r.id for update;
    e := public.ai_evaluate_call_eligibility(p_campaign_id,r.id,p_at);
    if coalesce((e->>'eligible')::boolean,false) then
      begin
        insert into public.ai_call_attempts(campaign_id,prospect_record_id,phone_e164,lead_timezone,timezone_source,attempt_number,status,queue_available_at,
          telephony_provider_slug,provider_metadata)
        select c.id,r.id,e->>'phone_e164',e->>'lead_timezone',case when e->>'timezone_source'='callback' then 'manual' when e->>'timezone_source'='campaign' then 'campaign' else 'crm' end,
          (e->>'attempt_number')::int,'queued',p_at,c.telephony_provider_slug,jsonb_build_object('eligibility_snapshot',e)
        from public.ai_call_campaigns c where c.id=p_campaign_id returning id into new_id;
        n:=n+1;
        prospect_record_id:=r.id;queued:=true;attempt_id:=new_id;reason_code:='queued';details:=e;return next;
      exception when unique_violation then
        prospect_record_id:=r.id;queued:=false;attempt_id:=null;reason_code:='duplicate_race_prevented';details:=e;return next;
      end;
    end if;
  end loop;
end;$$;

create or replace function public.ai_campaign_queue_stats(p_campaign_id uuid, p_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path=public as $$
declare v jsonb; q int; active int;
begin
  select coalesce(jsonb_object_agg(reason_code,cnt),'{}'::jsonb) into v from (
    select reason_code,count(*) cnt from public.ai_preview_campaign_eligibility(p_campaign_id,10000,p_at) group by reason_code
  ) s;
  select count(*) into q from public.ai_call_attempts where campaign_id=p_campaign_id and status='queued';
  select count(*) into active from public.ai_call_attempts where campaign_id=p_campaign_id and status in ('claimed','initiating','ringing','connected','active_conversation');
  return jsonb_build_object('reasons',v,'queued',q,'active',active);
end;$$;

revoke all on function public.ai_evaluate_call_eligibility(uuid,uuid,timestamptz) from public,anon,authenticated;
revoke all on function public.ai_preview_campaign_eligibility(uuid,integer,timestamptz) from public,anon,authenticated;
revoke all on function public.ai_queue_campaign_eligible(uuid,integer,timestamptz) from public,anon,authenticated;
revoke all on function public.ai_campaign_queue_stats(uuid,timestamptz) from public,anon,authenticated;
grant execute on function public.ai_evaluate_call_eligibility(uuid,uuid,timestamptz) to service_role;
grant execute on function public.ai_preview_campaign_eligibility(uuid,integer,timestamptz) to service_role;
grant execute on function public.ai_queue_campaign_eligible(uuid,integer,timestamptz) to service_role;
grant execute on function public.ai_campaign_queue_stats(uuid,timestamptz) to service_role;

commit;