import test from 'node:test';
import assert from 'node:assert/strict';
import {createTwilioMediaTransport} from '../api/_voice/media/twilio.js';
import {VoiceOrchestrator} from '../api/_voice/orchestrator.js';

test('Twilio inbound mulaw media is forwarded byte-for-byte to STT',()=>{
 const raw=Buffer.from([0xff,0x7f,0x00,0x55]);const evt={event:'media',sequenceNumber:'2',media:{payload:raw.toString('base64'),timestamp:'20'}};let forwarded=null;
 const transport=createTwilioMediaTransport({socket:{readyState:1,send(){}}});transport.start({start:{streamSid:'MZtest',callSid:'CAtest',mediaFormat:{encoding:'audio/x-mulaw',sampleRate:8000,channels:1}}});
 const stt={slug:'deepgram',sendAudio:b=>{forwarded=Buffer.from(b);return true},close(){}};const llm={slug:'openai'};const tts={slug:'deepgram',close(){}};const admin={from:()=>({update:()=>({eq:async()=>({})}),insert:async()=>({})}),rpc:async()=>({data:null,error:null})};
 const voice=new VoiceOrchestrator({admin,session:{id:'s',attempt_id:'a',stt_provider_slug:'deepgram',llm_provider_slug:'openai',tts_provider_slug:'deepgram',turn_no:0,interruption_count:0,latency_metrics:{},provider_errors:[],provider_states:{}},context:{regulations:[],knowledge:[],instructions:{},prospect:{},callbacks:[]},providers:{stt:()=>stt,llm:()=>llm,tts:()=>tts},transport});
 voice.onMedia(evt);assert.deepEqual([...forwarded],[...raw]);
});

test('Twilio outbound media remains base64 mulaw payload and clear flushes queued playback',()=>{
 const sent=[];const transport=createTwilioMediaTransport({socket:{readyState:1,send:v=>sent.push(JSON.parse(v))}});transport.start({start:{streamSid:'MZtest',callSid:'CAtest'}});const audio=Buffer.from([1,2,3]);assert.equal(transport.sendAudio(audio,'turn-1'),true);assert.equal(sent[0].event,'media');assert.deepEqual([...Buffer.from(sent[0].media.payload,'base64')],[1,2,3]);transport.mark('turn-1');transport.clear();assert.equal(sent.at(-1).event,'clear');
});
