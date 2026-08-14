import test from 'node:test';
import assert from 'node:assert/strict';
import {createGroqLLM} from '../api/_voice/providers/groq.js';

function sse(delta='Hey — quick question.'){
 const enc=new TextEncoder();
 return new ReadableStream({start(controller){controller.enqueue(enc.encode(`data: ${JSON.stringify({choices:[{delta:{content:delta}}]})}\n\n`));controller.enqueue(enc.encode('data: [DONE]\n\n'));controller.close()}})
}
function collect(llm,user='Hello?'){return (async()=>{let text='';for await(const x of llm.streamResponse({system:'You are a concise phone caller.',history:[],user,signal:new AbortController().signal}))text+=x.delta;return text})()}

test('Hello opening conversation path is explicit text and cannot inherit compliance schema',async()=>{
 const bodies=[];
 const llm=createGroqLLM({apiKey:'configured',fetchImpl:async(_url,opts)=>{const body=JSON.parse(opts.body);bodies.push(body);return new Response(sse('Hey — quick question.'),{status:200})}});
 assert.equal(await collect(llm,'Hello?'),'Hey — quick question.');
 assert.equal(bodies.length,1);
 assert.equal(bodies[0].model,'openai/gpt-oss-20b');
 assert.deepEqual(bodies[0].response_format,{type:'text'});
 assert.equal(bodies[0].reasoning_format,'hidden');
 assert.equal(bodies[0].reasoning_effort,'low');
 assert.equal('json_schema' in bodies[0].response_format,false);
});

test('compliance GPT-OSS request pairs JSON schema with hidden reasoning',async()=>{
 let body;
 const llm=createGroqLLM({apiKey:'configured',fetchImpl:async(_url,opts)=>{body=JSON.parse(opts.body);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({allowed:true,violations:[],unsupported_claims:[]})}}]}),{status:200})}});
 const verdict=await llm.validate({candidate:'How are you getting most of your business?',hardRules:[],knowledge:[],signal:new AbortController().signal});
 assert.equal(verdict.allowed,true);
 assert.equal(body.response_format.type,'json_schema');
 assert.equal(body.response_format.json_schema.strict,true);
 assert.equal(body.reasoning_format,'hidden');
 assert.equal(body.stream,false);
});

test('production-style failed_generation 400 on compliance gets one bounded JSON-object recovery',async()=>{
 const bodies=[];let calls=0;
 const failed={error:{message:"Parsing failed. The model generated output that could not be parsed. Please adjust your prompt. See 'failed_generation' for more details.",type:'invalid_request_error',failed_generation:{reason:'structured output parser could not complete'}}};
 const llm=createGroqLLM({apiKey:'configured',fetchImpl:async(_url,opts)=>{calls++;const body=JSON.parse(opts.body);bodies.push(body);if(calls===1)return new Response(JSON.stringify(failed),{status:400});return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({allowed:true,violations:[],unsupported_claims:[]})}}]}),{status:200})}});
 const verdict=await llm.validate({candidate:'Hey — quick question.',hardRules:[],knowledge:[],signal:new AbortController().signal});
 assert.equal(verdict.allowed,true);
 assert.equal(calls,2);
 assert.equal(bodies[0].response_format.type,'json_schema');
 assert.equal(bodies[0].reasoning_format,'hidden');
 assert.deepEqual(bodies[1].response_format,{type:'json_object'});
 assert.equal(bodies[1].reasoning_format,'hidden');
});

test('failed_generation diagnostics are sanitized and identify conversation request kind',async()=>{
 const secret='gsk_secret_value_123456789';
 const failed={error:{message:`Parsing failed for Bearer ${secret}`,failed_generation:{reason:`bad protocol near ${secret}`,tool_call_id:'call_123'}}};
 const llm=createGroqLLM({apiKey:'configured',fetchImpl:async()=>new Response(JSON.stringify(failed),{status:400})});
 await assert.rejects(collect(llm),e=>{
  assert.equal(e.code,'LLM_PROVIDER');
  assert.equal(e.status,400);
  assert.equal(e.requestKind,'conversation');
  assert.equal(e.providerDiagnostic.request_kind,'conversation');
  assert.equal(e.providerDiagnostic.structured_output,false);
  assert.equal(e.providerDiagnostic.failed_generation.present,true);
  assert.equal(e.providerDiagnostic.failed_generation.tool_call_id,'call_123');
  assert.equal(e.providerDiagnostic.failed_generation.reason.includes(secret),false);
  assert.equal(e.message.includes(secret),false);
  return true;
 });
});

test('malformed compliance fallback remains fail closed',async()=>{
 let calls=0;
 const failed={error:{message:'Parsing failed.',failed_generation:{reason:'schema parse'}}};
 const llm=createGroqLLM({apiKey:'configured',fetchImpl:async()=>{calls++;if(calls===1)return new Response(JSON.stringify(failed),{status:400});return new Response(JSON.stringify({choices:[{message:{content:'not-json'}}]}),{status:200})}});
 const verdict=await llm.validate({candidate:'Unsupported guarantee',hardRules:[],knowledge:[],signal:new AbortController().signal});
 assert.equal(verdict.allowed,false);
 assert.deepEqual(verdict.violations,['validator_parse_failure']);
 assert.equal(calls,2);
});
