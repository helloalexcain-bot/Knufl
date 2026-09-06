// OPT-IN BILLABLE, real model + WebRTC output audio + deployed Worker + Supabase.
// Typed scripted input, NOT a physical microphone test. Disposable account only.
// Uses the shipped Realtime client/context resolver; no model/tool mock.
import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import ts from 'typescript';
const origin='https://knufl-voice-companion.alcain.chatgpt.site';
const input=createInterface({input:process.stdin,output:process.stdout,terminal:false});
const secrets=JSON.parse(await input.question('Ready for credentials on hidden stdin:\n'));input.close();
const opts={auth:{persistSession:false,autoRefreshToken:false}};
const admin=createClient('https://ntymjigywntaczxiqpdh.supabase.co',secrets.serviceRoleKey,opts);
const client=createClient('https://ntymjigywntaczxiqpdh.supabase.co',secrets.anonKey,opts);
const required=({data,error})=>{if(error)throw new Error('Supabase '+error.code);return data;};
const credentials={email:`knufl-conversation-${randomUUID()}@example.com`,password:randomUUID()+randomUUID()};
let user,token,localHost,watchdog,cleaning=false,calls=0;
const voices=new Set();
async function remote(path,body,sdp=false){return fetch(origin+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{Authorization:'Bearer '+token,'OAI-Sites-Authorization':'Bearer '+secrets.siteToken,'Content-Type':sdp?'application/sdp':'application/json'},body:sdp?body:JSON.stringify(body)});}
async function cleanup(){
  if(cleaning)return;cleaning=true;clearTimeout(watchdog);
  for(const id of voices)await remote('/api/realtime/close',{sessionId:id}).catch(()=>{});
  if(user){required(await admin.auth.admin.deleteUser(user.id));console.log('Removed disposable conversation account and all fixture records.');}
  await client.auth.signOut().catch(()=>{});server.close();
}
const html=`<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Knufl real-model conversation check</title><style>body{font:16px system-ui;max-width:850px;margin:24px auto;padding:16px;background:#f6f1e5;color:#073e31}button{font:inherit;padding:14px;margin:6px}pre{white-space:pre-wrap;background:white;padding:16px}input{font:inherit;padding:12px;width:70%}</style></head><body><h1>Real-model conversation check</h1><p>Disposable cloud account. Typed input, real OpenAI voice output. No microphone. Three calls maximum; cleanup watchdog eight minutes.</p><button id="run">Run bench sequence</button><button id="reconnect" disabled>Reconnect + superset sequence</button><button id="interrupt">Interrupt playback</button><button id="cleanup">Clean up test</button><p id="status">Ready</p><pre id="log"></pre><script type="module">
import {KnuflRealtimeClient} from '/client.js';
import {trainingContextFrom,resolvedSetArguments} from '/context.js';
const log=document.querySelector('#log'),status=document.querySelector('#status');
const show=text=>{log.textContent+='\\n'+text;fetch('/event',{method:'POST',body:text});};
const check=(value,label)=>{if(!value)throw Error(label);show('PASS: '+label);};
let voice,ctx={},settle,timer,timeout,tools=[],peak=0,finalReply=false;
async function tool(name,args={}){const response=await fetch('/tool',{method:'POST',body:JSON.stringify({name,arguments:args})});const data=await response.json();if(!response.ok)throw Error(data.error?.message||'Tool failed');return data.result;}
async function refresh(){ctx=await tool('get_session_context');voice?.updateTrainingContext(trainingContextFrom(ctx));return ctx;}
async function execute(call){
 const op='voice:'+call.callId;let args={...call.arguments};const name=call.name;tools.push(name);finalReply=false;
 await refresh();let t=trainingContextFrom(ctx);
 if(name==='record_set'&&!t.sessionId&&t.draft){await tool('start_workout',{...t.draft,operationKey:op+':start',localDate:new Date().toLocaleDateString('en-CA'),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone});await refresh();t=trainingContextFrom(ctx);}
 if(name==='record_set')args=resolvedSetArguments(args,ctx);
 if(name==='correct_set')args={...args,setId:args.setId??t.latestCompletedSet?.id,expectedVersion:args.expectedVersion??t.latestCompletedSet?.version};
 if(name==='start_rest_timer')args={...args,sessionId:args.sessionId??t.sessionId};
 if(name==='finish_workout')args={...args,sessionId:args.sessionId??t.sessionId,expectedVersion:args.expectedVersion??t.sessionVersion,localDate:t.localDate,timezone:t.timezone};
 if(name==='start_workout')args={...t.draft,...args,localDate:new Date().toLocaleDateString('en-CA'),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone};
 if(!['draft_workout','get_session_context','get_progress','get_rest_status','show_panel','close_panel'].includes(name))args.operationKey=op;
 const result=await tool(name,args);
 if(name==='record_set'){const repeated=await tool(name,args);check(repeated.set.id===result.set.id,'duplicate delivery returns the same set ID');}
 await refresh();show('TOOL '+name+': '+JSON.stringify(result));
 return {ok:true,...result,trainingContext:trainingContextFrom(ctx)};
}
function statusChanged(value){status.textContent=value;clearTimeout(timer);if(settle&&['listening','mic-off'].includes(value))timer=setTimeout(()=>{if(!finalReply)return;const done=settle;settle=undefined;clearTimeout(timeout);done();},1000);}
async function connect(){
 await voice?.disconnect();
 voice=new KnuflRealtimeClient({onStatus:statusChanged,onAmplitude:a=>{peak=Math.max(peak,a);},onTranscript:(role,text)=>{if(role==='assistant')finalReply=true;show(role.toUpperCase()+': '+text);},onInterrupted:()=>show('Playback interrupted'),onError:message=>show('ERROR: '+message),onToolCall:execute});
 await refresh();voice.setMuted(true);await voice.connect('disposable-harness',{microphone:false});
 await new Promise((resolve,reject)=>{let n=0;const poll=setInterval(()=>{if(voice.connected){clearInterval(poll);resolve();}else if(n++>100){clearInterval(poll);reject(Error('Connection timeout'));}},100);});
}
async function turn(text){tools=[];peak=0;finalReply=false;const done=new Promise((resolve,reject)=>{settle=resolve;timeout=setTimeout(()=>{settle=undefined;reject(Error('Response timeout'));},45000);});voice.sendText(text);await done;await refresh();show('Actual output-audio RMS peak: '+peak.toFixed(3));}
document.querySelector('#run').onclick=async event=>{
 event.target.disabled=true;
 try{
  await connect();
  await turn('Plan bench press, three sets of eight at sixty kilos total, with ninety seconds rest.');
  check(!ctx.completedSets.length,'planning logs no completed sets');
  await turn('First set done, eight reps.');
  check(ctx.completedSets.length===1&&ctx.completedSets[0].reps===8&&ctx.completedSets[0].load===60,'first report saved immediately as eight at sixty');
  const id=ctx.completedSets[0].id;
  await turn('Actually six.');check(ctx.completedSets.length===1&&ctx.completedSets[0].id===id&&ctx.completedSets[0].reps===6,'correction updates the same set');
  await turn('Same again.');check(ctx.completedSets.length===2&&ctx.completedSets[1].reps===6,'same again repeats actual corrected reps, not planned eight');
  await turn('Start a ninety-second rest.');check(Boolean(ctx.latestRestTimer?.ends_at),'rest is persisted');
  await turn('What is my actual bench press progress?');check(tools.includes('get_progress'),'progress is grounded by the real progress tool');
  await voice.disconnect();document.querySelector('#reconnect').disabled=false;show('Bench sequence complete; disconnected.');
 }catch(e){show('FAIL: '+e.message);await voice?.disconnect();}
};
document.querySelector('#reconnect').onclick=async event=>{
 event.target.disabled=true;
 try{
  await connect();
  await turn('Next set done, eight reps.');check(ctx.completedSets.length===3&&ctx.completedSets[2].load===60,'fresh Realtime call recovers active bench context');
  await turn('Finish this workout now.');check(!ctx.session,'workout finished');
  await turn('Plan a superset: bench press, three sets of eight at sixty kilos total, and barbell rows, three sets of eight at forty kilos total.');
  await turn('First set done, eight reps.');check(ctx.completedSets.length===0,'ambiguous superset report is not assigned to an exercise');
  await turn('Bench press. I completed eight reps.');check(ctx.completedSets.length===1&&ctx.completedSets[0].load===60,'explicit superset exercise resolves bench');
  await turn('Eight done.');check(ctx.completedSets.length===1,'next superset report still requires an explicit exercise');
  await turn('Switch to barbell rows.');check(trainingContextFrom(ctx).activeExercise?.name.toLowerCase().includes('row'),'explicit switch persists the active exercise');
  await turn('Eight done.');check(ctx.completedSets.length===2&&ctx.completedSets[1].load===40,'switched exercise inherits its own planned load');
  show('ALL MODEL CONVERSATION CHECKS PASSED.');await voice.disconnect();
 }catch(e){show('FAIL: '+e.message);await voice?.disconnect();}
};
document.querySelector('#interrupt').onclick=()=>voice?.interrupt();
document.querySelector('#cleanup').onclick=async()=>{await voice?.disconnect();await fetch('/cleanup',{method:'POST'});show('Cleanup requested');};
</script></body></html>`;
const server=createServer(async(req,res)=>{
 try{
  if(req.headers.host!==localHost||(req.method==='POST'&&req.headers.origin!=='http://'+localHost)){res.writeHead(403).end();return;}
  if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'}).end(html);return;}
  if(req.method==='GET'&&['/client.js','/context.js'].includes(req.url)){
    const source=await readFile(req.url==='/client.js'?'lib/realtime-client.ts':'lib/training-context.ts','utf8');
    res.writeHead(200,{'Content-Type':'text/javascript'}).end(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);return;
  }
  let body='';for await(const chunk of req){body+=chunk;if(body.length>150000)throw Error('Body too large');}
  if(req.url==='/cleanup'){res.writeHead(204).end();await cleanup();return;}
  if(req.url==='/event'){console.log(body);res.writeHead(204).end();return;}
  if(!['/api/realtime','/api/realtime/close','/tool'].includes(req.url)){res.writeHead(404).end();return;}
  if(req.url==='/api/realtime'&&++calls>3){res.writeHead(429).end('Test call cap');return;}
  const response=await remote(req.url==='/tool'?'/api/tools':req.url,req.url==='/api/realtime'?body:JSON.parse(body),req.url==='/api/realtime');
  const id=response.headers.get('x-knufl-voice-session');if(id)voices.add(id);
  const headers={'Content-Type':response.headers.get('content-type')??'text/plain'};
  for(const key of ['X-Knufl-Voice-Session','X-Knufl-Voice-Expires-At'])if(response.headers.has(key))headers[key]=response.headers.get(key);
  res.writeHead(response.status,headers).end(await response.text());
 }catch(e){console.error('Harness failure:',e.message);if(!res.headersSent)res.writeHead(500).end('Harness failed');}
});
try{
 user=required(await admin.auth.admin.createUser({...credentials,email_confirm:true,app_metadata:{knufl_disposable_test:true}})).user;
 token=required(await client.auth.signInWithPassword(credentials)).session.access_token;
 required(await admin.from('profiles').insert({user_id:user.id,companion_name:'Test Knufl'}));
 required(await admin.from('preferences').insert({user_id:user.id,timezone:'Europe/London'}));
 server.listen(0,'127.0.0.1',()=>{localHost='127.0.0.1:'+server.address().port;console.log('Open http://'+localHost+'/');});
 watchdog=setTimeout(()=>void cleanup(),8*60000);
 process.on('SIGINT',()=>void cleanup());process.on('SIGTERM',()=>void cleanup());
}catch(e){console.error('Setup failed:',e.message);await cleanup();process.exitCode=1;}
