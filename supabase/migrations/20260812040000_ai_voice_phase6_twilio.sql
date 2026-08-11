-- Phase 6: Twilio telephony state, controlled-test safeguards, webhook/cost state.
-- Additive only. This migration NEVER originates a phone call.
begin;

alter table public.ai_call_attempts
  add column if not exists provider_status text,
  add column if not exists initiated_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists cost_status text not null default 'pending'
    check (cost_status in ('pending','reconciled','failed','unavailable')),
  add column if not exists cost_reconcile_attempts integer not null default 0 check (cost_reconcile_attempts >= 0),
  add column if not exists cost_last_checked_at timestamptz,
  add column if not exists cost_reconcile_error text,
  add column if not exists controlled_test boolean not null default false,
  add column if not exists origin_request_key text;

create unique index if not exists ai_call_attempts_provider_call_unique
  on public.ai_call_attempts(telephony_provider_slug,provider_call_id)
  where provider_call_id is not null;
create unique index if not exists ai_call_attempts_origin_request_unique
  on public.ai_call_attempts(origin_request_key) where origin_request_key is not null;

-- Phase 6 is deliberately test-only: no database function scans or consumes campaign queues.
-- This function claims one already-created controlled test attempt by explicit ID only.
create or replace function public.ai_claim_controlled_test_attempt(
 p_attempt_id uuid,p_worker text,p_lease_seconds integer default 120
) returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.ai_call_attempts; tok uuid:=gen_random_uuid();
begin
 if p_lease_seconds < 30 or p_lease_seconds > 600 then raise exception 'invalid lease'; end if;
 select * into a from public.ai_call_attempts where id=p_attempt_id for update;
 if not found then return jsonb_build_object('claimed',false,'reason','not_found'); end if;
 if not a.controlled_test then return jsonb_build_object('claimed',false,'reason','not_controlled_test'); end if;
 if a.provider_call_id is not null then return jsonb_build_object('claimed',false,'reason','already_originated'); end if;
 if a.status not in ('queued','claimed') then return jsonb_build_object('claimed',false,'reason','invalid_state'); end if;
 if a.lock_expires_at is not null and a.lock_expires_at>now() and a.locked_by is distinct from p_worker then
  return jsonb_build_object('claimed',false,'reason','leased');
 end if;
 update public.ai_call_attempts set status='claimed',lock_token=tok,locked_by=p_worker,locked_at=now(),lock_expires_at=now()+make_interval(secs=>p_lease_seconds)
 where id=p_attempt_id;
 return jsonb_build_object('claimed',true,'attempt_id',p_attempt_id,'lock_token',tok,'lock_expires_at',now()+make_interval(secs=>p_lease_seconds));
end;$$;

create or replace function public.ai_apply_twilio_event(
 p_attempt_id uuid,p_event_id text,p_status text,p_payload jsonb,p_occurred_at timestamptz default now()
) returns jsonb language plpgsql security definer set search_path=public as $$
declare a public.ai_call_attempts; normalized text; terminal boolean; seq bigint;
begin
 select * into a from public.ai_call_attempts where id=p_attempt_id for update;
 if not found then return jsonb_build_object('applied',false,'reason','attempt_not_found'); end if;
 terminal := a.status in ('completed','no_answer','provider_failed','cancelled','invalid_number');
 normalized := case p_status when 'queued' then 'initiating' when 'initiated' then 'initiating' when 'ringing' then 'ringing' when 'in-progress' then 'connected' when 'completed' then 'completed' when 'busy' then 'provider_failed' when 'no-answer' then 'no_answer' when 'canceled' then 'cancelled' when 'failed' then 'provider_failed' else null end;
 if normalized is null then return jsonb_build_object('applied',false,'reason','unknown_status'); end if;
 if terminal and normalized not in ('completed','no_answer','provider_failed','cancelled') then
  return jsonb_build_object('applied',false,'reason','terminal_regression_blocked');
 end if;
 select coalesce(max(sequence_no),0)+1 into seq from public.ai_call_events where attempt_id=p_attempt_id;
 insert into public.ai_call_events(attempt_id,event_type,event_source,occurred_at,sequence_no,provider_slug,provider_event_id,payload)
 values(p_attempt_id,'telephony.'||p_status,'provider',p_occurred_at,seq,'twilio',p_event_id,coalesce(p_payload,'{}'::jsonb));
 update public.ai_call_attempts set
  provider_status=p_status,status=case when terminal then status else normalized end,
  initiated_at=case when p_status in ('initiated','ringing','in-progress') then coalesce(initiated_at,p_occurred_at) else initiated_at end,
  started_at=case when p_status in ('initiated','ringing','in-progress') then coalesce(started_at,p_occurred_at) else started_at end,
  ringing_at=case when p_status='ringing' then coalesce(ringing_at,p_occurred_at) else ringing_at end,
  answered_at=case when p_status='in-progress' then coalesce(answered_at,p_occurred_at) else answered_at end,
  ended_at=case when p_status in ('completed','busy','no-answer','canceled','failed') then coalesce(ended_at,p_occurred_at) else ended_at end,
  completed_at=case when p_status in ('completed','busy','no-answer','canceled','failed') then coalesce(completed_at,p_occurred_at) else completed_at end,
  duration_seconds=case when p_status in ('completed','busy','no-answer','canceled','failed') and nullif(p_payload->>'CallDuration','') is not null then greatest(0,(p_payload->>'CallDuration')::int) else duration_seconds end,
  connected_seconds=case when p_status='completed' and nullif(p_payload->>'CallDuration','') is not null then greatest(0,(p_payload->>'CallDuration')::int) when p_status in ('busy','no-answer','canceled','failed') then coalesce(connected_seconds,0) else connected_seconds end,
  failure_code=case when p_status in ('busy','no-answer','failed') then coalesce(p_payload->>'ErrorCode',p_status) else failure_code end,
  failure_reason=case when p_status in ('busy','no-answer','failed') then p_status else failure_reason end,
  lock_token=case when p_status in ('completed','busy','no-answer','canceled','failed') then null else lock_token end,
  locked_at=case when p_status in ('completed','busy','no-answer','canceled','failed') then null else locked_at end,
  lock_expires_at=case when p_status in ('completed','busy','no-answer','canceled','failed') then null else lock_expires_at end
 where id=p_attempt_id;
 return jsonb_build_object('applied',true,'normalized_status',normalized);
end;$$;

revoke all on function public.ai_claim_controlled_test_attempt(uuid,text,integer) from public,anon,authenticated;
revoke all on function public.ai_apply_twilio_event(uuid,text,text,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.ai_claim_controlled_test_attempt(uuid,text,integer) to service_role;
grant execute on function public.ai_apply_twilio_event(uuid,text,text,jsonb,timestamptz) to service_role;
commit;