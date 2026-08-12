\set ON_ERROR_STOP on

do $$
declare c uuid:=gen_random_uuid(); p1 uuid:=gen_random_uuid(); p2 uuid:=gen_random_uuid(); p3 uuid:=gen_random_uuid(); e jsonb; n int;
begin
 insert into ai_call_campaigns(id,name,status,enabled,telephony_provider_slug,timezone_strategy,fixed_timezone,calling_days,calling_window_start,calling_window_end,max_attempts_per_prospect,min_retry_delay_minutes,max_calls_per_day,max_connected_minutes_per_day,max_concurrent_calls,max_calls_total,cost_settings)
 values(c,'Phase5 regression','active',true,'twilio','fixed','Europe/Brussels',array[0,1,2,3,4,5,6],time '00:00',time '23:59',3,60,100,600,10,100,'{"max_daily_spend":"100","max_campaign_spend":"1000"}');
 insert into crm_records(id,type,payload) values
  (p1,'stats',jsonb_build_object('name','Eligible','phone','0032470000101','timezone','Europe/Brussels','status','dialed')),
  (p2,'stats',jsonb_build_object('name','Bad phone','phone','0470000102','timezone','Europe/Brussels','status','dialed')),
  (p3,'stats',jsonb_build_object('name','Booked','phone','+32470000103','timezone','Europe/Brussels','status','booked'));
 e:=ai_evaluate_call_eligibility(c,p1,now()); if e->>'reason_code'<>'eligible' then raise exception 'expected eligible: %',e; end if;
 if e->>'phone_e164'<>'+32470000101' then raise exception 'normalization failed: %',e; end if;
 e:=ai_evaluate_call_eligibility(c,p2,now()); if e->>'reason_code'<>'phone_invalid_or_ambiguous' then raise exception 'expected ambiguous phone: %',e; end if;
 e:=ai_evaluate_call_eligibility(c,p3,now()); if e->>'reason_code'<>'terminal_status' then raise exception 'expected terminal: %',e; end if;
 insert into ai_suppressions(prospect_record_id,scope,suppression_type,active) values(p1,'global','do_not_call',true);
 e:=ai_evaluate_call_eligibility(c,p1,now()); if e->>'reason_code'<>'suppressed_or_dnc' then raise exception 'expected DNC: %',e; end if;
 delete from ai_suppressions where prospect_record_id=p1;
 insert into ai_callbacks(campaign_id,prospect_record_id,status,scheduled_for,lead_timezone) values(c,p1,'scheduled',now()+interval '1 hour','Europe/Brussels');
 e:=ai_evaluate_call_eligibility(c,p1,now()); if e->>'reason_code'<>'callback_scheduled' then raise exception 'expected callback: %',e; end if;
 update ai_callbacks set scheduled_for=now()-interval '1 minute',status='due' where prospect_record_id=p1;
 e:=ai_evaluate_call_eligibility(c,p1,now()); if e->>'reason_code'<>'eligible' or (e->>'callback_due')::boolean<>true then raise exception 'due callback should be eligible: %',e; end if;
 select count(*) into n from ai_queue_campaign_eligible(c,1,now()) where queued; if n<>1 then raise exception 'expected one queued'; end if;
 e:=ai_evaluate_call_eligibility(c,p1,now()); if e->>'reason_code'<>'prospect_already_queued_or_active' then raise exception 'duplicate protection missing: %',e; end if;
end $$;

do $$
declare c uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); e jsonb;
begin
 insert into ai_call_campaigns(id,name,status,enabled,telephony_provider_slug,timezone_strategy,fixed_timezone,calling_days,calling_window_start,calling_window_end,max_attempts_per_prospect,min_retry_delay_minutes,max_calls_per_day,max_connected_minutes_per_day,max_concurrent_calls)
 values(c,'DST regression','active',true,'twilio','fixed','Europe/Brussels',array[0,1,2,3,4,5,6],time '09:00',time '17:00',3,0,100,600,10);
 insert into crm_records(id,type,payload) values(p,'stats',jsonb_build_object('phone','+32471111999','status','dialed'));
 e:=ai_evaluate_call_eligibility(c,p,'2026-07-15 08:00:00+00'); if e->>'reason_code'<>'eligible' then raise exception 'summer DST expected eligible: %',e; end if;
 e:=ai_evaluate_call_eligibility(c,p,'2026-01-15 07:00:00+00'); if e->>'reason_code'<>'outside_calling_window' then raise exception 'winter expected outside: %',e; end if;
end $$;
