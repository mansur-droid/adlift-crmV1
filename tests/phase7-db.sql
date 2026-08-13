\set ON_ERROR_STOP on

do $$
declare c uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); a uuid; r jsonb; s public.ai_transcript_segments;
begin
 insert into ai_provider_configs(provider_kind,provider_slug,display_name,enabled,settings) values
 ('stt','deepgram','Deepgram STT',true,'{}'),
 ('llm','openai','OpenAI LLM',true,'{}'),
 ('tts','deepgram','Deepgram TTS',true,'{}')
 on conflict(provider_kind,provider_slug) do update set enabled=true;
 insert into ai_call_campaigns(id,name,status,enabled,telephony_provider_slug,stt_provider_slug,llm_provider_slug,tts_provider_slug,timezone_strategy,fixed_timezone,calling_days,calling_window_start,calling_window_end,max_attempts_per_prospect,min_retry_delay_minutes,max_calls_per_day,max_connected_minutes_per_day,max_concurrent_calls)
 values(c,'Phase7 DB','active',true,'twilio','deepgram','openai','deepgram','fixed','Europe/Brussels',array[0,1,2,3,4,5,6],time '00:00',time '23:59',10,0,100,600,1);
 insert into crm_records(id,type,payload) values(p,'stats','{"phone":"+32470000777","status":"dialed"}');
 insert into ai_call_attempts(campaign_id,prospect_record_id,phone_e164,attempt_number,status,telephony_provider_slug,controlled_test,origin_request_key)
 values(c,p,'+32470000777',1,'queued','twilio',true,'phase7_db_request_0001') returning id into a;
 r:=ai_reserve_voice_session(a,repeat('a',64));
 if not (r->>'reserved')::boolean then raise exception 'voice session reservation failed: %',r; end if;
 if (select count(*) from ai_voice_sessions where attempt_id=a)<>1 then raise exception 'voice session uniqueness failed'; end if;
 r:=ai_reserve_voice_session(a,repeat('a',64));
 if not (r->>'duplicate')::boolean then raise exception 'voice session idempotency failed: %',r; end if;
 s:=ai_append_transcript_segment(a,'prospect',10,20,'hello',0.95,'deepgram','prospect-1','{}');
 if s.sequence_no<>0 then raise exception 'first transcript sequence wrong'; end if;
 s:=ai_append_transcript_segment(a,'agent',21,40,'hello back',null,'deepgram','agent-1','{}');
 if s.sequence_no<>1 then raise exception 'second transcript sequence wrong'; end if;
 if (select count(*) from ai_transcript_segments where attempt_id=a and is_final)<>2 then raise exception 'transcript persistence failed'; end if;
end $$;

do $$
declare c uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); a uuid; r jsonb;
begin
 insert into ai_call_campaigns(id,name,status,enabled,telephony_provider_slug,timezone_strategy,fixed_timezone,calling_days,calling_window_start,calling_window_end,max_attempts_per_prospect,min_retry_delay_minutes,max_calls_per_day,max_connected_minutes_per_day,max_concurrent_calls)
 values(c,'Missing Providers','active',true,'twilio','fixed','Europe/Brussels',array[0,1,2,3,4,5,6],time '00:00',time '23:59',10,0,100,600,1);
 insert into crm_records(id,type,payload) values(p,'stats','{"phone":"+32470000778","status":"dialed"}');
 insert into ai_call_attempts(campaign_id,prospect_record_id,phone_e164,attempt_number,status,telephony_provider_slug,controlled_test)
 values(c,p,'+32470000778',1,'queued','twilio',true) returning id into a;
 r:=ai_reserve_voice_session(a,repeat('b',64));
 if r->>'reason'<>'voice_provider_missing' then raise exception 'missing providers were accepted: %',r; end if;
end $$;
