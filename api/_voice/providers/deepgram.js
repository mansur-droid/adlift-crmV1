import WebSocket from 'ws';

function timeoutMs(settings,key,fallback){const n=Number(settings?.[key]);return Number.isFinite(n)&&n>=100&&n<=60000?n:fallback}
function safeJson(data){try{return JSON.parse(String(data))}catch{return null}}
function utteranceEndMs(settings){const n=Number(settings?.utterance_end_ms??1000);return Number.isFinite(n)&&n>=1000&&n<=5000?Math.round(n):1000}

export function createDeepgramSTT({apiKey=process.env.DEEPGRAM_API_KEY,settings={},WebSocketImpl=WebSocket,now=()=>Date.now(),setIntervalFn=setInterval,clearIntervalFn=clearInterval}={}){
 const model=settings.model||'nova-3';const language=settings.language||'en';const endpointing=Number(settings.endpointing_ms||300);const utteranceEnd=utteranceEndMs(settings);
 const maxBufferedBytes=Math.max(8000,Math.min(128000,Number(settings.startup_buffer_bytes||64000)));const keepaliveMs=Math.max(3000,Math.min(5000,Number(settings.keepalive_ms||4000)));
 let ws=null;let opened=false;let closed=false;let lastAudioAt=0;let handlers={};let openTimer=null;let keepaliveTimer=null;let buffered=[];let bufferedBytes=0;let hadError=false;
 const url=new URL('wss://api.deepgram.com/v1/listen');
 for(const [k,v] of Object.entries({model,language,encoding:'mulaw',sample_rate:'8000',channels:'1',interim_results:'true',smart_format:'true',vad_events:'true',endpointing:String(endpointing),utterance_end_ms:String(utteranceEnd)}))url.searchParams.set(k,v);
 const stopKeepalive=()=>{if(keepaliveTimer){clearIntervalFn(keepaliveTimer);keepaliveTimer=null}};
 const startKeepalive=()=>{stopKeepalive();keepaliveTimer=setIntervalFn(()=>{if(!opened||closed||ws?.readyState!==WebSocketImpl.OPEN)return;if(!lastAudioAt||now()-lastAudioAt>=keepaliveMs-250){try{ws.send(JSON.stringify({type:'KeepAlive'}))}catch{}}},keepaliveMs)};
 const flushBuffered=()=>{if(!opened||closed||ws?.readyState!==WebSocketImpl.OPEN)return;for(const chunk of buffered)ws.send(chunk);buffered=[];bufferedBytes=0};
 const bufferAudio=buffer=>{const copy=Buffer.from(buffer);buffered.push(copy);bufferedBytes+=copy.length;while(bufferedBytes>maxBufferedBytes&&buffered.length){const removed=buffered.shift();bufferedBytes-=removed.length}};
 return {
  slug:'deepgram',kind:'stt',status(){return {configured:Boolean(apiKey),model,encoding:'mulaw',sampleRate:8000}},
  connect(nextHandlers={}){handlers=nextHandlers;return new Promise((resolve,reject)=>{
   if(!apiKey)return reject(Object.assign(new Error('Deepgram STT API key missing.'),{code:'STT_CONFIG'}));
   ws=new WebSocketImpl(url.toString(),{headers:{Authorization:`Token ${apiKey}`}});
   openTimer=setTimeout(()=>{hadError=true;try{ws.terminate?.()}catch{};reject(Object.assign(new Error('Deepgram STT connection timeout.'),{code:'STT_TIMEOUT'}))},timeoutMs(settings,'connect_timeout_ms',8000));
   ws.on('open',()=>{opened=true;clearTimeout(openTimer);flushBuffered();startKeepalive();handlers.onState?.('connected');resolve()});
   ws.on('message',raw=>{const msg=safeJson(raw);if(!msg)return;
    if(msg.type==='SpeechStarted'){handlers.onSpeechStarted?.({atMs:now(),provider:msg});return}
    if(msg.type==='UtteranceEnd'){handlers.onUtteranceEnd?.({atMs:now(),provider:msg});return}
    if(msg.type!=='Results')return;
    const alt=msg.channel?.alternatives?.[0];const text=String(alt?.transcript||'').trim();if(!text)return;
    const evt={text,confidence:Number.isFinite(alt?.confidence)?alt.confidence:null,isFinal:Boolean(msg.is_final),speechFinal:Boolean(msg.speech_final),providerSegmentId:msg.metadata?.request_id||null,startMs:Math.max(0,Math.round(Number(msg.start||0)*1000)),endMs:Math.max(0,Math.round((Number(msg.start||0)+Number(msg.duration||0))*1000)),receivedAtMs:now(),lastAudioAtMs:lastAudioAt,provider:msg};
    if(evt.isFinal)handlers.onFinal?.(evt);else handlers.onInterim?.(evt);
   });
   ws.on('error',e=>{hadError=true;const err=Object.assign(e,{code:e.code||'STT_ERROR'});handlers.onError?.(err);if(!opened){clearTimeout(openTimer);reject(err)}});
   ws.on('close',(code,reason)=>{closed=true;stopKeepalive();handlers.onState?.('closed');if(!hadError)handlers.onClose?.({code,reason:String(reason||'')})});
  })},
  sendAudio(buffer){if(closed||!buffer?.length)return false;lastAudioAt=now();if(!opened||ws?.readyState!==WebSocketImpl.OPEN){bufferAudio(buffer);return true}ws.send(buffer);return true},
  finalize(){if(opened&&!closed&&ws?.readyState===WebSocketImpl.OPEN)ws.send(JSON.stringify({type:'Finalize'}))},
  close(){closed=true;clearTimeout(openTimer);stopKeepalive();buffered=[];bufferedBytes=0;if(ws&&ws.readyState===WebSocketImpl.OPEN){try{ws.send(JSON.stringify({type:'CloseStream'}))}catch{};setTimeout(()=>{try{ws.close()}catch{}},20)}else try{ws?.close?.()}catch{}},
  get ready(){return opened&&!closed}
 };
}

