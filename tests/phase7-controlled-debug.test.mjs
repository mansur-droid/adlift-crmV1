import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createDeepgramSTT} from '../api/_voice/providers/deepgram.js';
import {createOpenAILLM} from '../api/_voice/providers/openai.js';
import {createControlledTestHandler} from '../api/ai-controlled-test-call.js';

class MockSocket extends EventEmitter{
 static OPEN=1;
 static instances=[];
 constructor(url,options){super();this.url=url;this.options=options;this.readyState=0;this.sent=[];MockSocket.instances.push(this)}
 send(value){this.sent.push(value)}
 open(){this.readyState=1;this.emit('open')}
 close(){this.readyState=3;this.emit('close',1000,'closed')}
 terminate(){this.close()}
}
function res(){return {statusCode:200,body:null,headers:{},setHeader(k,v){this.headers[k]=v},status(n){this.statusCode=n;return this},json(v){this.body=v;return this}}}
function req(body={}){return {method:'POST',body,headers:{authorization:'Bearer test'}}}
const readyProvider={status:()=>({configured:true,readyForTest:true,fromNumber:'+15005550006'}),createCall:async()=>{throw new Error('Twilio createCall must not be reached in this test')}};
function withOpenAIPreflight(rpc){const campaign={id:'11111111-1111-4111-8111-111111111111',stt_provider_slug:'deepgram',llm_provider_slug:'openai',tts_provider_slug:'deepgram'};const configs=[{provider_kind:'stt',provider_slug:'deepgram',enabled:true},{provider_kind:'llm',provider_slug:'openai',enabled:true},{provider_kind:'tts',provider_slug:'deepgram',enabled:true}];return {rpc,from(table){if(table==='ai_call_campaigns')return {select(){return {eq(){return {single:async()=>({data:campaign,error:null})}}}}};if(table==='ai_provider_configs')return {select(){return {eq:async()=>({data:configs,error:null})}};throw new Error(`unexpected table ${table}`)}}}

test('STT buffers Twilio audio during startup then forwards it on Deepgram open',async()=>{
 MockSocket.instances=[];const stt=createDeepgramSTT({apiKey:'configured',WebSocketImpl:MockSocket,setIntervalFn:()=>1,clearIntervalFn:()=>{}});const connecting=stt.connect();const socket=MockSocket.instances[0];
 const audio=Buffer.from([1,2,3,4]);assert.equal(stt.sendAudio(audio),true);assert.equal(socket.sent.length,0);socket.open();await connecting;assert.equal(socket.sent.length,1);assert.deepEqual([...socket.sent[0]],[1,2,3,4]);stt.close();
});

test('STT keepalive uses a Deepgram text control message during silence',async()=>{
 MockSocket.instances=[];let tick=null;const stt=createDeepgramSTT({apiKey:'configured',WebSocketImpl:MockSocket,now:()=>10000,setIntervalFn:fn=>{tick=fn;return 1},clearIntervalFn:()=>{}});const connecting=stt.connect();const socket=MockSocket.instances[0];socket.open();await connecting;tick();assert.match(String(socket.sent.at(-1)),/KeepAlive/);stt.close();
});

function sse(parts){const enc=new TextEncoder();let i=0;return new ReadableStream({pull(controller){if(i>=parts.length)return controller.close();controller.enqueue(enc.encode(parts[i++]));}})}
test('OpenAI voice request does not send temperature unless campaign provider settings explicitly configure it',async()=>{
 let body=null;const fetchImpl=async(_url,opts)=>{body=JSON.parse(opts.body);return new Response(sse(['event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n']),{status:200})};
 const llm=createOpenAILLM({apiKey:'configured',fetchImpl,settings:{model:'gpt-5-mini'}});for await(const _ of llm.streamResponse({system:'rules',history:[],user:'hello',signal:new AbortController().signal})){}assert.equal(Object.hasOwn(body,'temperature'),false);
});

test('OpenAI provider 400 preserves the sanitized provider reason',async()=>{
 const fetchImpl=async()=>new Response(JSON.stringify({error:{message:'Unsupported parameter: temperature'}}),{status:400});const llm=createOpenAILLM({apiKey:'configured',fetchImpl});await assert.rejects(async()=>{for await(const _ of llm.streamResponse({system:'rules',history:[],user:'hello',signal:new AbortController().signal})){}},e=>e.code==='LLM_PROVIDER'&&e.status===400&&/Unsupported parameter/.test(e.message));
});

test('controlled test API propagates the concrete Phase 5 reason instead of phase5_ineligible',async()=>{
 const admin=withOpenAIPreflight(async name=>name==='ai_reserve_controlled_test_attempt'?{data:{reserved:false,reason:'phase5_ineligible',eligibility:{eligible:false,reason_code:'outside_calling_window',lead_timezone:'America/New_York'}},error:null}:{data:null,error:null});
 const handler=createControlledTestHandler({providerFactory:()=>readyProvider,requireAdminFn:async()=>({admin,user:{id:'admin'}}),liveEnabledFn:()=>true,voiceStatusFn:()=>({deepgram:{configured:true},openai:{configured:true}})});const r=res();await handler(req({action:'place',confirmation:'PLACE ONE REAL TWILIO CALL',campaignId:'11111111-1111-4111-8111-111111111111',destination:'+12295373671',requestKey:'controlled_debug_key_0001'}),r);assert.equal(r.statusCode,409);assert.equal(r.body.reason,'outside_calling_window');assert.equal(r.body.reasonSource,'phase5_ineligible');
});

test('diagnostics action is read-only and returns exact database reason',async()=>{
 let called=null;const admin={rpc:async(name,args)=>{called={name,args};return {data:{eligible:false,reason_code:'attempt_limit_reached',lead_timezone:'America/New_York'},error:null}}};
 const handler=createControlledTestHandler({providerFactory:()=>readyProvider,requireAdminFn:async()=>({admin,user:{id:'admin'}}),liveEnabledFn:()=>false,voiceStatusFn:()=>({})});const r=res();await handler(req({action:'diagnose',campaignId:'11111111-1111-4111-8111-111111111111',destination:'+12295373671'}),r);assert.equal(r.statusCode,200);assert.equal(called.name,'ai_controlled_test_diagnostics');assert.equal(r.body.diagnostics.reason_code,'attempt_limit_reached');
});
