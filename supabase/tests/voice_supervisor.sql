-- Real PostgreSQL/pgTAP when run in Supabase; provider transport is simulated.
-- The private transport function is replaced transactionally before any sweep.
-- Everything rolls back. No test call reaches OpenAI, even with a real Vault key.
begin;
create extension if not exists pgtap with schema extensions;
select plan(30);
select ok(position('http_set_curlopt' in pg_get_functiondef('knufl_private.hangup_provider_call(text)'::regprocedure))>0,'production transport uses the hosted-compatible timeout API');
select ok(position('''CURLOPT_TIMEOUT_MS'',''8000''' in pg_get_functiondef('knufl_private.hangup_provider_call(text)'::regprocedure))>0,'production hangup permits the observed five-second provider acknowledgement with an eight-second bound');
select set_config('knufl.test_provider_status','503',true);
select set_config('knufl.test_queue_count',(select count(*)::text from net.http_request_queue),true);
create or replace function knufl_private.hangup_provider_call(p_call_id text)
returns integer language sql as $$ select current_setting('knufl.test_provider_status')::integer $$;
insert into auth.users(id) values('51000000-0000-4000-8000-000000000001'),('52000000-0000-4000-8000-000000000002');
select vault.create_secret('test-only-never-sent', 'knufl_openai_api_key')
  where not exists (select 1 from vault.decrypted_secrets where name='knufl_openai_api_key');
select ok(not public.voice_provider_key_matches('51000000-0000-4000-8000-000000000001',repeat('0',64)),'mismatched issuer and supervisor keys are rejected');
select ok(public.voice_provider_key_matches('51000000-0000-4000-8000-000000000001',
  (select encode(sha256(convert_to(decrypted_secret,'UTF8')),'hex') from vault.decrypted_secrets where name='knufl_openai_api_key')),'matching key digest is accepted without exposing the key');
select ok(not has_function_privilege('authenticated','public.voice_provider_key_matches(uuid,text)','EXECUTE'),'browser cannot probe the private key matcher');
update knufl_private.voice_supervisor_health set last_tick_at=null,provider_key_ready=false;
select is((select reason from public.claim_voice_session_for_user('51000000-0000-4000-8000-000000000001',
  '53000000-0000-4000-8000-000000000003',1,1,1)),'supervisor_unavailable','no calls without independent supervision');
select knufl_private.supervise_voice_calls();
select ok((public.voice_supervisor_status()->>'healthy')::boolean,'scheduler tick verifies its Vault key');
select ok((select allowed from public.claim_voice_session_for_user('51000000-0000-4000-8000-000000000001',
  '53000000-0000-4000-8000-000000000003',1,1,1)),'healthy supervisor permits one reservation');
select ok(public.attach_voice_call_for_user('51000000-0000-4000-8000-000000000001',
  '53000000-0000-4000-8000-000000000003','rtc_supervisor_test'),'call attachment durably registers its hangup');
select ok(not public.attach_voice_call_for_user('51000000-0000-4000-8000-000000000001',
  '53000000-0000-4000-8000-000000000003','rtc_replacement'),'a call ID cannot be replaced under the same reservation');
select ok(not public.request_voice_close_for_user('52000000-0000-4000-8000-000000000002',
  '53000000-0000-4000-8000-000000000003'),'explicit wrong owner cannot schedule a hangup');
select ok(not (select closed from public.close_voice_session_for_user('51000000-0000-4000-8000-000000000001',
  '53000000-0000-4000-8000-000000000003',null)),'null confirmation cannot release an attached call');
update public.voice_usage_sessions set started_at=clock_timestamp()-interval '70 seconds',
  expires_at=clock_timestamp()-interval '1 second' where id='53000000-0000-4000-8000-000000000003';
select is((select reason from public.claim_voice_session_for_user('51000000-0000-4000-8000-000000000001',
  '54000000-0000-4000-8000-000000000004',1,1,1)),'concurrent_limit','deadline alone never releases a remote call');
update knufl_private.voice_hangups set due_at=clock_timestamp()-interval '1 second'
  where session_id='53000000-0000-4000-8000-000000000003';