export function createDeepgramTTS({apiKey=process.env.DEEPGRAM_API_KEY,settings={},WebSocketImpl=WebSocket,now=()=>Date.now()}={}){
 const model=settings.model||'aura-2-thalia-en';const speed=Number(settings.speed||1);let ws=null;let opened=false;let closed=false;let handlers={};let firstAudioPending=false;let requestStartedAt=0;let openTimer=null;let firstAudioTimer=null;
 const url=new URL('wss://api.deepgram.com/v1/speak');url.searchParams.set('model',model);url.searchParams.set('encoding','mulaw');url.searchParams.set('sample_rate','8000');if(Number.isFinite(speed)&&speed>=0.7&&speed<=1.5)url.searchParams.set('speed',String(speed));
 const clearFirstAudioTimer=()=>{clearTimeout(firstAudioTimer);firstAudioTimer=null};
 const armFirstAudioTimer=()=>{clearFirstAudioTimer();firstAudioTimer=setTimeout(()=>{if(!firstAudioPending||closed)return;firstAudioPending=false;const e=Object.assign(new Error('Deepgram TTS first-audio timeout.'),{code:'TTS_TIMEOUT'});handlers.onError?.(e)},timeoutMs(settings,'first_audio_timeout_ms',5000))};
 return {
  slug:'deepgram',kind:'tts',status(){return {configured:Boolean(apiKey),model,encoding:'mulaw',sampleRate:8000}},
  connect(nextHandlers={}){handlers=nextHandlers;return new Promise((resolve,reject)=>{
   if(!apiKey)return reject(Object.assign(new Error('Deepgram TTS API key missing.'),{code:'TTS_CONFIG'}));
   ws=new WebSocketImpl(url.toString(),{headers:{Authorization:`Token ${apiKey}`}});
   openTimer=setTimeout(()=>{try{ws.terminate?.()}catch{};reject(Object.assign(new Error('Deepgram TTS connection timeout.'),{code:'TTS_TIMEOUT'}))},timeoutMs(settings,'connect_timeout_ms',8000));
   ws.on('open',()=>{opened=true;clearTimeout(openTimer);handlers.onState?.('connected');resolve()});
   ws.on('message',(raw,isBinary)=>{if(isBinary||Buffer.isBuffer(raw)){if(firstAudioPending){firstAudioPending=false;clearFirstAudioTimer();handlers.onFirstAudio?.({latencyMs:Math.max(0,now()-requestStartedAt)})}handlers.onAudio?.(Buffer.from(raw));return}const msg=safeJson(raw);if(!msg)return;if(msg.type==='Flushed')handlers.onFlushed?.(msg);if(msg.type==='Cleared')handlers.onCleared?.(msg);if(msg.type==='Warning')handlers.onWarning?.(msg)});
   ws.on('error',e=>{handlers.onError?.(Object.assign(e,{code:e.code||'TTS_ERROR'}));if(!opened){clearTimeout(openTimer);reject(e)}});
   ws.on('close',(code,reason)=>{closed=true;clearFirstAudioTimer();handlers.onState?.('closed');handlers.onClose?.({code,reason:String(reason||'')})});
  })},
  speak(text){if(!opened||closed||!String(text||'').trim())return false;if(!firstAudioPending){firstAudioPending=true;requestStartedAt=now();armFirstAudioTimer()}ws.send(JSON.stringify({type:'Speak',text:String(text)}));return true},
  flush(){if(opened&&!closed)ws.send(JSON.stringify({type:'Flush'}))},
  clear(){if(opened&&!closed){firstAudioPending=false;clearFirstAudioTimer();ws.send(JSON.stringify({type:'Clear'}));handlers.onState?.('clearing')}},
  close(){closed=true;clearTimeout(openTimer);clearFirstAudioTimer();if(opened&&ws?.readyState===WebSocketImpl.OPEN){try{ws.send(JSON.stringify({type:'Close'}))}catch{};setTimeout(()=>{try{ws.close()}catch{}},20)}else try{ws?.close?.()}catch{}},
  get ready(){return opened&&!closed}
 };
}
