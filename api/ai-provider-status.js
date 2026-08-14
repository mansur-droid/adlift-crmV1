import { createClient } from '@supabase/supabase-js';

const supabaseUrl=process.env.VITE_SUPABASE_URL||process.env.SUPABASE_URL;
const anonKey=process.env.VITE_SUPABASE_ANON_KEY||process.env.SUPABASE_ANON_KEY;

const secretChecks={
 twilio:['TWILIO_ACCOUNT_SID','TWILIO_AUTH_TOKEN'],
 openai:['OPENAI_API_KEY'],
 groq:['GROQ_API_KEY'],
 anthropic:['ANTHROPIC_API_KEY'],
 gemini:['GEMINI_API_KEY'],
 google:['GOOGLE_API_KEY'],
 grok:['XAI_API_KEY'],
 xai:['XAI_API_KEY'],
 deepseek:['DEEPSEEK_API_KEY'],
 openrouter:['OPENROUTER_API_KEY'],
 elevenlabs:['ELEVENLABS_API_KEY'],
 deepgram:['DEEPGRAM_API_KEY'],
 cartesia:['CARTESIA_API_KEY']
};

function json(res,status,body){res.status(status).json(body)}
function token(req){const h=req.headers.authorization||'';return h.startsWith('Bearer ')?h.slice(7):''}
function role(user){return String(user?.app_metadata?.role||user?.user_metadata?.role||'').toLowerCase()}

export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='GET')return json(res,405,{error:'Method not allowed.'});
 if(!supabaseUrl||!anonKey)return json(res,500,{error:'Supabase server configuration is missing.'});
 const bearer=token(req);if(!bearer)return json(res,401,{error:'Missing auth token.'});
 const client=createClient(supabaseUrl,anonKey,{global:{headers:{Authorization:`Bearer ${bearer}`}}});
 const{data,error}=await client.auth.getUser(bearer);if(error||!data?.user)return json(res,401,{error:'Invalid auth token.'});
 if(role(data.user)!=='admin')return json(res,403,{error:'Admin only.'});
 const{data:configs,error:configError}=await client.from('ai_provider_configs').select('provider_slug');
 if(configError)return json(res,400,{error:configError.message});
 const providers={};
 for(const row of configs||[]){const slug=String(row.provider_slug||'').toLowerCase();const names=secretChecks[slug]||[];providers[slug]={configured:names.length>0&&names.every(n=>Boolean(process.env[n])),requiredSecretCheckKnown:names.length>0};}
 return json(res,200,{providers});
}
