import crypto from 'node:crypto';
import {createClient} from '@supabase/supabase-js';
import {getTelephonyProvider} from './_telephony/index.js';
import {serverConfig,uuid} from './_telephony/server.js';

const provider=getTelephonyProvider('twilio');
function form(req){if(req.body&&typeof req.body==='object'&&!Buffer.isBuffer(req.body))return req.body;return Object.fromEntries(new URLSearchParams(String(req.body||'')))}
export function deterministicWebhookId(ev,params,attempt){const stable=[ev.callSid,ev.status,params.SequenceNumber||'',params.Timestamp||'',params.CallDuration||'',params.SipResponseCode||'',attempt].join('|');return `twilio:${crypto.createHash('sha256').update(stable).digest('hex')}`}

export default async function handler(req,res){
 if(req.method!=='POST')return res.status(405).send('Method not allowed');
 const cfg=serverConfig();if(!cfg.url||!cfg.service)return res.status(500).send('Server configuration missing');
 const base=(process.env.TWILIO_WEBHOOK_BASE_URL||process.env.PUBLIC_APP_URL||'').replace(/\/$/,'');if(!base)return res.status(500).send('Webhook base URL missing');
 const attempt=String(req.query?.attempt||'');if(!uuid(attempt))return res.status(400).send('Invalid attempt reference');
 const params=form(req);const url=`${base}/api/twilio-webhook?attempt=${encodeURIComponent(attempt)}`;const signature=req.headers['x-twilio-signature'];
 if(!provider.validateWebhook({signature,url,params}))return res.status(403).send('Invalid Twilio signature');
 const admin=createClient(cfg.url,cfg.service,{auth:{persistSession:false,autoRefreshToken:false}});const ev=provider.parseProviderEvent(params);const eventId=deterministicWebhookId(ev,params,attempt);
 const safePayload={CallSid:ev.callSid,AccountSid:ev.accountSid,CallStatus:ev.status,CallDuration:params.CallDuration||null,Timestamp:params.Timestamp||null,SequenceNumber:params.SequenceNumber||null,CallbackSource:params.CallbackSource||null,ErrorCode:params.ErrorCode||null,SipResponseCode:params.SipResponseCode||null,From:params.From||null,To:params.To||null};
 const {data:inbox,error:inboxError}=await admin.from('ai_provider_webhook_events').insert({provider_kind:'telephony',provider_slug:'twilio',provider_event_id:eventId,attempt_id:attempt,payload:safePayload}).select().single();
 if(inboxError?.code==='23505')return res.status(200).send('duplicate');
 if(inboxError)return res.status(500).send('Webhook inbox failure');
 const {data:a}=await admin.from('ai_call_attempts').select('id,provider_call_id,controlled_test').eq('id',attempt).maybeSingle();
 if(!a?.controlled_test||a.provider_call_id!==ev.callSid){await admin.from('ai_provider_webhook_events').update({processing_status:'ignored',processed_at:new Date().toISOString(),processing_error:'Attempt/CallSid mismatch'}).eq('id',inbox.id);return res.status(200).send('ignored')}
 const occurredAt=ev.occurredAt||new Date().toISOString();
 const {data:applied,error}=await admin.rpc('ai_apply_twilio_event',{p_attempt_id:attempt,p_event_id:eventId,p_status:ev.status,p_payload:safePayload,p_occurred_at:occurredAt});
 const processingStatus=error?'failed':applied?.applied?'processed':'ignored';const processingError=error?.message||(!applied?.applied?applied?.reason:null);
 await admin.from('ai_provider_webhook_events').update({processing_status:processingStatus,processed_at:new Date().toISOString(),processing_error:processingError}).eq('id',inbox.id);
 return res.status(error?500:200).send(error?'processing failed':processingStatus==='processed'?'ok':'ignored');
}
