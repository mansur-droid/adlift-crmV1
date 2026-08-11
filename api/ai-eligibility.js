import { createClient } from '@supabase/supabase-js';

const supabaseUrl=process.env.VITE_SUPABASE_URL||process.env.SUPABASE_URL;
const anonKey=process.env.VITE_SUPABASE_ANON_KEY||process.env.SUPABASE_ANON_KEY;
const serviceRoleKey=process.env.SUPABASE_SERVICE_ROLE_KEY;

function json(res,status,body){res.status(status).json(body)}
function bearer(req){const h=req.headers.authorization||'';return h.startsWith('Bearer ')?h.slice(7):''}
function role(user){return String(user?.app_metadata?.role||user?.user_metadata?.role||'').toLowerCase()}
function uuid(v){return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v||''))}

async function requireAdmin(req,res){
 if(!supabaseUrl||!anonKey||!serviceRoleKey){json(res,500,{error:'Missing Supabase server environment variables.'});return null}
 const token=bearer(req);if(!token){json(res,401,{error:'Missing auth token.'});return null}
 const userClient=createClient(supabaseUrl,anonKey,{global:{headers:{Authorization:`Bearer ${token}`}}});
 const{data,error}=await userClient.auth.getUser(token);if(error||!data?.user){json(res,401,{error:'Invalid auth token.'});return null}
 if(role(data.user)!=='admin'){json(res,403,{error:'Admin only.'});return null}
 return createClient(supabaseUrl,serviceRoleKey,{auth:{autoRefreshToken:false,persistSession:false}})
}

export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 const admin=await requireAdmin(req,res);if(!admin)return;
 try{
  const body=req.method==='POST'?(typeof req.body==='string'?JSON.parse(req.body||'{}'):(req.body||{})):{};
  const action=body.action||req.query?.action||'stats';
  const campaignId=body.campaignId||req.query?.campaignId;
  if(!uuid(campaignId))return json(res,400,{error:'Valid campaignId is required.'});

  if(req.method==='GET'&&action==='stats'){
   const{data,error}=await admin.rpc('ai_campaign_queue_stats',{p_campaign_id:campaignId});
   if(error)return json(res,400,{error:error.message});
   return json(res,200,{stats:data});
  }
  if(req.method!=='POST')return json(res,405,{error:'Method not allowed.'});

  if(action==='evaluate'){
   if(!uuid(body.prospectRecordId))return json(res,400,{error:'Valid prospectRecordId is required.'});
   const{data,error}=await admin.rpc('ai_evaluate_call_eligibility',{p_campaign_id:campaignId,p_prospect_record_id:body.prospectRecordId});
   if(error)return json(res,400,{error:error.message});
   return json(res,200,{result:data});
  }
  if(action==='preview'){
   const limit=Math.max(1,Math.min(Number(body.limit)||5000,10000));
   const{data,error}=await admin.rpc('ai_preview_campaign_eligibility',{p_campaign_id:campaignId,p_limit:limit});
   if(error)return json(res,400,{error:error.message});
   const reasons={};let eligible=0;for(const row of data||[]){reasons[row.reason_code]=(reasons[row.reason_code]||0)+1;if(row.eligible)eligible++}
   return json(res,200,{dryRun:true,total:(data||[]).length,eligible,ineligible:(data||[]).length-eligible,reasons,rows:data||[]});
  }
  if(action==='populate'){
   const limit=Math.max(1,Math.min(Number(body.limit)||100,1000));
   const{data,error}=await admin.rpc('ai_queue_campaign_eligible',{p_campaign_id:campaignId,p_limit:limit});
   if(error)return json(res,400,{error:error.message});
   const queued=(data||[]).filter(x=>x.queued).length;
   return json(res,200,{queued,results:data||[]});
  }
  return json(res,400,{error:'Unknown action.'});
 }catch(e){return json(res,500,{error:e?.message||'Eligibility request failed.'})}
}
