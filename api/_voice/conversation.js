const rx=(s,flags='i')=>new RegExp(s,flags);
const DNC=rx('\\b(take|remove) me off|\\bdo not call\\b|\\bdon[’\' ]?t call\\b|\\bstop calling\\b|\\bnever call\\b');
const HOSTILE=rx('\\b(fuck off|leave me alone|hang up|go away)\\b');
const HARD_REJECT=rx('\\b(no seriously|absolutely not|definitely not|i said no|not interested at all|don[’\' ]?t want this|end the call)\\b');
const BUSY=rx('\\b(busy|bad time|in a meeting|can[’\' ]?t talk|call me later|another time)\\b');
const SOLUTION=rx('\\b(already (have|got|use|working with)|marketing (company|agency|guy|team)|we have someone|my (agency|marketer)|handled already)\\b');
const PRICE=rx('\\b(how much|what.*cost|price|pricing|fee|charge|expensive|budget)\\b');
const AUTHORITY=rx('\\b(not my decision|talk to my|broker|manager|partner|owner decides|not the decision maker)\\b');
const NO_NEED=rx('\\b(don[’\' ]?t need|no need|we[’\' ]?re fine|we are fine|all set|we[’\' ]?re good|we are good)\\b');
const SOFT=rx('^(yeah[, ]*)?(i[’\' ]?m|we[’\' ]?re|we are)?\\s*(good|fine|all set)[,.! ]*(thanks|thank you)?[.! ]*$|\\bnot interested\\b|\\bmaybe another time\\b');
const SKEPTICAL=rx('\\b(scam|sounds too good|don[’\' ]?t believe|skeptical|what[’\' ]?s the catch|prove it|why should i)\\b');
const GUARANTEE=rx('\\b(guarantee|guaranteed|promise).*\\b(deal|client|listing|lead|sale)|\\bhow many (deals|clients|listings|leads).*guarantee\\b');
const CURIOUS=rx('\\b(what is this|what do you do|tell me more|how does it work|what are you offering|what[’\' ]?s this about)\\b');
const INTERESTED=rx('\\b(interested|sounds interesting|i[’\' ]?m listening|go ahead|sure,? tell me|okay,? tell me)\\b');

export const DEFAULT_QUALITY_SETTINGS={max_spoken_sentences:2,max_words:34,brush_off_limit:2,opening_style:'permission-light',response_verbosity:'low'};

export function initialConversationState(seed={}){return {
 call_stage:seed.call_stage||'opening',objection_type:seed.objection_type||'neutral',brush_off_count:Number(seed.brush_off_count||0),prospect_interest:seed.prospect_interest||'unknown',current_pain_point:seed.current_pain_point||null,acquisition_channel:seed.acquisition_channel||null,qualification_state:seed.qualification_state||{},prior_questions_asked:Array.isArray(seed.prior_questions_asked)?seed.prior_questions_asked.slice(-12):[],prior_objections:Array.isArray(seed.prior_objections)?seed.prior_objections.slice(-12):[],last_agent_strategy:seed.last_agent_strategy||null,termination_reason:seed.termination_reason||null
};}

export function classifyProspect(text,state={}){const t=String(text||'').trim();const lower=t.toLowerCase();
 if(DNC.test(t))return {type:'explicit_do_not_call',terminate:true,reason:'explicit_do_not_call'};
 if(HOSTILE.test(t))return {type:'hostile_terminate',terminate:true,reason:'hostile_request'};
 if(HARD_REJECT.test(t))return {type:'hard_rejection',terminate:true,reason:'hard_rejection'};
 if(BUSY.test(t))return {type:'timing_objection'};
 if(SOLUTION.test(t))return {type:'already_have_solution'};
 if(GUARANTEE.test(t))return {type:'question_information_request',subtype:'guarantee'};
 if(PRICE.test(t))return {type:'price_objection'};
 if(AUTHORITY.test(t))return {type:'authority_objection'};
 if(SKEPTICAL.test(t))return {type:'skeptical'};
 if(NO_NEED.test(t)||SOFT.test(t))return {type:'soft_brush_off'};
 if(INTERESTED.test(t))return {type:'interested'};
 if(CURIOUS.test(t)||t.endsWith('?'))return {type:'question_information_request'};
 if(/\b(referral|referrals|sphere|repeat clients?)\b/.test(lower))return {type:'neutral',fact:{acquisition_channel:'referrals'}};
 if(/\b(zillow|realtor\.com|portal leads?)\b/.test(lower))return {type:'neutral',fact:{acquisition_channel:'portal_leads'}};
 if(/\b(facebook|meta ads?)\b/.test(lower))return {type:'neutral',fact:{acquisition_channel:'meta_ads'}};
 if(/\bgoogle ads?|ppc\b/.test(lower))return {type:'neutral',fact:{acquisition_channel:'google_ads'}};
 return {type:'neutral'};
}

