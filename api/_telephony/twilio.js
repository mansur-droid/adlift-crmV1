import twilio from 'twilio';
import {buildVoiceMediaResponse} from '../_voice/twiml.js';

export const TWILIO_PROVIDER='twilio';
export function twilioConfig(env=process.env){
 const accountSid=env.TWILIO_ACCOUNT_SID||'';const authToken=env.TWILIO_AUTH_TOKEN||'';const fromNumber=env.TWILIO_FROM_NUMBER||'';
 const webhookBase=(env.TWILIO_WEBHOOK_BASE_URL||env.PUBLIC_APP_URL||'').replace(/\/$/,'');
 const accountSidValid=/^AC[0-9a-fA-F]{32}$/.test(accountSid);const fromNumberValid=/^\+[1-9][0-9]{7,14}$/.test(fromNumber);const webhookValid=/^https:\/\//i.test(webhookBase);
 const configured=Boolean(accountSidValid&&authToken&&fromNumberValid&&webhookValid);
 let configurationError=null;if(!accountSidValid)configurationError='TWILIO_ACCOUNT_SID is missing or invalid.';else if(!authToken)configurationError='TWILIO_AUTH_TOKEN is missing.';else if(!fromNumberValid)configurationError='TWILIO_FROM_NUMBER must be international E.164.';else if(!webhookValid)configurationError='TWILIO_WEBHOOK_BASE_URL must be a public HTTPS origin.';
 return {accountSid,authToken,fromNumber,webhookBase,accountSidValid,fromNumberValid,webhookValid,configured,configurationError};
}
export function classifyTwilioError(e){
 const code=String(e?.code||'TWILIO_ERROR');const status=Number(e?.status||0);let kind='provider_error',internalStatus='provider_rejected';
 if(status===401||code==='20003'){kind='authentication_failure';internalStatus='provider_auth_error'}
 else if(status===429||code==='20429'){kind='rate_limited';internalStatus='provider_rejected'}
 else if(code==='21211'){kind='invalid_destination';internalStatus='provider_rejected'}
 else if(code==='21212'){kind='invalid_from_number';internalStatus='provider_rejected'}
 else if(!status){kind='network_error';internalStatus='provider_network_error'}
 return {kind,internalStatus,code,message:String(e?.message||'Twilio request failed').slice(0,500),status};
}
export function normalizeTwilioStatus(s){return ({queued:'initiating',initiated:'initiating',ringing:'ringing','in-progress':'connected',completed:'completed',busy:'busy','no-answer':'no_answer',canceled:'cancelled',failed:'provider_failed'})[String(s||'')]||null}
export function parseTwilioEvent(params={}){
 const rawTimestamp=params.Timestamp||null;const parsed=rawTimestamp?Date.parse(rawTimestamp):NaN;const seq=/^\d+$/.test(String(params.SequenceNumber||''))?Number(params.SequenceNumber):null;const duration=/^\d+$/.test(String(params.CallDuration||''))?Number(params.CallDuration):null;
 return {callSid:String(params.CallSid||''),status:String(params.CallStatus||''),accountSid:String(params.AccountSid||''),duration,sequenceNumber:seq,occurredAt:Number.isFinite(parsed)?new Date(parsed).toISOString():null,payload:params};
}
export function createTwilioProvider({env=process.env,twilioLib=twilio}={}){
 const cfg=twilioConfig(env);const client=cfg.configured?twilioLib(cfg.accountSid,cfg.authToken):null;
 return {
  slug:TWILIO_PROVIDER,
  status(){const mediaUrl=env.VOICE_MEDIA_WSS_URL||cfg.webhookBase.replace(/^https:/i,'wss:')+'/api/voice-media';const mediaConfigured=/^wss:\/\//i.test(mediaUrl);return {provider:'twilio',configured:cfg.configured,fromNumberConfigured:cfg.fromNumberValid,fromNumber:cfg.fromNumberValid?cfg.fromNumber:null,webhookConfigured:cfg.webhookValid,voiceMediaConfigured:mediaConfigured,readyForTest:cfg.configured&&mediaConfigured,configurationError:cfg.configurationError||(!mediaConfigured?'Voice media WebSocket URL is missing.':null)}},
  async createCall({to,attemptId,mediaToken}){if(!client)throw Object.assign(new Error('Twilio is not configured.'),{safe:{kind:'missing_configuration',internalStatus:'provider_rejected',code:'MISSING_CONFIGURATION',message:'Twilio is not configured.',status:0}});const mediaUrl=env.VOICE_MEDIA_WSS_URL||cfg.webhookBase.replace(/^https:/i,'wss:')+'/api/voice-media';try{return await client.calls.create({to,from:cfg.fromNumber,twiml:buildVoiceMediaResponse(twilioLib,{url:mediaUrl,attemptId,mediaToken}),statusCallback:`${cfg.webhookBase}/api/twilio-webhook?attempt=${encodeURIComponent(attemptId)}`,statusCallbackMethod:'POST',statusCallbackEvent:['initiated','ringing','answered','completed'],timeout:20,timeLimit:Math.min(600,Math.max(30,Number(env.PHASE7_MAX_CALL_SECONDS||180)))});}catch(e){e.safe=classifyTwilioError(e);throw e}},
  async cancelCall(callSid){if(!client)throw Object.assign(new Error('Twilio is not configured.'),{safe:{kind:'missing_configuration'}});try{const current=await client.calls(callSid).fetch();const desired=['queued','ringing'].includes(current.status)?'canceled':'completed';return await client.calls(callSid).update({status:desired});}catch(e){e.safe=classifyTwilioError(e);throw e}},
  async fetchCall(callSid){if(!client)throw Object.assign(new Error('Twilio is not configured.'),{safe:{kind:'missing_configuration'}});try{return await client.calls(callSid).fetch();}catch(e){e.safe=classifyTwilioError(e);throw e}},
  async fetchCallCost(callSid){const c=await this.fetchCall(callSid);const n=c.price==null||c.price===''?null:Number(c.price);return {available:Number.isFinite(n),price:Number.isFinite(n)?Math.abs(n):null,currency:c.priceUnit||null,connectedDuration:c.duration==null||c.duration===''?null:Number(c.duration),status:c.status,startTime:c.startTime||null,endTime:c.endTime||null};},
  validateWebhook({signature,url,params}){if(!cfg.authToken)return false;return twilioLib.validateRequest(cfg.authToken,signature||'',url,params||{})},
  parseProviderEvent:parseTwilioEvent,
  normalizeProviderStatus:normalizeTwilioStatus,
  async reconcileCall(callSid){return this.fetchCallCost(callSid)}
 };
}
