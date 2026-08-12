import test from 'node:test';
import assert from 'node:assert/strict';
import twilio from 'twilio';
import {createTwilioProvider,normalizeTwilioStatus,parseTwilioEvent,classifyTwilioError} from '../api/_telephony/twilio.js';

const env={TWILIO_ACCOUNT_SID:'AC00000000000000000000000000000000',TWILIO_AUTH_TOKEN:'test_auth_token_never_real',TWILIO_FROM_NUMBER:'+15005550006',TWILIO_WEBHOOK_BASE_URL:'https://crm.example.com'};

test('Twilio status mapping preserves meaningful lifecycle states',()=>{
 assert.equal(normalizeTwilioStatus('initiated'),'initiating');
 assert.equal(normalizeTwilioStatus('ringing'),'ringing');
 assert.equal(normalizeTwilioStatus('in-progress'),'connected');
 assert.equal(normalizeTwilioStatus('completed'),'completed');
 assert.equal(normalizeTwilioStatus('busy'),'busy');
 assert.equal(normalizeTwilioStatus('no-answer'),'no_answer');
 assert.equal(normalizeTwilioStatus('canceled'),'cancelled');
 assert.equal(normalizeTwilioStatus('failed'),'provider_failed');
 assert.equal(normalizeTwilioStatus('nonsense'),null);
});

test('Twilio webhook signature uses official validator and rejects tampering',()=>{
 const provider=createTwilioProvider({env});
 const url='https://crm.example.com/api/twilio-webhook?attempt=11111111-1111-4111-8111-111111111111';
 const params={CallSid:'CA11111111111111111111111111111111',CallStatus:'ringing',SequenceNumber:'1',Timestamp:'Wed, 12 Aug 2026 00:00:00 +0000'};
 const signature=twilio.getExpectedTwilioSignature(env.TWILIO_AUTH_TOKEN,url,params);
 assert.equal(provider.validateWebhook({signature,url,params}),true);
 assert.equal(provider.validateWebhook({signature,url,params:{...params,CallStatus:'completed'}}),false);
 assert.equal(provider.validateWebhook({signature:'bad',url,params}),false);
});

test('provider status is safe and never exposes credentials',()=>{
 const status=createTwilioProvider({env}).status();const text=JSON.stringify(status);
 assert.equal(status.readyForTest,true);assert.equal(status.fromNumber,env.TWILIO_FROM_NUMBER);
 assert.equal(text.includes(env.TWILIO_AUTH_TOKEN),false);assert.equal(text.includes(env.TWILIO_ACCOUNT_SID),false);
});

test('Twilio event parser preserves sequence, timestamp and terminal duration',()=>{
 const ev=parseTwilioEvent({CallSid:'CA1',CallStatus:'completed',AccountSid:'AC1',SequenceNumber:'3',Timestamp:'Wed, 12 Aug 2026 00:00:30 +0000',CallDuration:'20'});
 assert.equal(ev.sequenceNumber,3);assert.equal(ev.duration,20);assert.equal(ev.occurredAt,'2026-08-12T00:00:30.000Z');
});

test('provider errors are sanitized into normalized categories',()=>{
 assert.equal(classifyTwilioError({status:401,code:20003,message:'bad auth'}).internalStatus,'provider_auth_error');
 assert.equal(classifyTwilioError({status:400,code:21212,message:'bad from'}).kind,'invalid_from_number');
 assert.equal(classifyTwilioError({message:'socket timeout'}).internalStatus,'provider_network_error');
});
