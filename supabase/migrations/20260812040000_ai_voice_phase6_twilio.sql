-- Phase 6: Twilio telephony state, controlled-test safeguards, webhook/cost state.
-- Additive only. This migration NEVER originates a phone call.
begin;

alter table public.ai_call_attempts
  add column if not exists provider_status text,
  add column if not exists provider_sequence_no bigint,
  add column if not exists provider_from_e164 text check (provider_from_e164 is null or provider_from_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  add column if not exists provider_to_e164 text check (provider_to_e164 is null or provider_to_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  add column if not exists initiated_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists cost_status text not null default 'pending'
    check (cost_status in ('pending','reconciled','failed','unavailable')),
  add column if not exists cost_reconcile_attempts integer not null default 0 check (cost_reconcile_attempts >= 0),
  add column if not exists cost_last_checked_at timestamptz,
  add column if not exists cost_reconcile_error text,
  add column if not exists controlled_test boolean not null default false,
  add column if not exists origin_request_key text;

alter table public.ai_call_attempts drop constraint if exists ai_call_attempts_status_check;
alter table public.ai_call_attempts add constraint ai_call_attempts_status_check check (status in (
  'queued','claimed','initiating','ringing','connected','active_conversation',
  'completed','busy','no_answer','voicemail','callback_requested','not_interested',
  'interested','qualified','appointment_booked','transferred','do_not_call',
  'invalid_number','provider_failed','provider_rejected','provider_auth_error','provider_network_error',
  'agent_failed','cancelled'
));

create unique index if not exists ai_call_attempts_provider_call_unique
  on public.ai_call_attempts(telephony_provider_slug,provider_call_id)
  where provider_call_id is not null;
create unique index if not exists ai_call_attempts_origin_request_unique
  on public.ai_call_attempts(origin_request_key) where origin_request_key is not null;
create unique index if not exists ai_call_events_provider_event_unique
  on public.ai_call_events(provider_slug,provider_event_id)
  where provider_slug is not null and provider_event_id is not null;

-- Serialize the controlled-test reservation globally. This is intentionally NOT a campaign queue consumer.
create or replace function public.ai_reserve_controlled_test_attempt(
 p_campaign_id uuid,p_phone_e164 text,p_request_key text,p_rate_limit_seconds integer default 60
) returns jsonb language plpgsql security definer set search_path=public as $$
declare c public.ai_call_campaigns; existing public.ai_call_attempts; prospect_id uuid; prospect_count int; attempt_no int; new_id uuid; elig jsonb;
begin
 if p_phone_e164 !~ '^\+[1-9][0-9]{7,14}$' then return jsonb_build_object('reserved',false,'reason','invalid_e164'); end if;
 if p_request_key !~ '^[A-Za-z0-9_-]{16,100}$' then return jsonb_build_object('reserved',false,'reason','invalid_request_key'); end if;
 if p_rate_limit_seconds < 30 or p_rate_limit_seconds > 3600 then raise exception 'invalid rate limit'; end if;
 perform pg_advisory_xact_lock(hashtextextended('adlift_phase6_controlled_test',0));
 select * into existing from public.ai_call_attempts where origin_request_key=p_request_key;
 if found then return jsonb_build_object('reserved',true,'duplicate',true,'attempt_id',existing.id,'provider_call_id',existing.provider_call_id,'status',existing.status,'initiated_at',existing.initiated_at); end if;
 select * into c from public.ai_call_campaigns where id=p_campaign_id;
 if not found then return jsonb_build_object('reserved',false,'reason','campaign_not_found'); end if;
 if not c.enabled or c.status<>'active' then return jsonb_build_object('reserved',false,'reason','campaign_not_active'); end if;
 if c.telephony_provider_slug is distinct from 'twilio' then return jsonb_build_object('reserved',false,'reason','campaign_not_twilio'); end if;
 if exists(select 1 from public.ai_call_attempts where controlled_test and status in ('queued','claimed','initiating','ringing','connected','active_conversation')) then
   return jsonb_build_object('reserved',false,'reason','active_controlled_test_exists');
 end if;
 if exists(select 1 from public.ai_call_attempts where controlled_test and created_at > now()-make_interval(secs=>p_rate_limit_seconds)) then
   return jsonb_build_object('reserved',false,'reason','controlled_test_rate_limited');
 end if;
 select count(*),min(r.id) into prospect_count,prospect_id from public.crm_records r
 where r.type='stats' and coalesce((r.payload->>'deleted')::boolean,false)=false and public.ai_normalize_phone(r.payload->>'phone')=p_phone_e164;
 if prospect_count=0 then return jsonb_build_object('reserved',false,'reason','stats_prospect_not_found'); end if;
 if prospect_count>1 then return jsonb_build_object('reserved',false,'reason','ambiguous_stats_prospect_match'); end if;
 perform 1 from public.crm_records where id=prospect_id for update;
 elig:=public.ai_evaluate_call_eligibility(p_campaign_id,prospect_id,now());
 if not coalesce((elig->>'eligible')::boolean,false) then return jsonb_build_object('reserved',false,'reason','phase5_ineligible','eligibility',elig); end if;
 select coalesce(max(attempt_number),0)+1 into attempt_no from public.ai_call_attempts where campaign_id=p_campaign_id and prospect_record_id=prospect_id;
 insert into public.ai_call_attempts(campaign_id,prospect_record_id,phone_e164,lead_timezone,timezone_source,attempt_number,status,queue_available_at,telephony_provider_slug,controlled_test,origin_request_key,provider_metadata)
 values(p_campaign_id,prospect_id,p_phone_e164,elig->>'lead_timezone',case when elig->>'timezone_source'='campaign' then 'campaign' when elig->>'timezone_source'='callback' then 'manual' else 'crm' end,attempt_no,'queued',now(),'twilio',true,p_request_key,jsonb_build_object('phase','6','controlled_test',true,'eligibility_snapshot',elig)) returning id into new_id;
 return jsonb_build_object('reserved',true,'duplicate',false,'attempt_id',new_id,'prospect_record_id',prospect_id,'eligibility',elig);
end;$$;

-- Claim one explicit controlled test attempt by ID. Expired leases can be recovered, but originating attempts cannot be re-claimed.
create or replace function public.ai_claim_controlled_test_attempt(
 p_attempt_id uuid,p_worker text,p_lease_seconds integer default 120
) returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.ai_call_attempts; tok uuid:=gen_random_uuid(); expires timestamptz;
begin
 if p_lease_seconds < 30 or p_lease_seconds > 600 then raise exception 'invalid lease'; end if;
 select * into a from public.ai_call_attempts where id=p_attempt_id for update;
 if not found then return jsonb_build_object('claimed',false,'reason','not_found'); end if;
 if not a.controlled_test then return jsonb_build_object('claimed',false,'reason','not_controlled_test'); end if;
 if a.provider_call_id is not null then return jsonb_build_object('claimed',false,'reason','already_originated'); end if;
 if a.initiated_at is not null or a.status='initiating' then return jsonb_build_object('claimed',false,'reason','origination_already_started'); end if;
 if a.status not in ('queued','claimed') then return jsonb_build_object('claimed',false,'reason','invalid_state'); end if;
 if a.lock_expires_at is not null and a.lock_expires_at>now() and a.locked_by is distinct from p_worker then return jsonb_build_object('claimed',false,'reason','leased'); end if;
 expires:=now()+make_interval(secs=>p_lease_seconds);
 update public.ai_call_attempts set status='claimed',lock_token=tok,locked_by=p_worker,locked_at=now(),lock_expires_at=expires where id=p_attempt_id;
 return jsonb_build_object('claimed',true,'attempt_id',p_attempt_id,'lock_token',tok,'lock_expires_at',expires);
end;$$;

create or replace function public.ai_apply_twilio_event(
 p_attempt_id uuid,p_event_id text,p_status text,p_payload jsonb,p_occurred_at timestamptz default now()
) returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.ai_call_attempts; normalized text; terminal boolean; seq bigint; provider_seq bigint; call_secs int; total_secs int;
begin
 select * into a from public.ai_call_attempts where id=p_attempt_id for update;
 if not found then return jsonb_build_object('applied',false,'reason','attempt_not_found'); end if;
 if exists(select 1 from public.ai_call_events where provider_slug='twilio' and provider_event_id=p_event_id) then return jsonb_build_object('applied',false,'reason','duplicate_event'); end if;
 normalized := case p_status when 'queued' then 'initiating' when 'initiated' then 'initiating' when 'ringing' then 'ringing' when 'in-progress' then 'connected' when 'completed' then 'completed' when 'busy' then 'busy' when 'no-answer' then 'no_answer' when 'canceled' then 'cancelled' when 'failed' then 'provider_failed' else null end;
 if normalized is null then return jsonb_build_object('applied',false,'reason','unknown_status'); end if;
 provider_seq:=case when coalesce(p_payload->>'SequenceNumber','') ~ '^\d+$' then (p_payload->>'SequenceNumber')::bigint else null end;
 if provider_seq is not null and a.provider_sequence_no is not null and provider_seq<=a.provider_sequence_no then return jsonb_build_object('applied',false,'reason','stale_sequence'); end if;
 terminal := a.status in ('completed','busy','no_answer','provider_failed','provider_rejected','provider_auth_error','provider_network_error','cancelled','invalid_number');
 if terminal then return jsonb_build_object('applied',false,'reason','terminal_regression_blocked'); end if;
 select coalesce(max(sequence_no),0)+1 into seq from public.ai_call_events where attempt_id=p_attempt_id;
 insert into public.ai_call_events(attempt_id,event_type,event_source,occurred_at,sequence_no,provider_slug,provider_event_id,payload)
 values(p_attempt_id,'telephony.'||p_status,'provider',p_occurred_at,seq,'twilio',p_event_id,coalesce(p_payload,'{}'::jsonb));
 call_secs:=case when coalesce(p_payload->>'CallDuration','') ~ '^\d+$' then greatest(0,(p_payload->>'CallDuration')::int) else null end;
 total_secs:=greatest(0,floor(extract(epoch from (p_occurred_at-coalesce(a.initiated_at,a.started_at,p_occurred_at))))::int);
 update public.ai_call_attempts set
  provider_status=p_status,provider_sequence_no=coalesce(provider_seq,provider_sequence_no),status=normalized,
  initiated_at=case when p_status in ('initiated','ringing','in-progress') then coalesce(initiated_at,p_occurred_at) else initiated_at end,
  started_at=case when p_status in ('initiated','ringing','in-progress') then coalesce(started_at,p_occurred_at) else started_at end,
  ringing_at=case when p_status='ringing' then coalesce(ringing_at,p_occurred_at) else ringing_at end,
  answered_at=case when p_status='in-progress' then coalesce(answered_at,p_occurred_at) else answered_at end,
  ended_at=case when p_status in ('completed','busy','no-answer','canceled','failed') then p_occurred_at else ended_at end,
  completed_at=case when p_status in ('completed','busy','no-answer','canceled','failed') then p_occurred_at else completed_at end,
  duration_seconds=case when p_status in ('completed','busy','no-answer','canceled','failed') then total_secs else duration_seconds end,
  connected_seconds=case when p_status='completed' and call_secs is not null then call_secs when p_status in ('busy','no-answer','canceled','failed') then 0 else connected_seconds end,
  failure_code=case when p_status in ('busy','no-answer','failed') then coalesce(p_payload->>'ErrorCode',p_status) else failure_code end,
  failure_reason=case when p_status in ('busy','no-answer','failed') then p_status else failure_reason end,
  lock_token=case when p_status in ('completed','busy','no-answer','canceled','failed') then null else lock_token end,
  locked_by=case when p_status in ('completed','busy','no-answer','canceled','failed') then null else locked_by end,
  locked_at=case when p_status in ('completed','busy','no-answer','canceled','failed') then null else locked_at end,
  lock_expires_at=case when p_status in ('completed','busy','no-answer','canceled','failed') then null else lock_expires_at end
 where id=p_attempt_id;
 return jsonb_build_object('applied',true,'normalized_status',normalized,'provider_sequence_no',provider_seq);
end;$$;

revoke all on function public.ai_reserve_controlled_test_attempt(uuid,text,text,integer) from public,anon,authenticated;
revoke all on function public.ai_claim_controlled_test_attempt(uuid,text,integer) from public,anon,authenticated;
revoke all on function public.ai_apply_twilio_event(uuid,text,text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.ai_reserve_controlled_test_attempt(uuid,text,text,integer) to service_role;
grant execute on function public.ai_claim_controlled_test_attempt(uuid,text,integer) to service_role;
grant execute on function public.ai_apply_twilio_event(uuid,text,text,jsonb,timestamptz) to service_role;
commit;