const strategyByType={neutral:'discovery_follow_up',curious:'answer_then_discover',interested:'qualify_lightly',soft_brush_off:'disarm_and_curiosity',timing_objection:'respect_time',already_have_solution:'validate_current_solution',skeptical:'low_pressure_credibility',price_objection:'verified_price_only',authority_objection:'decision_context',no_need_objection:'disarm_and_curiosity',hard_rejection:'graceful_exit',explicit_do_not_call:'dnc_exit',hostile_terminate:'graceful_exit',question_information_request:'answer_then_discover'};

export function decideConversation(stateInput,text,settings={}){const state=initialConversationState(stateInput);const cfg={...DEFAULT_QUALITY_SETTINGS,...settings};const classification=classifyProspect(text,state);let type=classification.type;let terminate=Boolean(classification.terminate);let reason=classification.reason||null;
 if(type==='soft_brush_off'){
  state.brush_off_count+=1;
  if(state.brush_off_count>=Math.max(1,Number(cfg.brush_off_limit||2))){terminate=true;reason='repeated_brush_off';type='hard_rejection';}
 }
 if(classification.fact?.acquisition_channel)state.acquisition_channel=classification.fact.acquisition_channel;
 if(type==='interested'){state.prospect_interest='medium';state.call_stage='discovery'}
 else if(type==='question_information_request'){state.prospect_interest=state.prospect_interest==='unknown'?'low':state.prospect_interest}
 else if(type==='soft_brush_off'||type==='already_have_solution'||type==='skeptical'||type==='price_objection'||type==='authority_objection'||type==='timing_objection'){state.call_stage='objection';}
 else if(type==='neutral'&&state.call_stage==='opening')state.call_stage='discovery';
 state.objection_type=type;
 if(!['neutral','interested','question_information_request'].includes(type))state.prior_objections=[...state.prior_objections,{type,text:String(text).slice(0,220)}].slice(-12);
 if(terminate)state.termination_reason=reason||type;
 const strategy=terminate?(type==='explicit_do_not_call'?'dnc_exit':'graceful_exit'):(strategyByType[type]||'discovery_follow_up');
 const repeatedStrategy=state.last_agent_strategy===strategy;
 state.last_agent_strategy=strategy;
 return {classification:{...classification,type},state,strategy,terminate,terminationReason:state.termination_reason,repeatedStrategy};
}

export function recordAgentTurn(stateInput,text,strategy){const state=initialConversationState(stateInput);state.last_agent_strategy=strategy||state.last_agent_strategy;const q=String(text||'').split(/(?<=[?])/).map(x=>x.trim()).filter(x=>x.endsWith('?'));for(const item of q)if(!state.prior_questions_asked.includes(item))state.prior_questions_asked.push(item);state.prior_questions_asked=state.prior_questions_asked.slice(-12);return state;}

export function buildOpeningDirective(state,prospect={}){const name=prospect.first_name||prospect.name||'';return [
 'OPENING FRAMEWORK: sound like a real outbound rep, not support staff.',
 name?`Use the prospect first name naturally if it fits: ${String(name).split(/\s+/)[0]}.`:'Do not invent a prospect name.',
 'Identify yourself/company briefly, acknowledge that the call is out of the blue, lower resistance, then ask one short permission/relevance question.',
 'Vary the wording. Do not recite a fixed script. Never imply prior contact that did not happen.',
 'Aim for 12-22 spoken words. Calm, male-rep cadence; no hype.'
 ].join(' ');}

