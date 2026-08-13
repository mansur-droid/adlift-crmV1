import crypto from 'node:crypto';
import {getTelephonyProvider} from './_telephony/index.js';
import {requireAdmin,json,e164,phase6LiveEnabled,uuid} from './_telephony/server.js';
import {voiceProviderStatus} from './_voice/providers/index.js';

function mediaToken(attemptId,requestKey){return crypto.createHmac('sha256',String(process.env.TWILIO_AUTH_TOKEN||'phase7-disabled')).update(`${attemptId}:${requestKey}`).digest('hex')}
function tokenHash(token){return crypto.createHash('sha256').update(token).digest('hex')}

export function createControlledTestHandler({providerFactory=()=>getTelephonyProvider('twilio'),requireAdminFn=requireAdmin,liveEnabledFn=phase6LiveEnabled,now=()=>new Date(),randomUUID=()=>crypto.randomUUID(),voiceStatusFn=voiceProviderStatus}={}){
 return async function handler(req,res){
  res.setHeader?.('Cache-Control','no-store');
  const auth=await requireAdminFn(req,res);if(!auth)return;
  const {admin,user}=auth;const provider=providerFactory();const voiceProviders=voiceStatusFn();
  if(req.method==='GET')return json(res,200,{...provider.status(),voiceProviders,controlledTestEnabled:liveEnabledFn(),bulkDialingEnabled:false,autonomousCampaignConsumption:false,phase7:true});
  if(req.method!=='POST')return json(res,405,{error:'Method not allowed.'});
  let b;try{b=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{})}catch{return json(res,400,{error:'Invalid JSON body.'})}
  const action=b.action||'place';
  if(action==='bulk'||b.bulk===true)return json(res,403,{error:'Bulk live dialing is disabled.'});

  if(action==='place'){
   if(!liveEnabledFn())return json(res,423,{error:'Controlled real calling is server-disabled. TWILIO_CONTROLLED_TEST_ENABLED must remain false until one authorized test.'});
   if(b.confirmation!=='PLACE ONE REAL TWILIO CALL')return json(res,400,{error:'Explicit real-call confirmation is required.'});
   if(!uuid(b.campaignId))return json(res,400,{error:'A valid Twilio campaignId is required.'});
   const to=e164(b.destination);if(!to)return json(res,400,{error:'Destination must be unambiguous international E.164, for example +32…'});
   const status=provider.status();if(!status.readyForTest)return json(res,503,{error:'Twilio conversational calling is not configured.',configurationError:status.configurationError||null});
   if(!voiceProviders.deepgram?.configured||!voiceProviders.openai?.configured)return json(res,503,{error:'Conversational AI providers are not configured. No Twilio request was made.',voiceProviders});
   const requestKey=String(b.requestKey||'');if(!/^[A-Za-z0-9_-]{16,100}$/.test(requestKey))return json(res,400,{error:'A stable requestKey is required.'});

   const {data:reservation,error:reserveError}=await admin.rpc('ai_reserve_controlled_test_attempt',{p_campaign_id:b.campaignId,p_phone_e164:to,p_request_key:requestKey,p_rate_limit_seconds:60});
   if(reserveError)return json(res,409,{error:'Controlled test attempt could not be reserved.',reason:reserveError.message});
   if(!reservation?.reserved){const code=reservation?.reason==='controlled_test_rate_limited'?429:409;return json(res,code,{error:'Controlled test reservation rejected.',reason:reservation?.reason||'reservation_rejected',eligibility:reservation?.eligibility||null});}
   const attemptId=reservation.attempt_id;
   const {data:reservedAttempt}=await admin.from('ai_call_attempts').select('*').eq('id',attemptId).eq('controlled_test',true).maybeSingle();
   if(!reservedAttempt)return json(res,409,{error:'Reserved controlled attempt is unavailable.'});
   if(reservation.duplicate&&(reservedAttempt.provider_call_id||reservedAttempt.initiated_at))return json(res,200,{attemptId:reservedAttempt.id,callSid:reservedAttempt.provider_call_id||null,state:reservedAttempt.status,providerStatus:reservedAttempt.provider_status||null,duplicateRequest:true,originationUncertain:Boolean(reservedAttempt.initiated_at&&!reservedAttempt.provider_call_id)});

   const token=mediaToken(attemptId,requestKey);const {data:voiceReservation,error:voiceError}=await admin.rpc('ai_reserve_voice_session',{p_attempt_id:attemptId,p_media_token_hash:tokenHash(token)});
   if(voiceError||!voiceReservation?.reserved)return json(res,409,{error:'Real-time voice session could not be reserved. No Twilio request was made.',reason:voiceReservation?.reason||voiceError?.message||'voice_session_rejected'});
   const worker=`phase7:${user.id}:${randomUUID()}`;
   const {data:claim,error:claimError}=await admin.rpc('ai_claim_controlled_test_attempt',{p_attempt_id:attemptId,p_worker:worker,p_lease_seconds:120});
   if(claimError||!claim?.claimed)return json(res,409,{error:'Controlled attempt could not be claimed.',reason:claim?.reason||claimError?.message||'claim_failed'});
   const started=now().toISOString();
   const {data:initiating,error:initError}=await admin.from('ai_call_attempts').update({status:'initiating',initiated_at:started,started_at:started,provider_from_e164:status.fromNumber||null,provider_to_e164:to}).eq('id',attemptId).eq('lock_token',claim.lock_token).select().single();
   if(initError||!initiating)return json(res,409,{error:'Controlled attempt lost its lease before origination. No Twilio request was made.'});

   try{
    const call=await provider.createCall({to,attemptId,mediaToken:token});
    const {error:persistError}=await admin.from('ai_call_attempts').update({provider_call_id:call.sid,provider_status:call.status||'queued',provider_metadata:{...(initiating.provider_metadata||{}),phase:'7',controlled_test:true,realtime_voice:true}}).eq('id',attemptId).eq('lock_token',claim.lock_token);
    await admin.from('ai_voice_sessions').update({provider_call_id:call.sid,status:'connecting'}).eq('attempt_id',attemptId);
    if(persistError){await admin.from('ai_call_attempts').update({provider_call_id:call.sid,provider_status:call.status||'queued',failure_code:'PROVIDER_ID_PERSIST_RETRY',failure_reason:'Twilio accepted the call; provider ID persistence required recovery.'}).eq('id',attemptId);}
    await admin.from('ai_call_events').insert({attempt_id:attemptId,event_type:'telephony.originated',event_source:'system',provider_slug:'twilio',provider_event_id:`origin:${call.sid}`,payload:{callSid:call.sid,status:call.status||'queued',phase:7,realtimeVoice:true}});
    return json(res,201,{attemptId,callSid:call.sid,state:'initiating',providerStatus:call.status||'queued',voiceSessionId:voiceReservation.session_id,duplicateRequest:false});
   }catch(e){
    const safe=e.safe||{kind:'provider_error',internalStatus:'provider_rejected',code:'TWILIO_ERROR',message:'Twilio origination failed.'};const ended=now().toISOString();
    await admin.from('ai_call_attempts').update({status:safe.internalStatus||'provider_rejected',failure_code:safe.code||safe.kind,failure_reason:safe.message||safe.kind,ended_at:ended,completed_at:ended,duration_seconds:0,connected_seconds:0,lock_token:null,locked_by:null,locked_at:null,lock_expires_at:null}).eq('id',attemptId);
    await admin.from('ai_voice_sessions').update({status:'failed',ended_at:ended,provider_errors:[{provider:'twilio',code:safe.code||safe.kind,message:safe.message||safe.kind,at:ended}]}).eq('attempt_id',attemptId);
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
