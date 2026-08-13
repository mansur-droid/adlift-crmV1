import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceOrchestrator} from '../api/_voice/orchestrator.js';

function harness({allowed=true}={}){
 const rpc=[];const inserts=[];const updates=[];const spoken=[];let clears=0;let transportClears=0;
 const admin={rpc:async(name,args)=>{rpc.push({name,args});return {data:{sequence_no:rpc.length-1},error:null}},from:table=>({insert:async row=>{inserts.push({table,row});return {error:null}},update:row=>({eq:async()=>{updates.push({table,row});return {error:null}}})})};
 const stt={slug:'stt-test',close(){},sendAudio(){return true}};
 const llm={slug:'llm-test',async *streamResponse(){yield {delta:'Short response.',firstTokenLatencyMs:12}},async validate(){return {allowed,violations:allowed?[]:['blocked'],unsupportedClaims:[]}}};
 const tts={slug:'tts-test',speak:text=>spoken.push(text),flush(){},clear(){clears++},close(){}};
 const transport={clear(){transportClears++},mark(){return 'mark'},sendAudio(){return true},close(){},acknowledgeMark(){return null}};
 const context={regulations:[],knowledge:[],instructions:{objective:[],audience:[],personality:[],opening:[],discovery:[],qualification:[],objection:[],closing:[],transfer:[],appointment:[],guidance:[]},prospect:{},callbacks:[]};
 const providers={stt:()=>stt,llm:()=>llm,tts:()=>tts};
 const session={id:'session',attempt_id:'attempt',stt_provider_slug:'stt-test',llm_provider_slug:'llm-test',tts_provider_slug:'tts-test',turn_no:0,interruption_count:0,latency_metrics:{},provider_errors:[],provider_states:{}};
 const voice=new VoiceOrchestrator({admin,session,context,providers,transport,now:(()=>{let n=1000;return()=>++n})()});
 return {voice,rpc,inserts,updates,spoken,get clears(){return clears},get transportClears(){return transportClears}};
}

test('interim speech is session state only and not persisted as a final transcript',async()=>{const h=harness();await h.voice.onInterim({text:'partial'});assert.equal(h.rpc.length,0);assert.equal(h.updates.some(x=>x.row.interim_transcript==='partial'),true)});

test('one final prospect turn persists once and produces one dynamic agent turn',async()=>{const h=harness();h.voice.pendingFinal='hello';h.voice.pendingFinalStart=10;h.voice.pendingFinalEnd=20;h.voice.pendingConfidence=[0.9];await h.voice.commitProspectTurn('seg-1');assert.equal(h.rpc.filter(x=>x.name==='ai_append_transcript_segment').length,1);assert.equal(h.spoken.length,1);assert.equal(h.voice.turnNo,1)});

test('barge-in cancels synthesis and clears queued playback',async()=>{const h=harness();await h.voice.generateAgentTurn('hello');await h.voice.interrupt('test');assert.equal(h.clears,1);assert.equal(h.transportClears,1);assert.equal(h.voice.current,null);assert.equal(h.updates.some(x=>x.row.tts_state==='cancelled'),true)});

test('blocked generated text is not spoken',async()=>{const h=harness({allowed:false});await h.voice.generateAgentTurn('question');assert.equal(h.inserts.some(x=>x.row?.event_type==='voice.compliance.blocked'),true);assert.equal(h.spoken.some(x=>x.includes('Short response.')),false)});

test('stale generation is invalidated after interruption',async()=>{const h=harness();await h.voice.generateAgentTurn('question');const epoch=h.voice.generationEpoch;await h.voice.interrupt('new speech');assert.ok(h.voice.generationEpoch>epoch);assert.equal(h.voice.current,null)});
