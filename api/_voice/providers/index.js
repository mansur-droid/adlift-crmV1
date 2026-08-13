import {createDeepgramSTT,createDeepgramTTS} from './deepgram.js';
import {createOpenAILLM} from './openai.js';

export const supportedVoiceProviders={stt:['deepgram'],llm:['openai'],tts:['deepgram']};

export function voiceProviderStatus(env=process.env){return {
 deepgram:{configured:Boolean(env.DEEPGRAM_API_KEY),kinds:['stt','tts']},
 openai:{configured:Boolean(env.OPENAI_API_KEY),kinds:['llm']}
}}

export function createVoiceProviders({providerConfigs=[],env=process.env,WebSocketImpl,fetchImpl,now}={}){
 const byKey=new Map(providerConfigs.filter(x=>x.enabled).map(x=>[`${x.provider_kind}:${x.provider_slug}`,x]));
 const settings=(kind,slug)=>byKey.get(`${kind}:${slug}`)?.settings||{};
 return {
  stt(slug){if(slug!=='deepgram')throw Object.assign(new Error(`Unsupported STT provider: ${slug}`),{code:'STT_UNSUPPORTED'});return createDeepgramSTT({apiKey:env.DEEPGRAM_API_KEY,settings:settings('stt',slug),WebSocketImpl,now})},
  llm(slug){if(slug!=='openai')throw Object.assign(new Error(`Unsupported LLM provider: ${slug}`),{code:'LLM_UNSUPPORTED'});return createOpenAILLM({apiKey:env.OPENAI_API_KEY,settings:settings('llm',slug),fetchImpl,now})},
  tts(slug){if(slug!=='deepgram')throw Object.assign(new Error(`Unsupported TTS provider: ${slug}`),{code:'TTS_UNSUPPORTED'});return createDeepgramTTS({apiKey:env.DEEPGRAM_API_KEY,settings:settings('tts',slug),WebSocketImpl,now})}
 };
}
