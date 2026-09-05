import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRealtimeCloseRequest, handleRealtimeRequest } from '../server/knufl-api/http.ts';
import { readServerConfig } from '../server/knufl-api/config.ts';
import { supabaseRequest } from '../server/knufl-api/supabase.ts';

const owner = '10000000-0000-4000-8000-000000000001';
const other = '20000000-0000-4000-8000-000000000002';
const voiceId = '30000000-0000-4000-8000-000000000003';
const config = readServerConfig({ NEXT_PUBLIC_SUPABASE_URL:'https://project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY:'anon', SUPABASE_SERVICE_ROLE_KEY:'service-secret', OPENAI_API_KEY:'openai-secret' });
const json = (data: unknown, status=200) => Response.json(data,{status});
const request = (close=false) => new Request(`https://knufl.example/api/realtime${close?'/close':''}`,{
  method:'POST',headers:{Authorization:'Bearer member-token','Content-Type':close?'application/json':'application/sdp'},
  body:close?JSON.stringify({sessionId:voiceId}):'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
});

test('[mocked transport] service-role writes fail closed without an exact verified owner', async () => {
  let called = 0;
  const db = {config,bearerToken:'service-secret',apiKey:'service-secret',trustedOwnerId:owner,
    fetcher:async () => {called++; return json([]);}};
  await assert.rejects(supabaseRequest(db,'/rest/v1/completed_sets',{method:'POST',body:{user_id:other}}),/verified owner/);
  await assert.rejects(supabaseRequest(db,'/rest/v1/completed_sets',{method:'PATCH',body:{reps:6}}),/owner filter/);
  await assert.rejects(supabaseRequest(db,`/rest/v1/completed_sets?user_id=eq.${other}`,{method:'DELETE'}),/owner filter/);
  await assert.rejects(supabaseRequest(db,`/rest/v1/completed_sets?user_id=eq.${owner}&user_id=eq.${other}`,{method:'PATCH'}),/owner filter/);
  await assert.rejects(supabaseRequest(db,`/rest/v1/completed_sets?user_id=eq.${owner}`,{method:'PATCH',body:{user_id:other}}),/owner filter/);
  await assert.rejects(supabaseRequest(db,'/rest/v1/rpc/close_voice_session_for_user',{method:'POST',body:{p_user_id:other}}),/verified owner/);
  assert.equal(called,0);
  await supabaseRequest(db,`/rest/v1/completed_sets?user_id=eq.${owner}`,{method:'PATCH',body:{reps:6}});
  assert.equal(called,1);
});

test('[mocked provider] failed hangup stays pending, retains ledger and schedules server retry', async () => {
  const calls:string[]=[];
  const response=await handleRealtimeCloseRequest(request(true),config,{fetcher:async(input)=>{
    const url=String(input); calls.push(url);
    if(url.endsWith('/auth/v1/user'))return json({id:owner});
    if(url.includes('/voice_usage_sessions?'))return json([{id:voiceId,status:'active',openai_call_id:'rtc_test'}]);
    if(url.endsWith('/request_voice_close_for_user'))return json(true);
    if(url.endsWith('/hangup'))return json({},503);
    throw new Error('Unexpected request');
  }});
  assert.equal(response.status,200);
  assert.deepEqual((await response.json()).result,{closed:false,providerHungUp:false,pending:true});
  assert.equal(calls.some(url=>url.endsWith('/close_voice_session_for_user')),false);
  assert.ok(calls.findIndex(url=>url.endsWith('/request_voice_close_for_user'))<calls.findIndex(url=>url.endsWith('/hangup')));
});

test('[mocked provider] another account cannot close a known voice-session ID through the privileged Worker', async () => {
  let providerCalls=0;
  const response=await handleRealtimeCloseRequest(request(true),config,{fetcher:async(input)=>{
    const url=new URL(String(input));
    if(url.pathname==='/auth/v1/user')return json({id:other});
    if(url.pathname==='/rest/v1/voice_usage_sessions'){
      assert.equal(url.searchParams.get('user_id'),`eq.${other}`);return json([]);
    }
    providerCalls++;return json({});
  }});
  assert.equal(response.status,404);assert.equal(providerCalls,0);
});

test('[mocked provider] a missing supervisor prevents provider issuance', async () => {
  let calls=0;
  const response=await handleRealtimeRequest(request(),config,{fetcher:async(input)=>{
    if(String(input).endsWith('/auth/v1/user'))return json({id:owner});
    if(String(input).endsWith('/claim_voice_session_for_user'))return json([{allowed:false,reason:'supervisor_unavailable'}]);
    calls++;return json({});
  }});
  assert.equal(response.status,503);assert.equal(calls,0);
});

test('[mocked provider] malformed SDP is durably registered before cleanup; failed cleanup retains the reservation', async () => {
  const calls:string[]=[];
  const response=await handleRealtimeRequest(request(),config,{fetcher:async(input)=>{
    const url=String(input);calls.push(url);
    if(url.endsWith('/auth/v1/user'))return json({id:owner});
    if(url.endsWith('/claim_voice_session_for_user'))return json([{allowed:true,expires_at:'2026-09-05T23:59:59Z'}]);
    if(url.endsWith('/voice_provider_key_matches'))return json(true);
    if(url.includes('/profiles?'))return json([{companion_name:'Moss'}]);
    if(url.endsWith('/realtime/calls'))return new Response('invalid SDP',{status:201,headers:{Location:'/v1/realtime/calls/rtc_bad'}});
    if(url.endsWith('/attach_voice_call_for_user')||url.endsWith('/request_voice_close_for_user'))return json(true);
    if(url.endsWith('/hangup'))return json({},500);
    throw new Error('Unexpected request');
  }});
  assert.equal(response.status,502);
  assert.ok(calls.some(url=>url.endsWith('/attach_voice_call_for_user')));
  assert.ok(calls.some(url=>url.endsWith('/request_voice_close_for_user')));
  assert.equal(calls.some(url=>url.endsWith('/close_voice_session_for_user')),false);
});

test('[mocked provider] mismatched issuer/supervisor keys cannot create a remote call', async () => {
  let providerCalls=0;
  let released=false;
  const response=await handleRealtimeRequest(request(),config,{fetcher:async(input,init)=>{
    const url=String(input);
    if(url.endsWith('/auth/v1/user'))return json({id:owner});
    if(url.endsWith('/claim_voice_session_for_user'))return json([{allowed:true,expires_at:'2026-09-05T23:59:59Z'}]);
    if(url.endsWith('/voice_provider_key_matches')){
      const args=JSON.parse(String(init?.body));
      assert.equal(args.p_user_id,owner);
      assert.match(args.p_fingerprint,/^[a-f0-9]{64}$/);
      assert.equal(String(init?.body).includes(config.openAiApiKey),false);
      return json(false);
    }
    if(url.endsWith('/close_voice_session_for_user')){released=true;return json([{closed:true}]);}
    providerCalls++;return json({});
  }});
  assert.equal(response.status,503);assert.equal(providerCalls,0);assert.equal(released,true);
});
