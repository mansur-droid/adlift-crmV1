\set ON_ERROR_STOP on

-- Controlled diagnostic attempts do not consume normal per-prospect attempt policy,
-- while all ordinary Phase 5 safeguards remain authoritative.
do $$
declare c uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); a int; e jsonb; d jsonb;
begin
 insert into ai_call_campaigns(id,name,status,enabled,telephony_provider_slug,timezone_strategy,calling_days,calling_window_start,calling_window_end,max_attempts_per_prospect,min_retry_delay_minutes,max_calls_per_day,max_connected_minutes_per_day,max_concurrent_calls)
 values(c,'Controlled accounting','active',true,'twilio','lead_local',array[1,2,3,4,5],time '08:00',time '23:00',1,60,100,600,10);
 insert into crm_records(id,type,payload) values(p,'stats',jsonb_build_object('phone','+12295370001','lead_timezone','America/New_York','status','dialed'));

 -- Friday 17:00 in New York during EDT.
 e:=ai_evaluate_call_eligibility(c,p,'2026-08-14 21:00:00+00');
 if not (e->>'eligible')::boolean or e->>'lead_timezone'<>'America/New_York' then raise exception 'summer NY eligibility failed: %',e; end if;

 -- Wednesday 08:30 in New York during EST: proves IANA/DST conversion, not a hard-coded UTC offset.
 e:=ai_evaluate_call_eligibility(c,p,'2026-01-14 13:30:00+00');
 if not (e->>'eligible')::boolean then raise exception 'winter NY eligibility failed: %',e; end if;

 for a in 1..3 loop
  insert into ai_call_attempts(campaign_id,prospect_record_id,phone_e164,attempt_number,status,telephony_provider_slug,controlled_test,created_at,started_at,ended_at)
  values(c,p,'+12295370001',a,'completed','twilio',true,'2026-08-14 20:00:00+00','2026-08-14 20:00:00+00','2026-08-14 20:00:05+00');
 end loop;
 e:=ai_evaluate_call_eligibility(c,p,'2026-08-14 21:00:00+00');
 if not (e->>'eligible')::boolean then raise exception 'controlled tests consumed normal attempt limit: %',e; end if;
 if (e->>'normal_attempts')::int<>0 or (e->>'attempt_number')::int<>4 then raise exception 'attempt accounting/numbering wrong: %',e; end if;
 d:=ai_controlled_test_diagnostics(c,'+12295370001','2026-08-14 21:00:00+00');
 if (d->>'controlled_attempts')::int<>3 or (d->>'normal_attempts')::int<>0 or d->>'reason_code'<>'eligible' then raise exception 'diagnostics wrong: %',d; end if;

 insert into ai_call_attempts(campaign_id,prospect_record_id,phone_e164,attempt_number,status,telephony_provider_slug,controlled_test,created_at,started_at,ended_at)
 values(c,p,'+12295370001',4,'completed','twilio',false,'2026-08-14 19:00:00+00','2026-08-14 19:00:00+00','2026-08-14 19:00:05+00');
 e:=ai_evaluate_call_eligibility(c,p,'2026-08-14 21:00:00+00');
 if e->>'reason_code'<>'attempt_limit_reached' or (e->>'attempts')::int<>1 then raise exception 'normal attempt limit was weakened: %',e; end if;
end $$;

-- Calling window remains enforced for controlled-test diagnostics.
do $$
declare c uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); d jsonb;
begin
 insert into ai_call_campaigns(id,name,status,enabled,telephony_provider_slug,timezone_strategy,calling_days,calling_window_start,calling_window_end,max_attempts_per_prospect,min_retry_delay_minutes,max_calls_per_day,max_connected_minutes_per_day,max_concurrent_calls)
 values(c,'Window block','active',true,'twilio','lead_local',array[1,2,3,4,5],time '08:00',time '17:00',3,0,100,600,10);
 insert into crm_records(id,type,payload) values(p,'stats',jsonb_build_object('phone','+12295370002','lead_timezone','America/New_York','status','dialed'));
 d:=ai_controlled_test_diagnostics(c,'+12295370002','2026-08-14 21:30:00+00');
 if d->>'reason_code'<>'outside_calling_window' then raise exception 'controlled diagnostics bypassed call window: %',d; end if;
end $$;
