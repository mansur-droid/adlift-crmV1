import test from 'node:test';
import assert from 'node:assert/strict';
import {createGroqLLM} from '../api/_voice/providers/groq.js';
import {createVoiceProviders,supportedVoiceProviders,voiceProviderStatus} from '../api/_voice/providers/index.js';
import {createControlledTestHandler,preflightSelectedVoiceProviders} from '../api/ai-controlled-test-call.js';

function sse(parts){const enc=new TextEncoder();let i=0;return new ReadableStream({pull(controller){if(i>=parts.length)return controller.close();controller.enqueue(enc.encode(parts[i++]));}})}
function groqStream(...deltas){return sse([...deltas.map(delta=>`data: ${JSON.stringify({choices:[{delta:{content:delta}}]})}\n\n`),'data: [DONE]\n\n'])}
function collect(llm,args={}){return (async()=>{const out=[];for await(const item of llm.streamResponse({system:'rules',history:[],user:'hello',signal:new AbortController().signal,...args}))out.push(item);return out})()}

function preflightAdmin(campaign,configs=[]){
 return {from(table){
  if(table==='ai_call_campaigns')return {select(){return {eq(){return {single:async()=>({data:campaign,error:null})}}}}};
  if(table==='ai_provider_configs')return {select(){return {eq:async()=>({data:configs,error:null})}}};
  throw new Error(`unexpected table ${table}`);
 }};
}
function response(){return {statusCode:200,body:null,headers:{},setHeader(k,v){this.headers[k]=v},status(n){this.statusCode=n;return this},json(v){this.body=v;return this}}}
function request(body={}){return {method:'POST',body,headers:{authorization:'Bearer test'}}}
const readyTwilio={status:()=>({configured:true,readyForTest:true,fromNumber:'+15005550006'}),createCall:async()=>{throw new Error('Twilio must not be called in preflight tests')}};
const campaign={id:'11111111-1111-4111-8111-111111111111',stt_provider_slug:'deepgram',llm_provider_slug:'groq',tts_provider_slug:'deepgram'};
const enabledConfigs=[{provider_kind:'stt',provider_slug:'deepgram',enabled:true},{provider_kind:'llm',provider_slug:'groq',enabled:true},{provider_kind:'tts',provider_slug:'deepgram',enabled:true}];

test('Groq streams response text and measures first-token latency',async()=>{let clock=100;let body=null;const fetchImpl=async(_url,opts)=>{body=JSON.parse(opts.body);return new Response(groqStream('Hi',' there'),{status:200})};const llm=createGroqLLM({apiKey:'configured',fetchImpl,now:()=>++clock});const out=await collect(llm);assert.equal(out.map(x=>x.delta).join(''),'Hi there');assert.ok(Number.isFinite(out[0].firstTokenLatencyMs));assert.equal(out[1].firstTokenLatencyMs,null);assert.equal(body.stream,true);assert.equal(body.model,'openai/gpt-oss-120b');assert.equal(llm.status().validationModel,'openai/gpt-oss-20b');assert.equal(body.reasoning_effort,'low');assert.equal(body.messages[0].role,'system')});

test('Groq request abort cancels an in-flight generation',async()=>{const fetchImpl=async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error(String(signal.reason||'aborted')),{name:'AbortError'})),{once:true}));const llm=createGroqLLM({apiKey:'configured',fetchImpl,settings:{connect_timeout_ms:5000,timeout_ms:5000}});const controller=new AbortController();const run=(async()=>{for await(const _ of llm.streamResponse({system:'rules',history:[],user:'hello',signal:controller.signal})){} })();setTimeout(()=>controller.abort('barge in'),20);await assert.rejects(run,e=>e.name==='AbortError')});

test('Groq timeout is bounded and normalized',async()=>{const fetchImpl=async(_url,{signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error(String(signal.reason||'timeout')),{name:'AbortError'})),{once:true}));const llm=createGroqLLM({apiKey:'configured',fetchImpl,settings:{connect_timeout_ms:5000,timeout_ms:100}});await assert.rejects(collect(llm),e=>e.code==='LLM_TIMEOUT')});

test('Groq authentication failure is normalized',async()=>{const llm=createGroqLLM({apiKey:'configured',fetchImpl:async()=>new Response(JSON.stringify({error:{message:'invalid api key'}}),{status:401})});await assert.rejects(collect(llm),e=>e.code==='LLM_AUTH'&&e.status===401)});

test('Groq provider failure and rate limit are normalized separately',async()=>{const provider=createGroqLLM({apiKey:'configured',fetchImpl:async()=>new Response(JSON.stringify({error:{message:'provider unavailable'}}),{status:503})});await assert.rejects(collect(provider),e=>e.code==='LLM_PROVIDER'&&e.status===503);const rate=createGroqLLM({apiKey:'configured',fetchImpl:async()=>new Response(JSON.stringify({error:{message:'too many requests'}}),{status:429})});await assert.rejects(collect(rate),e=>e.code==='LLM_RATE_LIMIT'&&e.status===429)});

test('Groq provider errors are sanitized before surfacing',async()=>{const secret='gsk_super_secret_key_123456';const llm=createGroqLLM({apiKey:'configured',fetchImpl:async()=>new Response(JSON.stringify({error:{message:`Authorization Bearer ${secret} failed`}}),{status:400})});await assert.rejects(collect(llm),e=>e.code==='LLM_PROVIDER'&&!e.message.includes(secret)&&e.message.includes('[REDACTED]'))});

