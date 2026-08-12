\set ON_ERROR_STOP on

-- Reservation, idempotency, exact-one semantics and lease recovery.
do $$
declare c uuid:=gen_random_uuid(); p1 uuid:=gen_random_uuid(); p2 uuid:=gen_random_uuid(); p3 uuid:=gen_random_uuid(); p4 uuid:=gen_random_uuid(); p5 uuid:=gen_random_uuid(); j jsonb; j2 jsonb; a uuid; tok text;
begin
 insert into ai_call_campaigns(id,name,status,enabled,telephony_provider_slug,timezone_strategy,fixed_timezone,calling_days,calling_window_start,calling_window_end,max_attempts_per_prospect,min_retry_delay_minutes,max_calls_per_day,max_connected_minutes_per_day,max_concurrent_calls,max_calls_total)
 values(c,'Phase6 DB','active',true,'twilio','fixed','Europe/Brussels',array[0,1,2,3,4,5,6],time '00:00',time '23:59',10,0,100,600,10,100);
 insert into crm_records(id,type,payload) values
 (p1,'stats','{"phone":"+32472222001","status":"dialed"}'),(p2,'stats','{"phone":"+32472222002","status":"dialed"}'),(p3,'stats','{"phone":"+32472222003","status":"dialed"}'),(p4,'stats','{"phone":"+32472222004","status":"dialed"}'),(p5,'stats','{"phone":"+32472222005","status":"dialed"}');
 j:=ai_reserve_controlled_test_attempt(c,'+32472222001','phase6_reserve_key_0001',60);if not (j->>'reserved')::boolean then raise exception 'reservation failed %',j; end if;a:=(j->>'attempt_id')::uuid;
 j2:=ai_reserve_controlled_test_attempt(c,'+32472222001','phase6_reserve_key_0001',60);if not (j2->>'duplicate')::boolean or (j2->>'attempt_id')::uuid<>a then raise exception 'idempotency failed %',j2; end if;
 if (select count(*) from ai_call_attempts where origin_request_key='phase6_reserve_key_0001')<>1 then raise exception 'duplicate reservation inserted'; end if;
 j:=ai_claim_controlled_test_attempt(a,'worker-one',120);if not (j->>'claimed')::boolean then raise exception 'claim failed %',j; end if;tok:=j->>'lock_token';
 update ai_call_attempts set provider_call_id='CA11111111111111111111111111111111' where id=a;
 j:=ai_claim_controlled_test_attempt(a,'worker-two',120);if j->>'reason'<>'already_originated' then raise exception 'duplicate origination protection failed %',j; end if;
 update ai_call_attempts set status='completed',provider_status='completed',created_at=now()-interval '2 minutes',initiated_at=now()-interval '30 seconds',ended_at=now(),completed_at=now(),lock_token=null,locked_by=null,locked_at=null,lock_expires_at=null where id=a;

 j:=ai_reserve_controlled_test_attempt(c,'+32472222002','phase6_reserve_key_0002',60);a:=(j->>'attempt_id')::uuid;j:=ai_claim_controlled_test_attempt(a,'worker-one',30);if not (j->>'claimed')::boolean then raise exception 'first lease failed'; end if;
 update ai_call_attempts set lock_expires_at=now()-interval '1 second' where id=a;
 j:=ai_claim_controlled_test_attempt(a,'worker-two',30);if not (j->>'claimed')::boolean then raise exception 'expired lease not recoverable %',j; end if;
 update ai_call_attempts set status='cancelled',created_at=now()-interval '2 minutes',ended_at=now(),completed_at=now(),lock_token=null,locked_by=null,locked_at=null,lock_expires_at=null where id=a;

 j:=ai_reserve_controlled_test_attempt(c,'+32472222003','phase6_reserve_key_0003',60);if not (j->>'reserved')::boolean then raise exception 'active test setup failed %',j; end if;a:=(j->>'attempt_id')::uuid;
 j2:=ai_reserve_controlled_test_attempt(c,'+32472222004','phase6_reserve_key_0004',60);if j2->>'reason'<>'active_controlled_test_exists' then raise exception 'active controlled test safeguard failed %',j2; end if;
 update ai_call_attempts set status='cancelled',created_at=now()-interval '2 minutes',ended_at=now(),completed_at=now() where id=a;

 j:=ai_reserve_controlled_test_attempt(c,'0472222005','phase6_reserve_key_0005',60);if j->>'reason'<>'invalid_e164' then raise exception 'ambiguous local number accepted %',j; end if;
 insert into ai_suppressions(prospect_record_id,scope,suppression_type,active) values(p5,'global','do_not_call',true);
 j:=ai_reserve_controlled_test_attempt(c,'+32472222005','phase6_reserve_key_0005',60);if j->>'reason'<>'phase5_ineligible' or j->'eligibility'->>'reason_code'<>'suppressed_or_dnc' then raise exception 'Phase5 safeguards bypassed %',j; end if;
end $$;