select knufl_private.supervise_voice_calls();
select ok((select request_id is null and attempts=1 and last_status=503 from knufl_private.voice_hangups
  where session_id='53000000-0000-4000-8000-000000000003'),'server attempts overdue hangup without browser activity or queued credentials');
update knufl_private.voice_hangups set requested_at=clock_timestamp()-interval '6 seconds'
  where session_id='53000000-0000-4000-8000-000000000003';
select knufl_private.supervise_voice_calls();
select is((select attempts from knufl_private.voice_hangups where session_id='53000000-0000-4000-8000-000000000003'),2,'failed provider hangup is retried');
select is((select status from public.voice_usage_sessions where id='53000000-0000-4000-8000-000000000003'),'active','failure retains the active slot');
select set_config('knufl.test_provider_status','200',true);
update knufl_private.voice_hangups set requested_at=clock_timestamp()-interval '6 seconds'
  where session_id='53000000-0000-4000-8000-000000000003';
select knufl_private.supervise_voice_calls();
select is((select status from public.voice_usage_sessions where id='53000000-0000-4000-8000-000000000003'),'closed','provider acknowledgement releases the slot');
select ok((select ended_at > expires_at from public.voice_usage_sessions where id='53000000-0000-4000-8000-000000000003'),'overrun is charged rather than truncated at the planned deadline');
select is((select reason from public.claim_voice_session_for_user('51000000-0000-4000-8000-000000000001',
  '54000000-0000-4000-8000-000000000004',1,1,1)),'daily_budget_exhausted','actual usage enforces the daily allowance');
select ok(not has_schema_privilege('authenticated','knufl_private','USAGE'),'browser cannot access private supervisor tables or functions');
select ok(not has_function_privilege('authenticated','public.request_voice_close_for_user(uuid,uuid)','EXECUTE'),'browser cannot directly invoke privileged close RPC');
insert into public.voice_usage_sessions(id,user_id,expires_at,openai_call_id)
  values('55000000-0000-4000-8000-000000000005','52000000-0000-4000-8000-000000000002',now()+interval '5 minutes','rtc_delete_test');
insert into knufl_private.voice_hangups(session_id,call_id,due_at)
  values('55000000-0000-4000-8000-000000000005','rtc_delete_test',now()+interval '5 minutes');
delete from auth.users where id='52000000-0000-4000-8000-000000000002';
select ok((select due_at <= clock_timestamp() and confirmed_at is null from knufl_private.voice_hangups
  where session_id='55000000-0000-4000-8000-000000000005'),'account deletion retains and expedites remote-call cleanup');
insert into knufl_private.voice_hangups(session_id,call_id,due_at)
  values('56000000-0000-4000-8000-000000000006','rtc_batch_test',clock_timestamp());
select knufl_private.supervise_voice_calls();
select is((select count(*)::integer from knufl_private.voice_hangups where session_id in
  ('55000000-0000-4000-8000-000000000005','56000000-0000-4000-8000-000000000006') and confirmed_at is not null),1,'one sweep performs only one bounded provider request');
select is((select attempts from knufl_private.voice_hangups where session_id='56000000-0000-4000-8000-000000000006'),0,'later due work is preserved for the next sweep');
select knufl_private.supervise_voice_calls();
select ok((select confirmed_at is not null from knufl_private.voice_hangups where session_id='56000000-0000-4000-8000-000000000006'),'the next sweep completes the queued work');
select ok(exists(select 1 from cron.job where jobname='knufl-voice-supervisor' and schedule='1 second' and active),'one-second scheduler is installed');
select ok(not has_function_privilege('authenticated','knufl_private.hangup_provider_call(text)','EXECUTE'),'browser cannot invoke the key-bearing private transport');
select ok(position('net.http_post' in pg_get_functiondef('knufl_private.supervise_voice_calls()'::regprocedure))=0,'supervisor does not send credentials through the PUBLIC HTTP queue');
select is((select count(*)::text from net.http_request_queue),current_setting('knufl.test_queue_count'),'no request headers were persisted to the PUBLIC HTTP queue');
select ok(not has_table_privilege('authenticated','vault.decrypted_secrets','SELECT'),'browser cannot read the decrypted provider key');
select * from finish(true);
rollback;
