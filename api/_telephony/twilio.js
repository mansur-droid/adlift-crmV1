import twilio from 'twilio';

export const TWILIO_PROVIDER='twilio';
export function twilioConfig(){
 const accountSid=process.env.TWILIO_ACCOUNT_SID||'';const authToken=process.env.TWILIO_AUTH_TOKEN||'';const fromNumber=process.env.TWILIO_FROM_NUMBER||'';
 const webhookBase=(process.env.TWILIO_WEBHOOK_BASE_URL||process.env.PUBLIC_APP_URL||'').replace(/\/$/,'');
 return {accountSid,authToken,fromNumber,webhookBase,configured:Boolean(accountSid&&authToken&&fromNumber&&webhookBase)};
}
function safeError(e){const code=String(e?.code||'TWILIO_ERROR');const status=Number(e?.status||0);let kind='provider_error';if(status===401||code==='20003')kind='authentication_failure';else if(status===429||code==='20429')kind='rate_limited';else if(code==='21211')kind='invalid_destination';else if(code==='21212')kind='invalid_from_number';return {kind,code,message:String(e?.message||'Twilio request failed').slice(0,500),status};}
export function createTwilioProvider(){
 const cfg=twilioConfig();const client=cfg.configured?twilio(cfg.accountSid,cfg.authToken):null;
 return {
  slug:TWILIO_PROVIDER,
  status(){return {provider:'twilio',configured:cfg.configured,fromNumberConfigured:Boolean(cfg.fromNumber),webhookConfigured:Boolean(cfg.webhookBase),readyForTest:cfg.configured,configurationError:cfg.configured?null:'Missing required server-side Twilio configuration.'}},
  async createCall({to,attemptId}){if(!client)throw Object.assign(new Error('Twilio is not configured.'),{safe:{kind:'missing_configuration'}});try{return await client.calls.create({to,from:cfg.fromNumber,twiml:'<Response><Pause length="20"/></Response>',statusCallback:`${cfg.webhookBase}/api/twilio-webhook?attempt=${encodeURIComponent(attemptId)}`,statusCallbackMethod:'POST',statusCallbackEvent:['initiated','ringing','answered','completed'],timeout:20});}catch(e){e.safe=safeError(e);throw e}},
  async cancelCall(callSid){if(!client)throw new Error('Twilio is not configured.');try{return await client.calls(callSid).update({status:'completed'});}catch(e){e.safe=safeError(e);throw e}},
  async fetchCall(callSid){if(!client)throw new Error('Twilio is not configured.');try{return await client.calls(callSid).fetch();}catch(e){e.safe=safeError(e);throw e}},
  async fetchCallCost(callSid){const c=await this.fetchCall(callSid);return {available:c.price!=null&&c.price!=='',price:c.price==null?null:Math.abs(Number(c.price)),currency:c.priceUnit||null,duration:c.duration==null?null:Number(c.duration),status:c.status,startTime:c.startTime,endTime:c.endTime};},
  validateWebhook({signature,url,params}){if(!cfg.authToken)return false;return twilio.validateRequest(cfg.authToken,signature||'',url,params||{});},
  parseProviderEvent(params){return {callSid:params.CallSid||'',status:params.CallStatus||'',accountSid:params.AccountSid||'',duration:params.CallDuration||null,payload:params};},
  normalizeProviderStatus(s){return ({queued:'initiating',initiated:'initiating',ringing:'ringing','in-progress':'connected',completed:'completed',busy:'provider_failed','no-answer':'no_answer',canceled:'cancelled',failed:'provider_failed'})[s]||'provider_failed';},
  async reconcileCall(callSid){return this.fetchCallCost(callSid)}
 };
}
