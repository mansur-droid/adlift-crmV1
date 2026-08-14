import {requireAdmin,json,uuid} from './_telephony/server.js';
import {getTelephonyProvider} from './_telephony/index.js';

const MAX_COST_RECONCILE_ATTEMPTS=5;
export function buildCostPatch(attempt,cost,checkedAt=new Date().toISOString()){
 const tries=(attempt.cost_reconcile_attempts||0)+1;const patch={cost_reconcile_attempts:tries,cost_last_checked_at:checkedAt};
 if(cost.available&&Number.isFinite(cost.price)){
  patch.actual_cost=Math.abs(cost.price);patch.cost_currency=cost.currency||attempt.cost_currency;patch.cost_status='reconciled';patch.cost_reconcile_error=null;
  if(Number.isFinite(cost.connectedDuration)&&(attempt.answered_at||cost.status==='completed'))patch.connected_seconds=Math.max(0,cost.connectedDuration);
 }else{patch.cost_status=tries>=MAX_COST_RECONCILE_ATTEMPTS?'unavailable':'pending';patch.cost_reconcile_error='Authoritative Twilio price not available yet.'}
 return patch;
}
export function buildCostFailurePatch(attempt,error,checkedAt=new Date().toISOString()){
 const tries=(attempt.cost_reconcile_attempts||0)+1;return {cost_reconcile_attempts:tries,cost_last_checked_at:checkedAt,cost_status:tries>=MAX_COST_RECONCILE_ATTEMPTS?'failed':'pending',cost_reconcile_error:String(error?.safe?.message||error?.message||'Reconciliation failed').slice(0,500)};
}

export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');const auth=await requireAdmin(req,res);if(!auth)return;const {admin}=auth;
 let b={};if(req.method==='POST'){try{b=typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{})}catch{return json(res,400,{error:'Invalid JSON body.'})}}
 const id=b.attemptId||req.query?.attemptId;if(!uuid(id))return json(res,400,{error:'Valid attemptId required'});
 const {data:a}=await admin.from('ai_call_attempts').select('*').eq('id',id).eq('controlled_test',true).maybeSingle();if(!a)return json(res,404,{error:'Controlled attempt not found.'});
 if(req.method==='GET'){
  const [{data:events},{data:voiceSession},{data:transcript}]=await Promise.all([
   admin.from('ai_call_events').select('*').eq('attempt_id',id).order('occurred_at'),
   admin.from('ai_voice_sessions').select('id,attempt_id,provider_call_id,stream_sid,status,stt_provider_slug,llm_provider_slug,tts_provider_slug,turn_no,current_turn_id,interim_transcript,last_prospect_utterance,last_agent_response,tts_state,interruption_count,latency_metrics,provider_states,provider_errors,compliance_state,objection_state,connected_at,last_activity_at,ended_at,expires_at').eq('attempt_id',id).maybeSingle(),
   admin.from('ai_transcript_segments').select('id,sequence_no,speaker,start_ms,end_ms,text,is_final,confidence,provider_slug,metadata,created_at').eq('attempt_id',id).eq('is_final',true).order('sequence_no')
  ]);
  return json(res,200,{attempt:a,events:events||[],voiceSession:voiceSession||null,transcript:transcript||[]});
 }
 if(req.method==='POST'&&b.action==='reconcileCost'){
  if(a.cost_status==='reconciled')return json(res,200,{attempt:a,alreadyReconciled:true});
  if(!a.provider_call_id)return json(res,409,{error:'Provider Call SID not available.'});
  if((a.cost_reconcile_attempts||0)>=MAX_COST_RECONCILE_ATTEMPTS)return json(res,429,{error:'Bounded cost reconciliation limit reached.'});
  const provider=getTelephonyProvider('twilio');if(!provider.status().configured)return json(res,503,{error:'Twilio is not configured.'});
  try{
   const cost=await provider.reconcileCall(a.provider_call_id);const normalized=provider.normalizeProviderStatus(cost.status);const checkedAt=new Date().toISOString();
   if(normalized&&['completed','busy','no_answer','provider_failed','cancelled'].includes(normalized)&&!['completed','busy','no_answer','provider_failed','provider_rejected','provider_auth_error','provider_network_error','cancelled','invalid_number'].includes(a.status)){
    await admin.rpc('ai_apply_twilio_event',{p_attempt_id:id,p_event_id:`reconcile:${a.provider_call_id}:${cost.status}:${cost.endTime||''}`,p_status:cost.status,p_payload:{CallSid:a.provider_call_id,CallStatus:cost.status,CallDuration:Number.isFinite(cost.connectedDuration)?String(cost.connectedDuration):null},p_occurred_at:cost.endTime?new Date(cost.endTime).toISOString():checkedAt});
   }
   const {data:current}=await admin.from('ai_call_attempts').select('*').eq('id',id).single();const patch=buildCostPatch(current||a,cost,checkedAt);
   const {data:updated,error:updateError}=await admin.from('ai_call_attempts').update(patch).eq('id',id).select().single();if(updateError)return json(res,500,{error:'Could not persist reconciled cost.'});
   return json(res,200,{attempt:updated,costAvailable:cost.available});
  }catch(e){const patch=buildCostFailurePatch(a,e);const {data:updated}=await admin.from('ai_call_attempts').update(patch).eq('id',id).select().single();return json(res,patch.cost_status==='failed'?502:503,{error:'Twilio cost reconciliation temporarily failed.',attempt:updated})}
 }
 return json(res,405,{error:'Method/action not allowed.'});
}
