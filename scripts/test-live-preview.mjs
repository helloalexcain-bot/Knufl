// Real Supabase Auth/PostgREST, real bearer validation and service-role writes.
// Creates only disposable, email-confirmed test accounts; never sends email.
// No OpenAI calls. --origin tests the deployed Worker; otherwise the same HTTP
// handler runs locally with REAL providers (not mocked fetch/Auth/RLS).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { readServerConfig } from '../server/knufl-api/config.ts';
import { handleToolsRequest } from '../server/knufl-api/http.ts';

const ref = 'ntymjigywntaczxiqpdh';
const originAt = process.argv.indexOf('--origin');
const origin = originAt >= 0 ? process.argv[originAt + 1] : null;
if (origin && origin !== 'https://knufl-voice-companion.alcain.chatgpt.site') {
  throw new Error('This runner is restricted to the Knufl owner-private preview.');
}
const keys = JSON.parse(execFileSync('npx', ['--yes', 'supabase@latest', 'projects',
  'api-keys', '--project-ref', ref, '--output', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
const config = readServerConfig({
  NEXT_PUBLIC_SUPABASE_URL: `https://${ref}.supabase.co`,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: keys.find(k => k.name === 'anon').api_key,
  SUPABASE_SERVICE_ROLE_KEY: keys.find(k => k.name === 'service_role').api_key,
});
let siteToken;
if (origin) {
  // readline's terminal mode echoes input itself, even with stty -echo.
  const input = createInterface({input: process.stdin, output: process.stdout, terminal:false});
  siteToken = await input.question('Ready for private preview access credential on stdin (input must be hidden):\n');
  input.close();
  assert(siteToken.length > 20, 'Private preview credential required; access is never changed.');
}
const options = {auth:{persistSession:false, autoRefreshToken:false, detectSessionInUrl:false}};
const admin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, options);
const ownedUsers = [];
const clients = [];
let checks = 0;
const passed = label => { checks++; console.log(`LIVE ${checks}: ${label}`); };
const result = ({data,error}) => { if(error) throw new Error('Supabase rejected test operation: ' + error.code); return data; };
const signIn = async credentials => {
  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, options);
  clients.push(client);
  const data = result(await client.auth.signInWithPassword(credentials));
  return {client, token:data.session.access_token, user:data.user, credentials};
};
const newAccount = async () => {
  const credentials = {email:`knufl-live-${randomUUID()}@example.com`, password:randomUUID()+randomUUID()};
  const data = result(await admin.auth.admin.createUser({...credentials, email_confirm:true,
    app_metadata:{knufl_disposable_test:true}}));
  ownedUsers.push(data.user.id);
  return signIn(credentials);
};
const call = async (account,name,args={},expected=200) => {
  const request = new Request((origin ?? 'https://knufl-local-handler.example')+'/api/tools', {
    method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer '+account.token,
      ...(siteToken ? {'OAI-Sites-Authorization':'Bearer '+siteToken}: {})},
    body:JSON.stringify({name,arguments:args}),
  });
  const response = origin ? await fetch(request,{redirect:'error',signal:AbortSignal.timeout(30000)}) : await handleToolsRequest(request,config);
  const payload = await response.json();
  assert.equal(response.status,expected,`${name}: expected ${expected}, received ${response.status}; ${payload.error?.code ?? ''}`);
  return payload.result;
};
const op = () => 'live-'+randomUUID();
const day = new Date().toISOString().slice(0,10);
const workout = {localDate:day,timezone:'UTC',title:'Disposable integration check',
  exercises:[{name:'Bench press',sets:3,reps:8,load:60,loadUnit:'kg',loadMode:'barbell_total',restSeconds:90}]};
const snapshotTables = ['profiles','preferences','workout_sessions','exercise_instances','completed_sets',
  'set_revisions','rest_timers','cardio_records','exercise_day_credits','milestone_unlocks','memories'];
const snapshot = async account => Object.fromEntries(await Promise.all(snapshotTables.map(async table => {
  const rows = result(await admin.from(table).select('*').eq('user_id',account.user.id));
  return [table, rows.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))];
})));

