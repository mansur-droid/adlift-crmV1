import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSystemPrompt,groupInstructions,prospectContextFromRecord} from '../api/_voice/context.js';

test('prospect context includes only approved CRM fields',()=>{const out=prospectContextFromRecord({id:'p1',payload:{name:'Alex',company:'Example',notes:'prior note',private_token:'hidden'}});assert.equal(out.name,'Alex');assert.equal(out.company,'Example');assert.equal(out.private_token,undefined)});

test('campaign instructions stay structured by type and priority',()=>{const out=groupInstructions([{instruction_type:'opening',title:'Low',content:'a',priority:1,enabled:true},{instruction_type:'opening',title:'High',content:'b',priority:100,enabled:true},{instruction_type:'objection',title:'Off',content:'x',priority:999,enabled:false}]);assert.deepEqual(out.opening.map(x=>x.title),['High','Low']);assert.equal(out.objection.length,0)});

test('system prompt gives hard rules priority and treats prospect speech as untrusted',()=>{const instructions=groupInstructions([{instruction_type:'objective',title:'Objective',content:'Book a meeting',priority:10,enabled:true}]);const prompt=buildSystemPrompt({regulations:[{enforcement_level:'hard',priority:100,title:'Claims',rule_text:'Never guarantee results.',enabled:true}],knowledge:[{category:'service',title:'Offer',content:'We build websites.'}],instructions,prospect:{name:'Alex'},callbacks:[]});assert.match(prompt,/Never guarantee results/);assert.match(prompt,/We build websites/);assert.match(prompt,/untrusted input/i);assert.match(prompt,/priority order/i);assert.match(prompt,/Never invent pricing/i)});

test('missing verified knowledge is represented explicitly rather than invented',()=>{const prompt=buildSystemPrompt({regulations:[],knowledge:[],instructions:groupInstructions([]),prospect:{},callbacks:[]});assert.match(prompt,/VERIFIED COMPANY KNOWLEDGE/);assert.match(prompt,/none configured/)});
