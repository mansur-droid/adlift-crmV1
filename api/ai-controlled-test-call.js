import crypto from 'node:crypto';
import {getTelephonyProvider} from './_telephony/index.js';
import {requireAdmin,json,e164,phase6LiveEnabled,uuid} from './_telephony/server.js';

export function createControlledTestHandler({providerFactory=()=>getTelephonyProvider('twilio'),requireAdminFn=requireAdmin,liveEnabledFn=phase6LiveEnabled,now=()=>new Date(),randomUUID=()=>crypto.randomUUID()}={}){
 return async function handler(req,res){
  res.setHeader?.('Cache-Control','no-store');
  const auth=await requireAdminFn(req,res);if(!auth)return;
  const {admin,user}=auth;const provider=providerFactory();
  if(req.method==='GET')return json(res,200,{...provider.status(),controlledTestEnabled:liveEnabledFn(),bulkDialingEnabled:false});
  if(req.method!=='POST')return json(res,405,{error:'Method not allowed.'});
  let b;try{b=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{})}catch{return json(res,400,{error:'Invalid JSON body.'})}
  const action=b.action||'place';
  if(action==='bulk'||b.bulk===true)return json(res,403,{error:'Bulk live dialing is disabled in Phase 6.'});

  if(action==='place'){
   if(!liveEnabledFn())return json(res,423,{error:'Controlled real calling is server-disabled. Set TWILIO_CONTROLLED_TEST_ENABLED=true only immediately before an authorized test.'});
   if(b.confirmation!=='PLACE ONE REAL TWILIO CALL')return json(res,400,{error:'Explicit real-call confirmation is required.'});
   if(!uuid(b.campaignId))return json(res,400,{error:'A valid Twilio campaignId is required.'});
   const to=e164(b.destination);if(!to)return json(res,400,{error:'Destination must be unambiguous international E.164, for example +32…'});
   const status=provider.status();if(!status.readyForTest)return json(res,503,{error:'Twilio is not configured.',configurationError:status.configurationError||null});
   const requestKey=String(b.requestKey||'');if(!/^[A-Za-z0-9_-]{16,100}$/.test(requestKey))return json(res,400,{error:'A stable requestKey is required.'});

   const {data:reservation,error:reserveError}=await admin.rpc('ai_reserve_controlled_test_attempt',{p_campaign_id:b.campaignId,p_phone_e164:to,p_request_key:requestKey,p_rate_limit_seconds:60});
   if(reserveError)return json(res,409,{error:'Controlled test attempt could not be reserved.',reason:reserveError.message});
   if(!reservation?.reserved){const code=reservation?.reason==='controlled_test_rate_limited'?429:409;return json(res,code,{error:'Controlled test reservation rejected.',reason:reservation?.reason||'reservation_rejected',eligibility:reservation?.eligibility||null});}
   const attemptId=reservation.attempt_id;
   const {data:reservedAttempt}=await admin.from('ai_call_attempts').select('*').eq('id',attemptId).eq('controlled_test',true).maybeSingle();
   if(!reservedAttempt)return json(res,409,{error:'Reserved controlled attempt is unavailable.'});
   if(reservation.duplicate&&(reservedAttempt.provider_call_id||reservedAttempt.initiated_at))return json(res,200,{attemptId:reservedAttempt.id,callSid:reservedAttempt.provider_call_id||null,state:reservedAttempt.status,providerStatus:reservedAttempt.provider_status||null,duplicateRequest:true,originationUncertain:Boolean(reservedAttempt.initiated_at&&!reservedAttempt.provider_call_id)});

   const worker=`phase6:${user.id}:${randomUUID()}`;
   const {data:claim,error:claimError}=await admin.rpc('ai_claim_controlled_test_attempt',{p_attempt_id:attemptId,p_worker:worker,p_lease_seconds:120});
   if(claimError||!claim?.claimed)return json(res,409,{error:'Controlled attempt could not be claimed.',reason:claim?.reason||claimError?.message||'claim_failed'});
   const started=now().toISOString();
   const {data:initiating,error:initError}=await admin.from('ai_call_attempts').update({status:'initiating',initiated_at:started,started_at:started,provider_from_e164:status.fromNumber||null,provider_to_e164:to}).eq('id',attemptId).eq('lock_token',claim.lock_token).select().single();
   if(initError||!initiating)return json(res,409,{error:'Controlled attempt lost its lease before origination. No Twilio request was made.'});

   try{
    const call=await provider.createCall({to,attemptId});
    const {error:persistError}=await admin.from('ai_call_attempts').update({provider_call_id:call.sid,provider_status:call.status||'queued',provider_metadata:{...(initiating.provider_metadata||{}),phase:'6',controlled_test:true}}).eq('id',attemptId).eq('lock_token',claim.lock_token);
    if(persistError){await admin.from('ai_call_attempts').update({provider_call_id:call.sid,provider_status:call.status||'queued',failure_code:'PROVIDER_ID_PERSIST_RETRY',failure_reason:'Twilio accepted the call; provider ID persistence required recovery.'}).eq('id',attemptId);}
    await admin.from('ai_call_events').upsert({attempt_id:attemptId,event_type:'telephony.originated',event_source:'system',provider_slug:'twilio',provider_event_id:`origin:${call.sid}`,payload:{callSid:call.sid,status:call.status||'queued'}},{onConflict:'provider_slug,provider_event_id',ignoreDuplicates:true});
    return json(res,201,{attemptId,callSid:call.sid,state:'initiating',providerStatus:call.status||'queued',duplicateRequest:false});
   }catch(e){
    const safe=e.safe||{kind:'provider_error',internalStatus:'provider_rejected',code:'TWILIO_ERROR',message:'Twilio origination failed.'};const ended=now().toISOString();
    await admin.from('ai_call_attempts').update({status:safe.internalStatus||'provider_rejected',failure_code:safe.code||safe.kind,failure_reason:safe.message||safe.kind,ended_at:ended,completed_at:ended,duration_seconds:0,connected_seconds:0,lock_token:null,locked_by:null,locked_at:null,lock_expires_at:null}).eq('id',attemptId);
    await admin.from('ai_call_events').insert({attempt_id:attemptId,event_type:'telephony.origination_failed',event_source:'system',provider_slug:'twilio',provider_event_id:`origin-failed:${requestKey}`,payload:{kind:safe.kind,code:safe.code||null,status:safe.status||0}});
    return json(res,502,{error:'Twilio rejected the controlled test call.',providerError:{kind:safe.kind,code:safe.code||null,message:safe.message||'Twilio request failed.',status:safe.status||0}});
   }
  }

  if(action==='terminate'){
   if(!uuid(b.attemptId))return json(res,400,{error:'Valid attemptId required.'});
   const {data:a}=await admin.from('ai_call_attempts').select('*').eq('id',b.attemptId).eq('controlled_test',true).maybeSingle();
   if(!a?.provider_call_id)return json(res,404,{error:'Active controlled Twilio call not found.'});
   if(['completed','busy','no_answer','provider_failed','provider_rejected','provider_auth_error','provider_network_error','cancelled','invalid_number'].includes(a.status))return json(res,200,{terminationRequested:false,alreadyTerminal:true});
   try{
    const call=await provider.cancelCall(a.provider_call_id);const providerStatus=call.status||'canceled';const occurred=now().toISOString();
    await admin.from('ai_call_events').insert({attempt_id:a.id,event_type:'telephony.termination_requested',event_source:'admin',occurred_at:occurred,provider_slug:'twilio',provider_event_id:`terminate:${a.provider_call_id}:${occurred}`,payload:{providerStatus}});
    if(['canceled','completed','busy','no-answer','failed'].includes(providerStatus))await admin.rpc('ai_apply_twilio_event',{p_attempt_id:a.id,p_event_id:`terminate-result:${a.provider_call_id}:${providerStatus}`,p_status:providerStatus,p_payload:{CallSid:a.provider_call_id,CallStatus:providerStatus},p_occurred_at:occurred});
    return json(res,200,{terminationRequested:true,providerStatus});
   }catch(e){const safe=e.safe||{kind:'provider_error',message:'Twilio termination failed.'};return json(res,502,{error:'Twilio termination failed.',providerError:{kind:safe.kind,code:safe.code||null,message:safe.message||'Twilio request failed.'}})}
  }
  return json(res,400,{error:'Unknown action.'});
 };
}

export default createControlledTestHandler();