test('Groq malformed streaming response is normalized',async()=>{const llm=createGroqLLM({apiKey:'configured',fetchImpl:async()=>new Response(sse(['data: {not-json}\n\n']),{status:200})});await assert.rejects(collect(llm),e=>e.code==='LLM_MALFORMED_RESPONSE')});

test('Groq compliance validator allows a valid response and uses fast structured validator',async()=>{let body=null;const fetchImpl=async(_url,opts)=>{body=JSON.parse(opts.body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({allowed:true,violations:[],unsupported_claims:[]})}}]}),{status:200,headers:{'content-type':'application/json'}})};const llm=createGroqLLM({apiKey:'configured',fetchImpl});const verdict=await llm.validate({candidate:'May I ask how you get new clients?',hardRules:[],knowledge:[],signal:new AbortController().signal});assert.equal(verdict.allowed,true);assert.deepEqual(verdict.violations,[]);assert.equal(body.model,'openai/gpt-oss-20b');assert.equal(body.reasoning_effort,'low');assert.equal(body.response_format.type,'json_schema')});

test('Groq compliance validator blocks hard-rule and unsupported claims',async()=>{let body=null;const fetchImpl=async(_url,opts)=>{body=JSON.parse(opts.body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({allowed:false,violations:['hard_rule_violation'],unsupported_claims:['unsupported_result']})}}]}),{status:200,headers:{'content-type':'application/json'}})};const llm=createGroqLLM({apiKey:'configured',fetchImpl});const verdict=await llm.validate({candidate:'We guarantee ten clients.',hardRules:[{enforcement_level:'hard',priority:100,title:'No guarantees',rule_text:'Never guarantee results.'}],knowledge:[],signal:new AbortController().signal});assert.equal(verdict.allowed,false);assert.ok(verdict.violations.includes('hard_rule_violation'));assert.ok(verdict.unsupportedClaims.includes('unsupported_result'));const payload=JSON.parse(body.messages[1].content);assert.equal(payload.hard_rules[0].rule,'Never guarantee results.')});

test('Groq malformed compliance output fails closed',async()=>{const fetchImpl=async()=>new Response(JSON.stringify({choices:[{message:{content:'not-json'}}]}),{status:200,headers:{'content-type':'application/json'}});const llm=createGroqLLM({apiKey:'configured',fetchImpl});const verdict=await llm.validate({candidate:'claim',hardRules:[],knowledge:[],signal:new AbortController().signal});assert.equal(verdict.allowed,false);assert.deepEqual(verdict.violations,['validator_parse_failure'])});

test('voice provider factory selects Groq and still supports OpenAI',()=>{assert.deepEqual(supportedVoiceProviders.llm,['openai','groq']);const rows=[{provider_kind:'llm',provider_slug:'groq',enabled:true,settings:{model:'llama-test'}},{provider_kind:'llm',provider_slug:'openai',enabled:true,settings:{model:'openai-test'}}];const providers=createVoiceProviders({providerConfigs:rows,env:{GROQ_API_KEY:'groq-key',OPENAI_API_KEY:'openai-key'}});assert.equal(providers.llm('groq').slug,'groq');assert.equal(providers.llm('groq').status().model,'llama-test');assert.equal(providers.llm('openai').slug,'openai');assert.equal(providers.llm('openai').status().model,'openai-test')});

test('voice provider status reports Groq independently of OpenAI',()=>{const status=voiceProviderStatus({GROQ_API_KEY:'groq',DEEPGRAM_API_KEY:'dg'});assert.equal(status.groq.configured,true);assert.equal(status.openai.configured,false);assert.equal(status.deepgram.configured,true)});

test('Groq selected-provider preflight succeeds without OPENAI_API_KEY',async()=>{const result=await preflightSelectedVoiceProviders(preflightAdmin(campaign,enabledConfigs),campaign.id,{deepgram:{configured:true},groq:{configured:true},openai:{configured:false}});assert.equal(result.ok,true);assert.equal(result.selected.llm,'groq')});

test('Groq selected-provider preflight fails when GROQ_API_KEY is missing',async()=>{const result=await preflightSelectedVoiceProviders(preflightAdmin(campaign,enabledConfigs),campaign.id,{deepgram:{configured:true},groq:{configured:false},openai:{configured:true}});assert.equal(result.ok,false);assert.equal(result.reason,'llm_provider_secret_missing')});

test('selected LLM provider row must exist and be enabled',async()=>{const result=await preflightSelectedVoiceProviders(preflightAdmin(campaign,enabledConfigs.filter(x=>x.provider_kind!=='llm')),campaign.id,{deepgram:{configured:true},groq:{configured:true}});assert.equal(result.ok,false);assert.equal(result.reason,'llm_provider_not_enabled')});

test('controlled call cannot reach Twilio when selected Groq is unconfigured',async()=>{let calls=0;const provider={...readyTwilio,createCall:async()=>{calls++}};const admin=preflightAdmin(campaign,enabledConfigs);const handler=createControlledTestHandler({providerFactory:()=>provider,requireAdminFn:async()=>({admin,user:{id:'admin'}}),liveEnabledFn:()=>true,voiceStatusFn:()=>({deepgram:{configured:true},groq:{configured:false},openai:{configured:true}})});const r=response();await handler(request({action:'place',confirmation:'PLACE ONE REAL TWILIO CALL',campaignId:campaign.id,destination:'+12295373671',requestKey:'phase7_groq_preflight_0001'}),r);assert.equal(r.statusCode,503);assert.equal(r.body.reason,'llm_provider_secret_missing');assert.equal(calls,0)});
