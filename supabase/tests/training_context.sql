begin;
create extension if not exists pgtap with schema extensions;
select plan(11);
select is(public.knufl_restore_snapshot('{"preferences":{"timezone":"Europe/London","gender":"old"}}')->'preferences', '{"timezone":"Europe/London","training_context":null}'::jsonb,'older archives gain nullable context and still discard legacy identity');
insert into auth.users(id) values ('10000000-0000-4000-8000-000000000001'),('20000000-0000-4000-8000-000000000002');
insert into public.profiles(user_id,companion_name) values('10000000-0000-4000-8000-000000000001','Pip');
insert into public.workout_sessions(id,user_id,source,status,local_date,timezone,started_at) values
 ('training-a','10000000-0000-4000-8000-000000000001','manual','active','2026-09-06','Europe/London',now()),
 ('training-b','20000000-0000-4000-8000-000000000002','manual','active','2026-09-06','Europe/London',now());
insert into public.exercise_instances(id,user_id,session_id,position,exercise_key,display_name) values
 ('bench-a','10000000-0000-4000-8000-000000000001','training-a',0,'bench','Bench press'),
 ('row-a','10000000-0000-4000-8000-000000000001','training-a',1,'row','Row'),
 ('bench-b','20000000-0000-4000-8000-000000000002','training-b',0,'bench','Bench press');
select is(public.put_training_state_for_user('10000000-0000-4000-8000-000000000001','{"draft":{"title":"Bench","exercises":[{"name":"Bench press","sets":3}]}}')->'draft'->>'title','Bench','draft persists');
select public.put_training_state_for_user('10000000-0000-4000-8000-000000000001','{"sessionId":"training-a","exerciseId":"bench-a","superset":false}');
select throws_ok($$select public.put_training_state_for_user('10000000-0000-4000-8000-000000000001','{"sessionId":"training-b","exerciseId":"bench-b"}')$$,'P0001','Workout not owned','privileged RPC rejects foreign workout');
select throws_ok($$select public.put_training_state_for_user('10000000-0000-4000-8000-000000000001','{"exerciseId":"bench-b"}')$$,'P0001','Exercise not owned','privileged RPC rejects foreign exercise');
select throws_ok($$select public.put_training_state_for_user('10000000-0000-4000-8000-000000000001','{"user_id":"other"}')$$,'P0001','Invalid training context','owner injection rejected');
select is((select companion_name from public.profiles where user_id='10000000-0000-4000-8000-000000000001'),'Pip','name remains unchanged');
insert into public.completed_sets(id,user_id,session_id,exercise_instance_id,set_order,reps,completed_at) values
 ('training-set','10000000-0000-4000-8000-000000000001','training-a','row-a',1,8,now());
select is((select training_context->>'exerciseId' from public.preferences where user_id='10000000-0000-4000-8000-000000000001'),'row-a','explicit completed exercise advances cursor atomically');
select public.put_training_state_for_user('10000000-0000-4000-8000-000000000001','{"exerciseId":"bench-a","superset":true}');
insert into public.completed_sets(id,user_id,session_id,exercise_instance_id,set_order,reps,completed_at) values
 ('training-set-2','10000000-0000-4000-8000-000000000001','training-a','bench-a',1,8,now());
select is((select training_context->>'exerciseId' from public.preferences where user_id='10000000-0000-4000-8000-000000000001'),null::text,'superset never guesses next exercise');
select is(public.knufl_account_snapshot('10000000-0000-4000-8000-000000000001')->'preferences'->'training_context'->>'superset','true','archive retains context');
set local role authenticated;
select set_config('request.jwt.claim.sub','20000000-0000-4000-8000-000000000002',true);
select is((select count(*) from public.preferences where user_id='10000000-0000-4000-8000-000000000001'),0::bigint,'another account cannot read context');
select throws_ok($$select public.put_training_state_for_user('10000000-0000-4000-8000-000000000001','{}')$$,'42501','permission denied for function put_training_state_for_user','browser role cannot call privileged context RPC');
reset role;
select * from finish(true);
rollback;