-- Lifecycle, timestamps, connected duration, total duration and stale-event protection.
do $$
declare c uuid:=gen_random_uuid(); p uuid; a uuid; r jsonb; i int:=0; st text; expected text;
begin
 insert into ai_call_campaigns(id,name,status,enabled,telephony_provider_slug,timezone_strategy,fixed_timezone,calling_days,calling_window_start,calling_window_end,max_attempts_per_prospect,min_retry_delay_minutes,max_calls_per_day,max_connected_minutes_per_day,max_concurrent_calls)
 values(c,'Lifecycle','active',true,'twilio','fixed','Europe/Brussels',array[0,1,2,3,4,5,6],time '00:00',time '23:59',10,0,100,600,10);
 p:=gen_random_uuid();insert into crm_records(id,type,payload) values(p,'stats','{"phone":"+32473333001","status":"dialed"}');
 insert into ai_call_attempts(campaign_id,prospect_record_id,phone_e164,attempt_number,status,telephony_provider_slug,provider_call_id,controlled_test,initiated_at,started_at,lock_token,locked_by,locked_at,lock_expires_at)
 values(c,p,'+32473333001',1,'initiating','twilio','CA22222222222222222222222222222222',true,'2026-08-12 00:00:00+00','2026-08-12 00:00:00+00',gen_random_uuid(),'worker','2026-08-12 00:00:00+00','2026-08-12 00:02:00+00') returning id into a;
 r:=ai_apply_twilio_event(a,'ev0','initiated','{"SequenceNumber":"0"}','2026-08-12 00:00:01+00');if not (r->>'applied')::boolean then raise exception 'initiated failed %',r; end if;
 r:=ai_apply_twilio_event(a,'ev1','ringing','{"SequenceNumber":"1"}','2026-08-12 00:00:05+00');
 r:=ai_apply_twilio_event(a,'ev2','in-progress','{"SequenceNumber":"2"}','2026-08-12 00:00:10+00');
 r:=ai_apply_twilio_event(a,'ev3','completed','{"SequenceNumber":"3","CallDuration":"20"}','2026-08-12 00:00:30+00');
 if (select status from ai_call_attempts where id=a)<>'completed' then raise exception 'completion missing'; end if;
 if (select connected_seconds from ai_call_attempts where id=a)<>20 then raise exception 'connected duration wrong'; end if;
 if (select duration_seconds from ai_call_attempts where id=a)<>30 then raise exception 'total duration wrong'; end if;
 if (select ringing_at from ai_call_attempts where id=a) is null or (select answered_at from ai_call_attempts where id=a) is null then raise exception 'timestamps missing'; end if;
 if (select lock_token from ai_call_attempts where id=a) is not null then raise exception 'terminal call did not release lease'; end if;
 r:=ai_apply_twilio_event(a,'ev3','completed','{"SequenceNumber":"3","CallDuration":"20"}','2026-08-12 00:00:30+00');if r->>'reason'<>'duplicate_event' then raise exception 'duplicate event not harmless %',r; end if;
 r:=ai_apply_twilio_event(a,'late-ring','ringing','{"SequenceNumber":"1"}','2026-08-12 00:00:06+00');if r->>'reason'<>'stale_sequence' then raise exception 'stale sequence not blocked %',r; end if;
 r:=ai_apply_twilio_event(a,'late-ring-2','ringing','{"SequenceNumber":"4"}','2026-08-12 00:00:31+00');if r->>'reason'<>'terminal_regression_blocked' then raise exception 'terminal regression not blocked %',r; end if;

 foreach st in array array['busy','no-answer','canceled','failed'] loop
  i:=i+1;p:=gen_random_uuid();insert into crm_records(id,type,payload) values(p,'stats',jsonb_build_object('phone','+32474444'||lpad(i::text,3,'0'),'status','dialed'));
  insert into ai_call_attempts(campaign_id,prospect_record_id,phone_e164,attempt_number,status,telephony_provider_slug,provider_call_id,controlled_test,initiated_at,started_at)
  values(c,p,'+32474444'||lpad(i::text,3,'0'),1,'initiating','twilio','CA'||lpad(i::text,32,i::text),true,'2026-08-12 00:01:00+00','2026-08-12 00:01:00+00') returning id into a;
  r:=ai_apply_twilio_event(a,'term-'||i,st,'{"SequenceNumber":"0","CallDuration":"0"}','2026-08-12 00:01:10+00');
  expected:=case st when 'busy' then 'busy' when 'no-answer' then 'no_answer' when 'canceled' then 'cancelled' else 'provider_failed' end;
  if (select status from ai_call_attempts where id=a)<>expected then raise exception 'terminal mapping % -> % failed',st,expected; end if;
  if (select connected_seconds from ai_call_attempts where id=a)<>0 then raise exception 'non-connected call counted connected time'; end if;
 end loop;
end $$;

-- Durable webhook inbox uniqueness.
do $$
declare aid uuid;
begin
 select id into aid from ai_call_attempts where controlled_test limit 1;
 insert into ai_provider_webhook_events(provider_kind,provider_slug,provider_event_id,attempt_id,payload) values('telephony','twilio','webhook-duplicate-test',aid,'{}');
 begin
  insert into ai_provider_webhook_events(provider_kind,provider_slug,provider_event_id,attempt_id,payload) values('telephony','twilio','webhook-duplicate-test',aid,'{}');
  raise exception 'duplicate webhook was accepted';
 exception when unique_violation then null;
 end;
end $$;
