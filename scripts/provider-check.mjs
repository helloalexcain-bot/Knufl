// Read-only provider probe. Load secrets through an ignored .env file, never CLI arguments.
import { createClient } from '@supabase/supabase-js';
const required=['NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY','OPENAI_API_KEY'];
const missing=required.filter(key=>!process.env[key]);
if(missing.length){
  console.error('BLOCKED: Configure '+missing.join(', ')+' in the preview runtime or an ignored local env file.');
  process.exit(2);
}
const url=process.env.NEXT_PUBLIC_SUPABASE_URL;
const client=createClient(url,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
const {data,error}=await client.rpc('voice_supervisor_status');
if(error){console.error('FAIL: Supabase migration/supervisor RPC unavailable ('+error.code+').');process.exitCode=1;}
else{
  console.log('LIVE Supabase supervisor:',JSON.stringify(data));
  if(!data?.healthy||data.overdueCalls>0)process.exitCode=1;
}
const model=process.env.KNUFL_REALTIME_MODEL||'gpt-realtime-2.1';
const response=await fetch('https://api.openai.com/v1/models/'+encodeURIComponent(model),{
  headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY},signal:AbortSignal.timeout(10000),
});
console.log('LIVE OpenAI model visibility:',response.status,model);
if(!response.ok)process.exitCode=1;
console.log('This read-only probe does not verify Google OAuth, a paid Realtime call, audio, or two-device recovery.');
