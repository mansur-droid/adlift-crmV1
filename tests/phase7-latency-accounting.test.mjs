import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceOrchestrator} from '../api/_voice/orchestrator.js';
import {groupInstructions} from '../api/_voice/context.js';

function harness(){
 let clock=1417,llmStarted=false,resolveTranscript;
 const transcriptGate=new Promise(r=>{resolveTranscript=r});
 const updates=[];
 const admin={
  rpc:async(name)=>{if(name==='ai_append_transcript_segment')return transcriptGate;return {data:{},error:null}},
  from:table=>({
   insert:async()=>({error:null}),
   update:row=>({eq:async()=>{updates.push({table,row});return {error:null}}})
  })
 };
 const stt={slug:'deepgram',async connect(){},sendAudio(){},close(){},status:()=>({model:'nova-3'})};
 const llm={slug:'groq',status:()=>({model:'openai/gpt-oss-20b'}),async *streamResponse(){llmStarted=true;clock+=250;yield {delta:'Hey — quick question.',firstTokenLatencyMs:250}},async validate(){clock+=800;return {allowed:true,violations:[],unsupportedClaims:[]}}};
 const tts={slug:'deepgram',status:()=>({voice:'aura-2-apollo-en',speed:1.12}),async connect(){},speak(){},flush(){},clear(){},close(){}};
 const transport={clear(){return true},sendAudio(){return true},mark(){return 'm'},acknowledgeMark(){return null},close(){}};
 const context={campaign:{compliance_settings:{}},regulations:[],knowledge:[],instructions:groupInstructions([]),prospect:{},callbacks:[],attempt:{phone_e164:'+15005550006'}};
 const session={id:'session',attempt_id:'attempt',prospect_record_id:'prospect',stt_provider_slug:'deepgram',llm_provider_slug:'groq',tts_provider_slug:'deepgram',turn_no:0,interruption_count:0,latency_metrics:{},provider_errors:[],provider_states:{},objection_state:{}};
 const voice=new VoiceOrchestrator({admin,session,context,providers:{stt:()=>stt,llm:()=>llm,tts:()=>tts},transport,now:()=>clock});
 voice.pendingFinal='Hello?';voice.pendingFinalStart=0;voice.pendingFinalEnd=500;voice.pendingSpeechEndAt=1000;voice.pendingSttLatency=[417];voice.pendingConfidence=[0.98];voice.lastLocalSpeechStartAt=500;voice.lastLocalSpeechEndAt=1000;
 return {voice,get clock(){return clock},set clock(v){clock=v},get llmStarted(){return llmStarted},resolveTranscript,updates};
}

test('prospect transcript persistence is not on the LLM critical path',async()=>{
 const h=harness();
 const done=h.voice.commitProspectTurn('seg-hello',1417);
 const result=await Promise.race([done.then(()=>true),new Promise(r=>setTimeout(()=>r(false),30))]);
 assert.equal(result,true);
 assert.equal(h.llmStarted,true);
 h.resolveTranscript({data:{sequence_no:1},error:null});
 h.voice.close();
});

test('speech-end to first-audio latency is decomposed with negligible unaccounted remainder',async()=>{
 const h=harness();
 await h.voice.commitProspectTurn('seg-hello',1417);
 h.clock=2468;
 await h.voice.onFirstAudio({latencyMs:1});
 const metrics=Object.values(h.voice.session.latency_metrics).at(-1);
 assert.equal(metrics.stt_final_ms,417);
 assert.equal(metrics.stt_final_to_generation_start_ms,0);
 assert.equal(metrics.generation_start_to_llm_request_ms,0);
 assert.equal(metrics.llm_request_to_first_token_ms,250);
 assert.equal(metrics.first_token_to_first_sentence_ms,0);
 assert.equal(metrics.first_sentence_to_compliance_start_ms,0);
 assert.equal(metrics.compliance_ms,800);
 assert.equal(metrics.compliance_end_to_tts_speak_ms,0);
 assert.equal(metrics.tts_speak_to_first_audio_ms,1);
 assert.equal(metrics.speech_end_to_first_audio_ms,1468);
 assert.equal(metrics.accounted_pre_audio_ms,1468);
 assert.equal(metrics.unaccounted_pre_audio_ms,0);
 h.resolveTranscript({data:{sequence_no:1},error:null});
 h.voice.close();
});
