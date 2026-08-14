import test from 'node:test';
import assert from 'node:assert/strict';
import {createVoiceMediaHealthHandler} from '../api/voice-media/health.js';

function response(){
 const headers={};
 return {
  statusCode:0,
  body:'',
  setHeader(k,v){headers[String(k).toLowerCase()]=v},
  end(v=''){this.body=String(v)},
  headers
 };
}

const configuredEnv={
 TWILIO_ACCOUNT_SID:'AC'+'0'.repeat(32),
 TWILIO_AUTH_TOKEN:'test-auth-token',
 TWILIO_FROM_NUMBER:'+14245004773',
 TWILIO_WEBHOOK_BASE_URL:'https://crm.example.com',
 DEEPGRAM_API_KEY:'test-deepgram-key',
 OPENAI_API_KEY:'test-openai-key',
 TWILIO_CONTROLLED_TEST_ENABLED:'false'
};

test('voice-media health reports realtime stack ready while controlled calling remains locked',()=>{
 const handler=createVoiceMediaHealthHandler({env:configuredEnv});
 const res=response();
 handler({method:'GET'},res);
 const body=JSON.parse(res.body);
 assert.equal(res.statusCode,200);
 assert.equal(body.ok,true);
 assert.equal(body.websocketPath,'/api/voice-media');
 assert.equal(body.mediaConfigured,true);
 assert.equal(body.twilioConfigured,true);
 assert.equal(body.deepgramConfigured,true);
 assert.equal(body.openaiConfigured,true);
 assert.equal(body.controlledTestEnabled,false);
 assert.equal(body.bulkDialingEnabled,false);
 assert.equal(body.autonomousCampaignConsumption,false);
});

test('voice-media health fails closed when an AI provider secret is missing',()=>{
 const handler=createVoiceMediaHealthHandler({env:{...configuredEnv,OPENAI_API_KEY:''}});
 const res=response();
 handler({method:'GET'},res);
 const body=JSON.parse(res.body);
 assert.equal(res.statusCode,503);
 assert.equal(body.ok,false);
 assert.equal(body.openaiConfigured,false);
});

test('voice-media health only accepts GET',()=>{
 const handler=createVoiceMediaHealthHandler({env:configuredEnv});
 const res=response();
 handler({method:'POST'},res);
 assert.equal(res.statusCode,405);
 assert.deepEqual(JSON.parse(res.body),{ok:false,error:'Method not allowed.'});
});