try {
  if (origin) {
    const publicConfigResponse=await fetch(origin+'/api/config',{headers:{'OAI-Sites-Authorization':'Bearer '+siteToken},redirect:'error'});
    const publicConfig=await publicConfigResponse.json();
    assert.equal(publicConfig.cloudConfigured,true);
    assert.equal(publicConfig.supabaseUrl,config.supabaseUrl);
    assert.equal(JSON.stringify(publicConfig).includes(config.supabaseServiceRoleKey),false);
    passed('deployed runtime exposes only public configuration, not the service-role secret');
    for(const name of ['hero','wave','wobble','balance','pawtap']) {
      const response=await fetch(origin+'/bram/'+name+'.png',{headers:{'OAI-Sites-Authorization':'Bearer '+siteToken},redirect:'error'});
      assert.equal(response.status,200);
      const hash=data=>createHash('sha256').update(data).digest('hex');
      assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(await readFile('public/bram/'+name+'.png')));
    }
    passed('all five published character assets exactly match the approved source files');
    const gated=await fetch(origin+'/',{redirect:'manual'});
    assert.equal(gated.status,200);
    assert.match(await gated.text(),/signin-with-chatgpt/);
    const legacy=await fetch('https://helloalexcain-bot.github.io/Knufl/',{redirect:'error'});
    assert.equal(legacy.status,200);
    assert.match(await legacy.text(),/\/Knufl\/assets\//);
    passed('private owner gate remains active and the public GitHub Pages prototype is available');
  }
  const a = await newAccount();
  const b = await newAccount();
  passed('two disposable users sign in through real Supabase Auth');
  result(await a.client.from('profiles').insert({user_id:a.user.id,companion_name:'Pip'}));
  result(await a.client.from('preferences').insert({user_id:a.user.id,timezone:'UTC'}));
  const draft = await call(a,'draft_workout',{exercises:workout.exercises});
  assert.equal(draft.saved,false);
  assert.equal(result(await a.client.from('completed_sets').select('id')).length,0);
  passed('planning creates no completed sets');
  const started = await call(a,'start_workout',{...workout,operationKey:op()});
  const sessionId = started.session.id;
  const exerciseInstanceId = started.exercises[0].id;
  const setOp = op();
  const setArgs = {operationKey:setOp,sessionId,exerciseInstanceId,reps:8,load:60,loadUnit:'kg',loadMode:'barbell_total'};
  const recorded = await call(a,'record_set',setArgs);
  const repeated = await call(a,'record_set',setArgs);
  assert.equal(recorded.set.id,repeated.set.id);
  assert.equal(result(await a.client.from('completed_sets').select('id')).length,1);
  passed('service-role Worker records one completed set; retry does not duplicate it');
  const initialRevisionCount = result(await a.client.from('set_revisions').select('id')).length;
  const corrected = await call(a,'correct_set',{operationKey:op(),setId:recorded.set.id,
    expectedVersion:recorded.set.version,reps:6});
  assert.equal(corrected.set.id,recorded.set.id);
  assert.equal(corrected.set.reps,6);
  assert.equal(result(await a.client.from('set_revisions').select('id')).length,initialRevisionCount+1);
  passed('correction preserves the set ID and writes an audit revision');
  await call(a,'correct_set',{operationKey:op(),setId:recorded.set.id,
    expectedVersion:recorded.set.version,reps:7},409);
  passed('stale-device correction is rejected, not silently overwritten');
  const rest = await call(a,'start_rest_timer',{operationKey:op(),sessionId,durationSeconds:90});
  assert.equal(Date.parse(rest.timer.endsAt)-Date.parse(rest.timer.startedAt),90000);
  const a2 = await signIn(a.credentials);
  assert.notEqual(a2.token,a.token);
  const recovered = await call(a2,'get_session_context',{sessionId});
  assert.equal(recovered.companionName,'Pip');
  assert.equal(recovered.completedSets.length,1);
  assert.equal(recovered.completedSets[0].reps,6);
  assert.equal(recovered.latestRestTimer.ends_at,rest.timer.endsAt);
  passed('independent Auth session recovers name, corrected set and exact rest deadline (API clients, not physical devices)');
  const progress = await call(a2,'get_progress',{kind:'strength',exercise:'Bench press',fromDate:day,toDate:day});
  assert.equal(progress.records.length,1);
  assert.equal(progress.records[0].reps,6);
  assert.equal(progress.comparison.comparable,false);
  passed('grounded progress uses the corrected record and refuses a one-set improvement comparison');
  const bStarted = await call(b,'start_workout',{...workout,operationKey:op()});
  const before = await snapshot(a);
  const noForeign = await call(b,'get_session_context',{sessionId});
  assert.equal(noForeign.session,null);
  assert.equal(noForeign.completedSets.length,0);
  await call(b,'record_set',{...setArgs,operationKey:op()},404);
  await call(b,'record_set',{...setArgs,operationKey:op(),sessionId:bStarted.session.id},404);
  await call(b,'correct_set',{operationKey:op(),setId:recorded.set.id,expectedVersion:corrected.set.version,reps:999},404);
  await call(b,'start_rest_timer',{operationKey:op(),sessionId,durationSeconds:10},404);
  await call(b,'finish_workout',{operationKey:op(),sessionId,expectedVersion:1,localDate:day,timezone:'UTC'},404);
  await call(b,'record_cardio',{operationKey:op(),sessionId,activity:'Walking',distance:1,distanceUnit:'km',
    durationSeconds:600,localDate:day,timezone:'UTC'},404);
  await call(b,'undo_last_action',{operationKey:op(),targetOperationKey:setOp},404);
  await call(b,'record_set',{...setArgs,operationKey:op(),user_id:a.user.id},400);
  await call(b,'start_workout',{...workout,operationKey:op(),owner:a.user.id},400);
  assert.deepEqual(await snapshot(a),before);
  passed('authenticated cross-account Worker ID attacks and owner injection cannot read/change account A');
  assert.equal(result(await b.client.from('completed_sets').select('*').eq('id',recorded.set.id)).length,0);
  const directWrite = await b.client.from('completed_sets').update({reps:999}).eq('id',recorded.set.id);
  assert(directWrite.error || directWrite.data === null);
  assert.deepEqual(await snapshot(a),before);
  passed('direct REST/RLS access also cannot read or mutate account A');
  const finished = await call(a,'finish_workout',{operationKey:op(),sessionId,expectedVersion:1,localDate:day,timezone:'UTC'});
  assert.equal(finished.saved,true);
  const another = await call(a,'start_workout',{...workout,operationKey:op()});
  await call(a,'record_set',{...setArgs,operationKey:op(),sessionId:another.session.id,exerciseInstanceId:another.exercises[0].id});
  await call(a,'finish_workout',{operationKey:op(),sessionId:another.session.id,expectedVersion:1,localDate:day,timezone:'UTC'});
  assert.equal(result(await a.client.from('exercise_day_credits').select('*')).length,1);
  passed('additional same-day workout remains logged without duplicate exercise-day credit');
  console.log(`PASS: ${checks} live integration groups. Target: ${origin ?? 'local Worker HTTP handler + live Supabase'}.`);
  console.log('NOT VERIFIED here: Google/Apple OAuth, real microphone, OpenAI, browser UI or physical devices.');
} catch(error) {
  console.error('FAIL:',error.message);
  process.exitCode=1;
} finally {
  // Exact IDs created by this invocation only. Never query/delete existing users.
  for (const client of clients) await client.auth.signOut().catch(()=>{});
  let deleted=0;
  for (const id of ownedUsers) {
    const {error} = await admin.auth.admin.deleteUser(id);
    if(error){console.error('Cleanup failed for disposable test account:',id,error.code);process.exitCode=1;}
    else deleted++;
  }
  console.log('Deleted '+deleted+'/'+ownedUsers.length+' disposable test accounts and their test records.');
}
