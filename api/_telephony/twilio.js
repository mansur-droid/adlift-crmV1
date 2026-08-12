import twilio from 'twilio';

export const TWILIO_PROVIDER='twilio';
export function twilioConfig(env=process.env){
 const accountSid=env.TWILIO_ACCOUNT_SID||'';const authToken=env.TWILIO_AUTH_TOKEN||'';const fromNumber=env.TWILIO_FROM_NUMBER||'';
 const webhookBase=(env.TWILIO_WEBHOOK_BASE_URL||env.PUBLIC_APP_URL||'').replace(/\/$/,'');
 return {accountSid,authToken,fromNumber,webhookBase,configured:Boolean(accountSid&&authToken&&fromNumber&&webhookBase)};
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
  status(){return {provider:'twilio',configured:cfg.configured,fromNumberConfigured:Boolean(cfg.fromNumber),fromNumber:cfg.fromNumber||null,webhookConfigured:Boolean(cfg.webhookBase),readyForTest:cfg.configured,configurationError:cfg.configured?null:'Missing required server-side Twilio configuration.'}},
  async createCall({to,attemptId}){if(!client)throw Object.assign(new Error('Twilio is not configured.'),{safe:{kind:'missing_configuration',internalStatus:'provider_rejected',code:'MISSING_CONFIGURATION',message:'Twilio is not configured.',status:0}});try{return await client.calls.create({to,from:cfg.fromNumber,twiml:'<Response><Pause length="20"/></Response>',statusCallback:`${cfg.webhookBase}/api/twilio-webhook?attempt=${encodeURIComponent(attemptId)}`,statusCallbackMethod:'POST',statusCallbackEvent:['initiated','ringing','answered','completed'],timeout:20,timeLimit:30});}catch(e){e.safe=classifyTwilioError(e);throw e}},
  async cancelCall(callSid){if(!client)throw Object.assign(new Error('Twilio is not configured.'),{safe:{kind:'missing_configuration'}});try{const current=await client.calls(callSid).fetch();const desired=['queued','ringing'].includes(current.status)?'canceled':'completed';return await client.calls(callSid).update({status:desired});}catch(e){e.safe=classifyTwilioError(e);throw e}},
  async fetchCall(callSid){if(!client)throw Object.assign(new Error('Twilio is not configured.'),{safe:{kind:'missing_configuration'}});try{return await client.calls(callSid).fetch();}catch(e){e.safe=classifyTwilioError(e);throw e}},
  async fetchCallCost(callSid){const c=await this.fetchCall(callSid);const n=c.price==null||c.price===''?null:Number(c.price);return {available:Number.isFinite(n),price:Number.isFinite(n)?Math.abs(n):null,currency:c.priceUnit||null,connectedDuration:c.duration==null||c.duration===''?null:Number(c.duration),status:c.status,startTime:c.startTime||null,endTime:c.endTime||null};},
  validateWebhook({signature,url,params}){if(!cfg.authToken)return false;return twilioLib.validateRequest(cfg.authToken,signature||'',url,params||{})},
  parseProviderEvent:parseTwilioEvent,
  normalizeProviderStatus:normalizeTwilioStatus,
  async reconcileCall(callSid){return this.fetchCallCost(callSid)}
 };
}
