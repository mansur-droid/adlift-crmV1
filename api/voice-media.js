import {createServer} from 'node:http';
import crypto from 'node:crypto';
import twilio from 'twilio';
import {WebSocketServer} from 'ws';
import {createClient} from '@supabase/supabase-js';
import {serverConfig,uuid} from './_telephony/server.js';
import {loadConversationContext} from './_voice/context.js';
import {createVoiceProviders} from './_voice/providers/index.js';
import {createTwilioMediaTransport} from './_voice/media/twilio.js';
import {VoiceOrchestrator} from './_voice/orchestrator.js';

const voiceUrl=()=>String(process.env.VOICE_MEDIA_WSS_URL||`${String(process.env.TWILIO_WEBHOOK_BASE_URL||'').replace(/^https:/,'wss:').replace(/\/$/,'')}/api/voice-media`);
const tokenHash=v=>crypto.createHash('sha256').update(String(v||'')).digest('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const cfg=serverConfig();
const admin=cfg.url&&cfg.service?createClient(cfg.url,cfg.service,{auth:{persistSession:false,autoRefreshToken:false}}):null;

async function boundAttempt(attemptId,callSid){for(let n=0;n<8;n++){const {data}=await admin.from('ai_call_attempts').select('id,provider_call_id,controlled_test').eq('id',attemptId).maybeSingle();if(data?.controlled_test&&data.provider_call_id===callSid)return data;if(n<7)await delay(250)}return null}
function reject(socket,status='403 Forbidden'){socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);socket.destroy()}
function close(ws,code,reason){try{ws.close(code,String(reason).slice(0,120))}catch{try{ws.terminate()}catch{}}}

export async function handleVoiceSocketClose(orchestrator){if(orchestrator&&!orchestrator.closed)await orchestrator.stop('websocket_closed')}
export async function handleVoiceSocketError(orchestrator,error){if(orchestrator&&!orchestrator.closed)await orchestrator.fail('media',error)}

const server=createServer((req,res)=>{res.statusCode=req.url==='/api/voice-media/health'?200:426;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:req.url==='/api/voice-media/health',phase:7,realtime:true}))});
const wss=new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:false});

server.on('upgrade',(req,socket,head)=>{
 const signature=String(req.headers['x-twilio-signature']||'');const url=voiceUrl();
 if(!admin||!url.startsWith('wss://')||!process.env.TWILIO_AUTH_TOKEN||!twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN,signature,url,{}))return reject(socket);
 wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
});

wss.on('connection',ws=>{
 let orchestrator=null;const transport=createTwilioMediaTransport({socket:ws});let started=false;let messages=0;const timer=setTimeout(()=>close(ws,1008,'start timeout'),8000);
 ws.on('message',async raw=>{if(++messages>200000)return close(ws,1008,'message limit');let evt;try{evt=JSON.parse(String(raw))}catch{return close(ws,1003,'malformed json')}
  try{
   if(evt.event==='connected')return;
   if(evt.event==='start'){
    if(started)return;started=true;clearTimeout(timer);const media=transport.start(evt),cp=media.customParameters||{},attemptId=String(cp.attemptId||''),token=String(cp.mediaToken||'');
    if(!uuid(attemptId)||token.length<32)return close(ws,1008,'invalid binding');
    const {data:session}=await admin.from('ai_voice_sessions').select('*').eq('attempt_id',attemptId).maybeSingle();
    if(!session||session.media_token_hash!==tokenHash(token)||new Date(session.expires_at).getTime()<Date.now())return close(ws,1008,'invalid session');
    if(session.stream_sid&&session.stream_sid!==media.streamSid&&!['failed','completed'].includes(session.status))return close(ws,1008,'duplicate stream');
    if(!await boundAttempt(attemptId,media.callSid))return close(ws,1008,'call mismatch');
    if(String(media.mediaFormat?.encoding||'').toLowerCase()!=='audio/x-mulaw'||Number(media.mediaFormat?.sampleRate)!==8000)return close(ws,1003,'unsupported audio');
    const context=await loadConversationContext(admin,attemptId),providers=createVoiceProviders({providerConfigs:context.providerConfigs});
    await admin.from('ai_voice_sessions').update({provider_call_id:media.callSid,stream_sid:media.streamSid,status:'connecting',worker_instance:process.env.VERCEL_REGION||process.env.HOSTNAME||'voice-media'}).eq('id',session.id);
    orchestrator=new VoiceOrchestrator({admin,session:{...session,provider_call_id:media.callSid,stream_sid:media.streamSid},context,providers,transport,socket:ws});await orchestrator.start();return;
   }
   if(!orchestrator)return;if(evt.event==='media')return orchestrator.onMedia(evt);if(evt.event==='mark')return await orchestrator.onMark(evt);if(evt.event==='stop')return await orchestrator.stop('twilio_stream_stop');
  }catch(e){if(orchestrator)await orchestrator.fail('media',e);else close(ws,1011,'startup failed')}
 });
 ws.on('close',async()=>{clearTimeout(timer);await handleVoiceSocketClose(orchestrator)});
 ws.on('error',async e=>{clearTimeout(timer);await handleVoiceSocketError(orchestrator,e)});
});

export default server;
