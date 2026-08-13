import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createDeepgramSTT,createDeepgramTTS} from '../api/_voice/providers/deepgram.js';
import {createOpenAILLM} from '../api/_voice/providers/openai.js';

class MockSocket extends EventEmitter{
 static OPEN=1;
 static instances=[];
 constructor(url,options){super();this.url=url;this.options=options;this.readyState=0;this.sent=[];MockSocket.instances.push(this)}
 send(value){this.sent.push(value)}
 open(){this.readyState=1;this.emit('open')}
 message(value,isBinary=false){this.emit('message',value,isBinary)}
 close(){if(this.readyState===3)return;this.readyState=3;this.emit('close',1000,'closed')}
 terminate(){this.close()}
}

test('streaming STT exposes interim and final hypotheses with timing metadata',async()=>{
 MockSocket.instances=[];let interim=null,final=null;let now=1000;
 const stt=createDeepgramSTT({apiKey:'configured',WebSocketImpl:MockSocket,now:()=>now});
 const connecting=stt.connect({onInterim:e=>interim=e,onFinal:e=>final=e});const socket=MockSocket.instances[0];socket.open();await connecting;
 now=1010;stt.sendAudio(Buffer.from([1,2,3]));
 socket.message(JSON.stringify({type:'Results',is_final:false,speech_final:false,start:0.1,duration:0.2,channel:{alternatives:[{transcript:'hello',confidence:0.7}]}}));
 socket.message(JSON.stringify({type:'Results',is_final:true,speech_final:true,start:0.1,duration:0.4,channel:{alternatives:[{transcript:'hello there',confidence:0.93}]}}));
 assert.equal(interim.text,'hello');assert.equal(interim.isFinal,false);assert.equal(final.text,'hello there');assert.equal(final.isFinal,true);assert.equal(final.confidence,0.93);assert.equal(final.lastAudioAtMs,1010);stt.close();
});

test('streaming TTS emits first-audio latency and supports cancellation',async()=>{
 MockSocket.instances=[];let firstAudio=null;let audio=null;let now=2000;
 const tts=createDeepgramTTS({apiKey:'configured',WebSocketImpl:MockSocket,now:()=>now});
 const connecting=tts.connect({onFirstAudio:e=>firstAudio=e,onAudio:b=>audio=b});const socket=MockSocket.instances[0];socket.open();await connecting;
 tts.speak('hello');now=2030;socket.message(Buffer.from([7,8]),true);assert.equal(firstAudio.latencyMs,30);assert.deepEqual([...audio],[7,8]);tts.clear();assert.match(String(socket.sent.at(-1)),/Clear/);tts.close();
});

function stream(parts){const encoder=new TextEncoder();let i=0;return new ReadableStream({pull(controller){if(i>=parts.length)return controller.close();controller.enqueue(encoder.encode(parts[i++]));}})}

test('LLM abstraction streams dynamic response text',async()=>{
 let clock=1;const fetchImpl=async()=>new Response(stream(['event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hi"}\n\n','event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":" there"}\n\n']),{status:200});
 const llm=createOpenAILLM({apiKey:'configured',fetchImpl,now:()=>++clock,settings:{model:'test-model'}});const out=[];for await(const item of llm.streamResponse({system:'rules',history:[],user:'hello',signal:new AbortController().signal}))out.push(item);assert.equal(out.map(x=>x.delta).join(''),'Hi there');assert.ok(Number.isFinite(out[0].firstTokenLatencyMs));
});

test('LLM compliance validator fails closed on malformed provider output',async()=>{
 const fetchImpl=async()=>new Response(JSON.stringify({output_text:'not-json'}),{status:200,headers:{'content-type':'application/json'}});const llm=createOpenAILLM({apiKey:'configured',fetchImpl});const result=await llm.validate({candidate:'claim',hardRules:[],knowledge:[],signal:new AbortController().signal});assert.equal(result.allowed,false);assert.deepEqual(result.violations,['validator_parse_failure']);
});
