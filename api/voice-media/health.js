import {twilioConfig} from '../_telephony/twilio.js';
import {voiceProviderStatus} from '../_voice/providers/index.js';

export function createVoiceMediaHealthHandler({env=process.env}={}){
 return function handler(req,res){
  res.setHeader?.('Cache-Control','no-store');
  res.setHeader?.('Content-Type','application/json');
  if(req.method!=='GET'){
   res.statusCode=405;
   res.end(JSON.stringify({ok:false,error:'Method not allowed.'}));
   return;
  }

  const twilio=twilioConfig(env);
  const voice=voiceProviderStatus(env);
  const configuredMediaUrl=String(env.VOICE_MEDIA_WSS_URL||'');
  const derivedMediaUrl=twilio.webhookBase?`${twilio.webhookBase.replace(/^https:/i,'wss:')}/api/voice-media`:'';
  const mediaUrl=configuredMediaUrl||derivedMediaUrl;
  const mediaConfigured=/^wss:\/\//i.test(mediaUrl);
  const ready=Boolean(twilio.configured&&mediaConfigured&&voice.deepgram?.configured&&voice.openai?.configured);

  res.statusCode=ready?200:503;
  res.end(JSON.stringify({
   ok:ready,
   phase:7,
   realtime:true,
   websocketPath:'/api/voice-media',
   mediaConfigured,
   twilioConfigured:Boolean(twilio.configured),
   deepgramConfigured:Boolean(voice.deepgram?.configured),
   openaiConfigured:Boolean(voice.openai?.configured),
   controlledTestEnabled:String(env.TWILIO_CONTROLLED_TEST_ENABLED||'')==='true',
   bulkDialingEnabled:false,
   autonomousCampaignConsumption:false
  }));
 };
}

export default createVoiceMediaHealthHandler();
