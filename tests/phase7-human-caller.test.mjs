import test from 'node:test';
import assert from 'node:assert/strict';
import {initialConversationState,decideConversation,buildTurnDirective,evaluateHumanness,recordAgentTurn} from '../api/_voice/conversation.js';
import {createDeepgramTTS,createDeepgramSTT} from '../api/_voice/providers/deepgram.js';
import {createTwilioMediaTransport} from '../api/_voice/media/twilio.js';
import {EventEmitter} from 'node:events';

class MockSocket extends EventEmitter{static OPEN=1;constructor(){super();this.readyState=1;this.sent=[]}send(v){this.sent.push(v)}close(){this.readyState=3;this.emit('close',1000,'closed')}terminate(){this.close()}}

test('first soft brush-off does not terminate and requires a pattern interrupt',()=>{const d=decideConversation(initialConversationState(),'I\'m good, thank you');assert.equal(d.classification.type,'soft_brush_off');assert.equal(d.terminate,false);assert.equal(d.state.brush_off_count,1);assert.equal(d.strategy,'disarm_and_curiosity');assert.match(buildTurnDirective(d),/do not end the call/i)});

test('second clear brush-off exits gracefully',()=>{let d=decideConversation(initialConversationState(),'I\'m good');d=decideConversation(d.state,'No seriously, not interested');assert.equal(d.terminate,true);assert.equal(d.strategy,'graceful_exit');assert.equal(d.state.termination_reason,'hard_rejection')});

test('explicit do-not-call terminates immediately',()=>{const d=decideConversation(initialConversationState(),'Take me off your list');assert.equal(d.classification.type,'explicit_do_not_call');assert.equal(d.terminate,true);assert.equal(d.strategy,'dnc_exit')});

test('existing marketing company gets validation strategy without competitor attack',()=>{const d=decideConversation(initialConversationState(),'We already have a marketing company');assert.equal(d.terminate,false);assert.equal(d.strategy,'validate_current_solution');assert.match(buildTurnDirective(d),/without praising or attacking the competitor/i)});

test('busy prospect receives timing strategy',()=>{const d=decideConversation(initialConversationState(),'I\'m busy right now');assert.equal(d.strategy,'respect_time');assert.equal(d.terminate,false)});

test('price question is routed to verified-price-only strategy',()=>{const d=decideConversation(initialConversationState(),'How much does it cost?');assert.equal(d.classification.type,'price_objection');assert.equal(d.strategy,'verified_price_only');assert.match(buildTurnDirective(d),/VERIFIED COMPANY KNOWLEDGE/)});

test('guarantee request is information request and cannot authorize a guarantee',()=>{const d=decideConversation(initialConversationState(),'Can you guarantee me 20 deals?');assert.equal(d.classification.subtype,'guarantee');assert.equal(d.strategy,'answer_then_discover')});

test('repeated objection handler is flagged so wording must change',()=>{let d=decideConversation(initialConversationState(),'We already have someone');const s=recordAgentTurn(d.state,'Gotcha. Where are most of your leads coming from?','validate_current_solution');d=decideConversation(s,'Like I said, we have a marketing company');assert.equal(d.repeatedStrategy,true);assert.match(buildTurnDirective(d),/Do NOT reuse/)});

test('realtor acquisition channel is remembered',()=>{const d=decideConversation(initialConversationState(),'Mostly referrals and repeat clients');assert.equal(d.state.acquisition_channel,'referrals');assert.equal(d.state.call_stage,'discovery')});

test('humanness harness flags corporate multi-question speeches',()=>{const e=evaluateHumanness('Absolutely! I completely understand. The reason for my call today is to discuss AdLift and AdLift. How do you get leads? Are you running ads?',{companyName:'AdLift'});assert.ok(e.issues.includes('corporate_language'));assert.ok(e.issues.includes('multiple_questions'));assert.ok(e.issues.includes('repeated_company_name'));assert.ok(e.score<100)});

test('humanness harness accepts concise low-pressure language',()=>{const e=evaluateHumanness('Yeah, fair enough. Are you mainly getting business through referrals right now?');assert.equal(e.questions,1);assert.equal(e.issues.includes('corporate_language'),false);assert.ok(e.score>=85)});

test('Deepgram TTS defaults to verified male Apollo voice and remains configurable',()=>{const a=createDeepgramTTS({apiKey:'x'});assert.equal(a.status().voice,'aura-2-apollo-en');const b=createDeepgramTTS({apiKey:'x',settings:{voice:'aura-2-arcas-en',speed:0.98}});assert.equal(b.status().voice,'aura-2-arcas-en');assert.equal(b.status().speed,0.98)});

test('Deepgram STT uses conversational endpointing defaults',()=>{const stt=createDeepgramSTT({apiKey:'x'});const s=stt.status();assert.equal(s.endpointingMs,250);assert.equal(s.utteranceEndMs,1000);assert.equal(s.language,'en-US')});

test('Twilio media VAD detects barge-in after bounded consecutive speech frames',()=>{let now=1000;const socket=new MockSocket();const t=createTwilioMediaTransport({socket,now:()=>now,bargeInRms:0,bargeInFrames:3});t.start({streamSid:'MZ1',start:{callSid:'CA1'}});const payload=Buffer.from([0xff,0xff]).toString('base64');let r=t.ingest({event:'media',sequenceNumber:1,media:{payload,timestamp:0}});assert.equal(r.speechDetected,false);now+=20;r=t.ingest({event:'media',sequenceNumber:2,media:{payload,timestamp:20}});assert.equal(r.speechDetected,false);now+=20;r=t.ingest({event:'media',sequenceNumber:3,media:{payload,timestamp:40}});assert.equal(r.speechDetected,true);assert.equal(r.detectedAtMs,1040)});
