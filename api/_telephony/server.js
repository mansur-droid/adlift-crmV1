import {createClient} from '@supabase/supabase-js';

export function serverConfig(){return {url:process.env.VITE_SUPABASE_URL||process.env.SUPABASE_URL||'',anon:process.env.VITE_SUPABASE_ANON_KEY||process.env.SUPABASE_ANON_KEY||'',service:process.env.SUPABASE_SERVICE_ROLE_KEY||''}}
export function json(res,status,body){return res.status(status).json(body)}
export function bearer(req){const h=req.headers?.authorization||'';return h.startsWith('Bearer ')?h.slice(7):''}
export function roleFromUser(user){return String(user?.app_metadata?.role||user?.user_metadata?.role||'').toLowerCase()}
export function uuid(v){return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v||''))}
export async function requireAdmin(req,res,{createClientFn=createClient,config=serverConfig()}={}){
 if(!config.url||!config.anon||!config.service){json(res,500,{error:'Server Supabase configuration missing.'});return null}
 const token=bearer(req);if(!token){json(res,401,{error:'Authentication required.'});return null}
 const userClient=createClientFn(config.url,config.anon,{global:{headers:{Authorization:`Bearer ${token}`}}});
 const {data,error}=await userClient.auth.getUser(token);if(error||!data?.user){json(res,401,{error:'Invalid authentication.'});return null}
 if(roleFromUser(data.user)!=='admin'){json(res,403,{error:'Admin only.'});return null}
 return {admin:createClientFn(config.url,config.service,{auth:{persistSession:false,autoRefreshToken:false}}),user:data.user};
}
export function e164(v){const s=String(v||'').replace(/[\s().-]/g,'');return /^\+[1-9][0-9]{7,14}$/.test(s)?s:null}
export function phase6LiveEnabled(){return process.env.TWILIO_CONTROLLED_TEST_ENABLED==='true'}