export function buildTurnDirective(decision,settings={}){const cfg={...DEFAULT_QUALITY_SETTINGS,...settings};const s=decision.state;const common=[
 `CONVERSATION STATE: ${JSON.stringify({call_stage:s.call_stage,objection_type:s.objection_type,brush_off_count:s.brush_off_count,prospect_interest:s.prospect_interest,current_pain_point:s.current_pain_point,acquisition_channel:s.acquisition_channel,prior_questions_asked:s.prior_questions_asked.slice(-5),prior_objections:s.prior_objections.slice(-4),last_agent_strategy:s.last_agent_strategy})}`,
 `DELIVERY: one natural sentence preferred, at most ${cfg.max_spoken_sentences} short sentences and about ${cfg.max_words} words. Use contractions and fragments when natural. Ask at most one question.`,
 'Do not say Certainly, Absolutely, I completely understand, I’d be happy to, or other customer-service filler. Do not repeat the prospect sentence back. Do not sound excited, corporate, or needy.',
 decision.repeatedStrategy?'Do NOT reuse the previous objection wording or question. Change angle or back off.':''
 ];
 const strategies={
 disarm_and_curiosity:'FIRST SOFT BRUSH-OFF: do not end the call. Briefly agree/disarm, lower pressure, then ask one relevant curiosity question about how they currently get business. No argument.',
 graceful_exit:'EXIT: no more selling. One short professional sign-off. No new question.',
 dnc_exit:'DNC: acknowledge the request plainly and end. No sales language, no follow-up question.',
 validate_current_solution:'ALREADY HAS SOLUTION: validate without praising or attacking the competitor, then ask one concise question about how they currently generate leads or what channel works best.',
 respect_time:'BUSY: respect the timing. Either ask for 10-15 seconds once or offer a better time in one compact sentence. Do not launch into a pitch.',
 verified_price_only:'PRICE: answer only from VERIFIED COMPANY KNOWLEDGE. If exact pricing is not verified, say you do not want to make up a number and ask one qualification question or propose the appropriate follow-up.',
 low_pressure_credibility:'SKEPTICAL: do not defend aggressively. Acknowledge skepticism briefly and ask one grounded question or state one verified fact.',
 decision_context:'AUTHORITY: ask who normally handles marketing/lead generation or how that decision is made. One question only.',
 answer_then_discover:'QUESTION: answer briefly using verified knowledge only, then ask at most one useful follow-up.',
 discovery_follow_up:'DISCOVERY: ask one context-aware realtor question. Prefer current business source, referrals vs paid leads, Zillow/Realtor.com, Meta/Google, lead quality, follow-up speed, team/solo, capacity, or conversion. Do not interrogate.',
 qualify_lightly:'INTEREST: move naturally into one qualification/discovery question; do not dump a pitch.'
 };
 return [...common,strategies[decision.strategy]||strategies.discovery_follow_up].filter(Boolean).join('\n');
}

export function evaluateHumanness(text,{companyName='AdLift',prospectText='',state={}}={}){const t=String(text||'').trim();const words=t.split(/\s+/).filter(Boolean);const sentences=t.split(/[.!?]+/).map(x=>x.trim()).filter(Boolean);const questions=(t.match(/\?/g)||[]).length;const lower=t.toLowerCase();const corporate=['absolutely','certainly','i completely understand','i’d be happy to','i would be happy to','the reason for my call today','that makes perfect sense','thank you for sharing'];const issues=[];
 if(words.length>40)issues.push('response_too_long');if(sentences.length>2)issues.push('too_many_sentences');if(questions>1)issues.push('multiple_questions');if(corporate.some(x=>lower.includes(x)))issues.push('corporate_language');if((t.match(/!/g)||[]).length>1)issues.push('excessive_enthusiasm');
 if(companyName&&lower.split(String(companyName).toLowerCase()).length-1>1)issues.push('repeated_company_name');
 const p=String(prospectText||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').trim();if(p.length>10&&lower.includes(p))issues.push('repeated_prospect_statement');
 if(state.last_agent_strategy==='disarm_and_curiosity'&&/have a (great|good) day|take care|goodbye/.test(lower))issues.push('soft_brush_off_immediate_exit');
 return {score:Math.max(0,100-issues.length*15),issues,words:words.length,sentences:sentences.length,questions};}
