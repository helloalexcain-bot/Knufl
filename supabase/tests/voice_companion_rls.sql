-- Run with `supabase test db` after applying migrations to a local Supabase stack.
-- These are live Postgres/RLS checks, separate from the Node domain-unit tests.

begin;

create extension if not exists pgtap with schema extensions;
select plan(66);

-- Budget-unit setup only. The real scheduler/key health is verified separately;
-- this transaction rolls back and never claims live runtime readiness.
update knufl_private.voice_supervisor_health
  set last_tick_at = clock_timestamp(), provider_key_ready = true;

select is(
  (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any (array[
        'profiles', 'preferences', 'workout_plans', 'plan_exercises',
        'workout_occurrences', 'workout_sessions', 'exercise_instances',
        'operation_receipts', 'completed_sets', 'set_revisions', 'cardio_records',
        'rest_timers', 'memories', 'exercise_day_credits', 'milestone_unlocks',
        'import_batches', 'import_items', 'sync_conflicts', 'voice_usage_sessions'
      ])
      and c.relrowsecurity
  ),
  19::bigint,
  'every Knufl account table has RLS enabled'
);

select is(
  (
    select count(*)
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = any (array[
        'profiles', 'preferences', 'workout_plans', 'plan_exercises',
        'workout_occurrences', 'workout_sessions', 'exercise_instances',
        'operation_receipts', 'completed_sets', 'set_revisions', 'cardio_records',
        'rest_timers', 'memories', 'exercise_day_credits', 'milestone_unlocks',
        'import_batches', 'import_items', 'sync_conflicts', 'voice_usage_sessions'
      ])
      and c.relforcerowsecurity
  ),
  19::bigint,
  'RLS remains enforced for table-owner code paths'
);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values
  (
    '00000000-0000-0000-0000-000000000000',
    '10000000-0000-0000-0000-000000000001',
    'authenticated', 'authenticated', 'knufl-a@example.test', '',
    now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '20000000-0000-0000-0000-000000000002',
    'authenticated', 'authenticated', 'knufl-b@example.test', '',
    now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '30000000-0000-0000-0000-000000000003',
    'authenticated', 'authenticated', 'knufl-restore@example.test', '',
    now(), '{}'::jsonb, '{}'::jsonb, now(), now()
  );

insert into public.profiles (user_id, companion_name) values
  ('10000000-0000-0000-0000-000000000001', 'Aster'),
  ('20000000-0000-0000-0000-000000000002', 'Moss');

insert into public.profiles (user_id) values
  ('30000000-0000-0000-0000-000000000003');
select is(
  (select companion_name from public.profiles where user_id = '30000000-0000-0000-0000-000000000003'),
  'Knufl',
  'new profiles default to the product companion name'
);
delete from public.profiles where user_id = '30000000-0000-0000-0000-000000000003';

insert into public.workout_sessions (
  id, user_id, source, status, local_date, timezone, started_at
) values (
  'account-b-session', '20000000-0000-0000-0000-000000000002',
  'manual', 'active', '2026-09-05', 'Europe/London', '2026-09-05T08:00:00Z'
);

select throws_ok(
  $$
    insert into public.workout_sessions (
      id, user_id, source, status, local_date, timezone, started_at
    ) values (
      'account-b-second-active', '20000000-0000-0000-0000-000000000002',
      'manual', 'active', '2026-09-05', 'Europe/London', '2026-09-05T08:01:00Z'
    )
  $$,
  '23505',
  null,
  'an account cannot start two active workouts across concurrent devices'
);

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

select is(
  (select count(*) from public.profiles),
  1::bigint,
  'a signed-in user sees only their own profile'
);

select is(
  (select companion_name from public.profiles limit 1),
  'Aster',
  'the other account profile is not leaked'
);

select ok(
  (
    select bool_and(
      not has_table_privilege('authenticated', 'public.' || table_name, 'INSERT')
      and not has_table_privilege('authenticated', 'public.' || table_name, 'UPDATE')
      and not has_table_privilege('authenticated', 'public.' || table_name, 'DELETE')
      and has_table_privilege('service_role', 'public.' || table_name, 'INSERT')
      and has_table_privilege('service_role', 'public.' || table_name, 'UPDATE')
      and has_table_privilege('service_role', 'public.' || table_name, 'DELETE')
    )
    from unnest(array[
      'workout_plans', 'plan_exercises', 'workout_occurrences',
      'workout_sessions', 'exercise_instances', 'completed_sets',
      'cardio_records', 'rest_timers', 'sync_conflicts'
    ]) table_name
  )
    and has_table_privilege('authenticated', 'public.profiles', 'UPDATE')
    and has_table_privilege('authenticated', 'public.preferences', 'UPDATE')
    and has_table_privilege('authenticated', 'public.memories', 'UPDATE'),
  'only the server role can directly mutate workout data'
);

set local role service_role;
select throws_ok(
  $$
    insert into public.exercise_instances (
      id, user_id, session_id, position, exercise_key, display_name
    ) values (
      'cross-owner-exercise', '10000000-0000-0000-0000-000000000001',
      'account-b-session', 0, 'bench-press', 'Bench press'
    )
  $$,
  '23503',
  null,
  'a child row cannot attach to another account parent'
);
set local role authenticated;

select ok(
  not has_table_privilege('authenticated', 'public.milestone_unlocks', 'INSERT'),
  'clients cannot forge milestone unlocks'
);

select ok(
  not has_table_privilege('authenticated', 'public.exercise_day_credits', 'DELETE'),
  'clients cannot retract earned day credits'
);

select ok(
  not has_table_privilege('authenticated', 'public.operation_receipts', 'DELETE'),
  'clients cannot delete operation keys and replay a mutation'
);

set local role service_role;
insert into public.workout_occurrences (
  id, user_id, scheduled_local_date, timezone, status
) values (
  'atomic-occurrence',
  '10000000-0000-0000-0000-000000000001',
  '2026-09-01',
  'Europe/London',
  'scheduled'
);
insert into public.workout_sessions (
  id, user_id, occurrence_id, source, status, local_date, timezone, started_at
) values (
  'atomic-occurrence-session',
  '10000000-0000-0000-0000-000000000001',
  'atomic-occurrence',
  'planned',
  'active',
  '2026-09-01',
  'Europe/London',
  '2026-09-01T07:00:00Z'
);
update public.workout_sessions
set status = 'completed', completed_at = '2026-09-01T07:30:00Z'
where id = 'atomic-occurrence-session';

select ok(
  exists (
    select 1 from public.workout_occurrences
    where id = 'atomic-occurrence'
      and status = 'completed'
      and completed_session_id = 'atomic-occurrence-session'
  ),
  'session completion updates its planned occurrence in the same database transaction'
);

insert into public.workout_sessions (
  id, user_id, source, status, local_date, timezone, started_at, completed_at
) values
  (
    'day-one-a', '10000000-0000-0000-0000-000000000001', 'manual', 'completed',
    '2026-09-01', 'Europe/London', '2026-09-01T08:00:00Z', '2026-09-01T08:30:00Z'
  ),
  (
    'day-one-b', '10000000-0000-0000-0000-000000000001', 'manual', 'completed',
    '2026-09-01', 'Europe/London', '2026-09-01T18:00:00Z', '2026-09-01T18:30:00Z'
  ),
  (
    'day-two', '10000000-0000-0000-0000-000000000001', 'manual', 'completed',
    '2026-09-02', 'Europe/London', '2026-09-02T08:00:00Z', '2026-09-02T08:30:00Z'
  ),
  (
    'day-three', '10000000-0000-0000-0000-000000000001', 'manual', 'completed',
    '2026-09-03', 'Europe/London', '2026-09-03T08:00:00Z', '2026-09-03T08:30:00Z'
  );

select is(
  (select count(*) from public.exercise_day_credits),
  3::bigint,
  'multiple sessions on one local date award one day credit'
);

select ok(
  exists (select 1 from public.milestone_unlocks where milestone_id = 'first-session'),
  'a completed session unlocks first-session once'
);

select ok(
  exists (select 1 from public.milestone_unlocks where milestone_id = 'little-mountain'),
  'three exercise days unlock Little Mountain'
);

delete from public.workout_sessions where id = 'day-three';

select is(
  (select count(*) from public.exercise_day_credits),
  3::bigint,
  'deleting history does not retract earned credits'
);

select ok(
  exists (select 1 from public.milestone_unlocks where milestone_id = 'little-mountain'),
  'deleting history does not relock an earned milestone'
);

insert into public.exercise_instances (
  id, user_id, session_id, position, exercise_key, display_name
) values (
  'bench-instance', '10000000-0000-0000-0000-000000000001',
  'day-one-a', 0, 'bench-press', 'Bench press'
);

select throws_ok(
  $$
    insert into public.completed_sets (
      id, user_id, session_id, exercise_instance_id, set_order, reps, completed_at
    ) values (
      'wrong-session-set', '10000000-0000-0000-0000-000000000001',
      'day-two', 'bench-instance', 1, 8, '2026-09-02T08:10:00Z'
    )
  $$,
  '23503',
  null,
  'an exercise and completed set must belong to the same session'
);

insert into public.completed_sets (
  id, user_id, session_id, exercise_instance_id, set_order, reps,
  load, load_unit, load_mode, completed_at
) values (
  'bench-set', '10000000-0000-0000-0000-000000000001',
  'day-one-a', 'bench-instance', 1, 8, 60, 'kg', 'total', '2026-09-01T08:10:00Z'
);

select is(
  (select count(*) from public.set_revisions where set_id = 'bench-set'),
  1::bigint,
  'recording an actual set writes an immutable audit revision'
);

update public.completed_sets set reps = 6 where id = 'bench-set' and version = 1;

select is(
  (select version from public.completed_sets where id = 'bench-set'),
  2,
  'optimistic edits increment the server version'
);

select is(
  (select count(*) from public.set_revisions where set_id = 'bench-set'),
  2::bigint,
  'a correction appends a revision instead of replacing identity'
);

set local role authenticated;
select hasnt_column('public', 'profiles', 'gender', 'profiles have no legacy gender field');
select hasnt_column('public', 'profiles', 'pronouns', 'profiles have no legacy pronoun field');

select ok(
  not has_table_privilege('authenticated', 'public.operation_receipts', 'INSERT')
    and not has_table_privilege('authenticated', 'public.operation_receipts', 'UPDATE'),
  'browser clients cannot bypass atomic operation receipt RPCs with direct writes'
);

select ok(
  has_column_privilege('authenticated', 'public.operation_receipts', 'operation_key', 'SELECT')
    and not has_column_privilege('authenticated', 'public.operation_receipts', 'claim_token', 'SELECT')
    and not has_column_privilege('authenticated', 'public.operation_receipts', 'lease_expires_at', 'SELECT'),
  'receipt history remains readable without exposing live lease credentials'
);

select ok(
  has_function_privilege(
    'authenticated',
    'public.claim_operation_receipt(text,text,uuid,timestamptz,integer)',
    'EXECUTE'
  )
    and has_function_privilege(
      'authenticated',
      'public.finish_operation_receipt(uuid,uuid,boolean,text,text,jsonb,text,timestamptz)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.claim_operation_receipt(text,text,uuid,timestamptz,integer)',
      'EXECUTE'
    ),
  'only authenticated callers can claim and finalize their own operation receipts'
);

with first_claim as materialized (
  select * from public.claim_operation_receipt(
    'receipt-test-key',
    'record_set',
    '50000000-0000-4000-8000-000000000005',
    '2026-09-05T09:00:00Z',
    90
  )
)
select ok(
  (select claimed from first_claim)
    and set_config(
      'knufl.test_operation_token',
      (select claim_token::text from first_claim),
      true
    ) is not null,
  'an authenticated mutation atomically claims a fresh operation key'
);

select is(
  (select reason from public.claim_operation_receipt(
    'receipt-test-key',
    'record_set',
    '50000000-0000-4000-8000-000000000005',
    '2026-09-05T09:00:00Z',
    90
  )),
  'in_progress',
  'a live operation lease prevents a concurrent executor'
);

select ok(
  (select claim_token is null from public.claim_operation_receipt(
    'receipt-test-key',
    'record_set',
    '50000000-0000-4000-8000-000000000005',
    '2026-09-05T09:00:00Z',
    90
  )),
  'an unclaimed response never exposes the active executor token'
);

select is(
  (select reason from public.claim_operation_receipt(
    'receipt-test-key',
    'record_cardio',
    '50000000-0000-4000-8000-000000000005',
    '2026-09-05T09:00:00Z',
    90
  )),
  'type_conflict',
  'a key cannot be reused by another tool while it is pending'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);

select is(
  (select reason from public.finish_operation_receipt(
    '50000000-0000-4000-8000-000000000005',
    current_setting('knufl.test_operation_token')::uuid,
    true,
    'completed_set',
    'receipt-test-set',
    '{"saved":true}'::jsonb,
    null,
    '2026-09-05T09:00:01Z'
  )),
  'not_found',
  'an account cannot finalize another account operation receipt'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}',
  true
);

select ok(
  (select finalized from public.finish_operation_receipt(
    '50000000-0000-4000-8000-000000000005',
    current_setting('knufl.test_operation_token')::uuid,
    true,
    'completed_set',
    'receipt-test-set',
    '{"saved":true}'::jsonb,
    null,
    '2026-09-05T09:00:01Z'
  )),
  'the lease owner can finalize the claimed operation'
);

select is(
  (select result from public.claim_operation_receipt(
    'receipt-test-key',
    'record_set',
    '50000000-0000-4000-8000-000000000005',
    '2026-09-05T09:00:00Z',
    90
  )),
  '{"saved": true}'::jsonb,
  'a successful retry returns the committed result without executing again'
);

select is(
  (select reason from public.claim_operation_receipt(
    'receipt-test-key',
    'record_cardio',
    '50000000-0000-4000-8000-000000000005',
    '2026-09-05T09:00:00Z',
    90
  )),
  'type_conflict',
  'operation type identity is checked before the succeeded fast path'
);

select ok(
  (public.preview_legacy_import(
    '{
      "version": 1,
      "profile": {"name": "Aster", "gender": "discard", "pronouns": "discard"},
      "logs": [{
        "id": "account-b-session",
        "date": "2026-09-05",
        "createdAt": "2026-09-05T08:00:00Z"
      }],
      "memories": [],
      "unlockedMoves": []
    }'::jsonb,
    repeat('d', 64)
  )#>'{sessions,conflicts}') ? 'account-b-session',
  'legacy import preview rejects a stable ID already owned by another account'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);

select is(
  public.import_legacy_progress(
    '{
      "version": 1,
      "profile": {"name": "Moss", "gender": "old", "pronouns": "old"},
      "plan": {"weeklyTarget": 3, "days": ["Mon"], "activity": "Walking", "activityDetail": ""},
      "logs": [{
        "id": "legacy-stable-id",
        "date": "2026-08-30",
        "activity": "Walking",
        "duration": 20,
        "createdAt": "2026-08-30T08:00:00Z"
      }],
      "memories": [],
      "unlockedMoves": ["first-session"]
    }'::jsonb,
    repeat('a', 64)
  )->>'status',
  'completed',
  'a compatible legacy export imports successfully'
);

select is(
  public.import_legacy_progress(
    '{
      "version": 1,
      "profile": {"name": "Moss", "gender": "old", "pronouns": "old"},
      "plan": {"weeklyTarget": 3, "days": ["Mon"], "activity": "Walking", "activityDetail": ""},
      "logs": [{
        "id": "legacy-stable-id",
        "date": "2026-08-30",
        "activity": "Walking",
        "duration": 20,
        "createdAt": "2026-08-30T08:00:00Z"
      }],
      "memories": [],
      "unlockedMoves": ["first-session"]
    }'::jsonb,
    repeat('a', 64)
  )->>'status',
  'already-imported',
  'repeating an import batch is idempotent'
);

select is(
  (select count(*) from public.workout_sessions where id = 'legacy-stable-id'),
  1::bigint,
  'a repeated import preserves one stable session ID'
);

select ok(
  (public.preview_legacy_import(
    '{
      "version": 1,
      "profile": {"name": "Moss"},
      "plan": {"weeklyTarget": 3, "days": ["Mon"], "activity": "Walking", "activityDetail": ""},
      "logs": [{
        "id": "legacy-stable-id",
        "date": "2026-08-30",
        "activity": "Walking",
        "duration": 20,
        "createdAt": "2026-08-30T08:00:00Z"
      }],
      "memories": [],
      "unlockedMoves": ["first-session"]
    }'::jsonb,
    repeat('b', 64)
  )#>'{sessions,duplicates}') ? 'legacy-stable-id',
  'an exact stable legacy session remains a duplicate across export digests'
);

select ok(
  (public.preview_legacy_import(
    '{
      "version": 1,
      "profile": {"name": "Moss"},
      "logs": [{
        "id": "legacy-stable-id",
        "date": "2026-08-30",
        "activity": "Running",
        "duration": 20,
        "createdAt": "2026-08-30T08:00:00Z"
      }]
    }'::jsonb,
    repeat('c', 64)
  )#>'{sessions,conflicts}') ? 'legacy-stable-id',
  'a changed activity is a stable-ID conflict instead of a dropped duplicate'
);

select ok(
  (public.preview_legacy_import(
    '{
      "version": 1,
      "profile": {"name": "Moss"},
      "logs": [{
        "id": "legacy-stable-id",
        "date": "2026-08-30",
        "activity": "Walking",
        "duration": 21,
        "createdAt": "2026-08-30T08:00:00Z"
      }]
    }'::jsonb,
    repeat('d', 64)
  )#>'{sessions,conflicts}') ? 'legacy-stable-id',
  'a changed duration is a stable-ID conflict instead of a dropped duplicate'
);

select ok(
  (public.preview_legacy_import(
    '{
      "version": 1,
      "profile": {"name": "Moss"},
      "logs": [{
        "id": "legacy-stable-id",
        "date": "2026-08-30",
        "activity": "Walking",
        "duration": 20,
        "feeling": "Steady",
        "createdAt": "2026-08-30T08:00:00Z"
      }]
    }'::jsonb,
    repeat('e', 64)
  )#>'{sessions,conflicts}') ? 'legacy-stable-id',
  'a changed feeling is a stable-ID conflict instead of a dropped duplicate'
);

set local role service_role;
update public.exercise_instances
set display_name = 'Changed after import'
where id = 'legacy-stable-id:legacy-activity';
set local role authenticated;

select ok(
  (public.preview_legacy_import(
    '{
      "version": 1,
      "profile": {"name": "Moss"},
      "logs": [{
        "id": "legacy-stable-id",
        "date": "2026-08-30",
        "activity": "Walking",
        "duration": 20,
        "createdAt": "2026-08-30T08:00:00Z"
      }]
    }'::jsonb,
    repeat('f', 64)
  )#>'{sessions,conflicts}') ? 'legacy-stable-id',
  'a changed derived exercise is a stable-ID conflict instead of a dropped duplicate'
);

select ok(
  position(
    'knufl-account-import:' in
    pg_get_functiondef('public.import_legacy_progress(jsonb,text)'::regprocedure)
  ) > 0
  and position(
    'pg_advisory_xact_lock' in
    pg_get_functiondef('public.import_legacy_progress(jsonb,text)'::regprocedure)
  ) < position(
    'import_preview := public.preview_legacy_import' in
    pg_get_functiondef('public.import_legacy_progress(jsonb,text)'::regprocedure)
  ),
  'legacy imports take the per-account transaction lock before their preview'
);

set local role service_role;
insert into public.rest_timers (
  id, user_id, session_id, status, started_at, ends_at
) values (
  'running-timer-one',
  '20000000-0000-0000-0000-000000000002',
  'account-b-session',
  'running',
  '2026-09-05T09:00:00Z',
  '2026-09-05T09:01:30Z'
);

select throws_ok(
  $$
    insert into public.rest_timers (
      id, user_id, session_id, status, started_at, ends_at
    ) values (
      'running-timer-two',
      '20000000-0000-0000-0000-000000000002',
      'account-b-session',
      'running',
      '2026-09-05T09:00:01Z',
      '2026-09-05T09:02:00Z'
    )
  $$,
  '23505',
  null,
  'one session cannot have two concurrently running rest timers'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"30000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);

insert into public.profiles (user_id, companion_name) values
  ('30000000-0000-0000-0000-000000000003', 'Pebble');
insert into public.preferences (user_id, timezone, measurement_system) values
  ('30000000-0000-0000-0000-000000000003', 'Europe/London', 'metric');
insert into public.workout_plans (
  id, user_id, name, status, weekly_target, schedule_days,
  default_activity_key, next_session_local_date
) values (
  'restore-plan',
  '30000000-0000-0000-0000-000000000003',
  'Two steady days',
  'active',
  2,
  array['Tue', 'Thu'],
  'strength',
  '2026-09-08'
);
insert into public.plan_exercises (
  id, user_id, plan_id, position, exercise_key, display_name,
  target_sets, target_reps, target_load, load_unit, load_mode, rest_seconds
) values (
  'restore-plan-squat',
  '30000000-0000-0000-0000-000000000003',
  'restore-plan',
  0,
  'goblet-squat',
  'Goblet squat',
  3,
  8,
  16,
  'kg',
  'total',
  60
);
insert into public.workout_occurrences (
  id, user_id, plan_id, scheduled_local_date, timezone, status, completed_session_id
) values (
  'restore-occurrence',
  '30000000-0000-0000-0000-000000000003',
  'restore-plan',
  '2026-09-05',
  'Europe/London',
  'completed',
  'restore-session'
);
insert into public.workout_sessions (
  id, user_id, occurrence_id, source, status, local_date, timezone,
  started_at, completed_at, duration_seconds, feeling, notes
) values (
  'restore-session',
  '30000000-0000-0000-0000-000000000003',
  'restore-occurrence',
  'planned',
  'completed',
  '2026-09-05',
  'Europe/London',
  '2026-09-05T10:00:00Z',
  '2026-09-05T10:30:00Z',
  1800,
  'steady',
  'Saved before moving devices'
);
insert into public.exercise_instances (
  id, user_id, session_id, plan_exercise_id, position, exercise_key,
  display_name, planned_sets, planned_reps, planned_load,
  planned_load_unit, planned_load_mode, rest_seconds
) values (
  'restore-exercise',
  '30000000-0000-0000-0000-000000000003',
  'restore-session',
  'restore-plan-squat',
  0,
  'goblet-squat',
  'Goblet squat',
  3,
  8,
  16,
  'kg',
  'total',
  60
);

set local role authenticated;
with restore_claim as materialized (
  select * from public.claim_operation_receipt(
    'restore-record-set',
    'record_set',
    '60000000-0000-4000-8000-000000000006',
    '2026-09-05T10:10:00Z',
    90
  )
)
select set_config(
  'knufl.restore_operation_token',
  (select claim_token::text from restore_claim),
  true
);

select set_config(
  'knufl.restore_operation_finished',
  (select finalized::text from public.finish_operation_receipt(
    '60000000-0000-4000-8000-000000000006',
    current_setting('knufl.restore_operation_token')::uuid,
    true,
    'completed_set',
    'restore-set',
    '{"saved":{"user_id":"30000000-0000-0000-0000-000000000003"}}'::jsonb,
    null,
    '2026-09-05T10:10:00Z'
  )),
  true
);

set local role service_role;
insert into public.completed_sets (
  id, user_id, session_id, exercise_instance_id, set_order, reps,
  load, load_unit, load_mode, effort, completed_at, last_operation_id
) values (
  'restore-set',
  '30000000-0000-0000-0000-000000000003',
  'restore-session',
  'restore-exercise',
  1,
  8,
  16,
  'kg',
  'total',
  7,
  '2026-09-05T10:10:00Z',
  '60000000-0000-4000-8000-000000000006'
);
insert into public.cardio_records (
  id, user_id, session_id, activity_key, display_name, distance,
  distance_unit, duration_seconds, completed_at, local_date, timezone, feeling
) values (
  'restore-cardio',
  '30000000-0000-0000-0000-000000000003',
  'restore-session',
  'walk',
  'Walking',
  2,
  'km',
  1200,
  '2026-09-05T10:30:00Z',
  '2026-09-05',
  'Europe/London',
  'steady'
);
insert into public.rest_timers (
  id, user_id, session_id, exercise_instance_id, status,
  started_at, ends_at, stopped_at
) values (
  'restore-timer',
  '30000000-0000-0000-0000-000000000003',
  'restore-session',
  'restore-exercise',
  'finished',
  '2026-09-05T10:10:00Z',
  '2026-09-05T10:11:00Z',
  '2026-09-05T10:11:00Z'
);
insert into public.memories (
  id, user_id, associated_session_id, title, note
) values (
  'restore-memory',
  '30000000-0000-0000-0000-000000000003',
  'restore-session',
  'First cloud session',
  'One wonderfully wobbly beginning.'
);

set local role authenticated;
select set_config(
  'knufl.restore_payload',
  public.export_account_data()::text,
  true
);

select ok(
  position('user_id' in current_setting('knufl.restore_payload')) = 0
    and position('claim_token' in current_setting('knufl.restore_payload')) = 0
    and position('lease_expires_at' in current_setting('knufl.restore_payload')) = 0,
  'cloud exports recursively remove ownership and active lease credentials'
);

reset role;
delete from auth.users where id = '30000000-0000-0000-0000-000000000003';
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000',
  '30000000-0000-0000-0000-000000000003',
  'authenticated', 'authenticated', 'knufl-restore@example.test', '',
  now(), '{}'::jsonb, '{}'::jsonb, now(), now()
);
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"30000000-0000-0000-0000-000000000003","role":"authenticated"}',
  true
);

insert into public.profiles (user_id, companion_name) values
  ('30000000-0000-0000-0000-000000000003', 'Bootstrap Knufl');
insert into public.preferences (user_id, timezone, measurement_system) values
  ('30000000-0000-0000-0000-000000000003', 'UTC', 'metric');

select is(
  public.preview_account_restore(
    current_setting('knufl.restore_payload')::jsonb,
    repeat('c', 64)
  )->>'action',
  'importable',
  'a format-2 archive can replace profile/preferences-only bootstrap state'
);

set local role service_role;
insert into public.workout_plans (id, user_id, name, status) values (
  'bootstrap-plan',
  '30000000-0000-0000-0000-000000000003',
  'Do not overwrite',
  'draft'
);
set local role authenticated;
select is(
  public.preview_account_restore(
    current_setting('knufl.restore_payload')::jsonb,
    repeat('c', 64)
  )->>'action',
  'conflict',
  'an existing workout keeps a bootstrap account conflict-protected'
);
set local role service_role;
delete from public.workout_plans where id = 'bootstrap-plan';
insert into public.memories (id, user_id, title, note) values (
  'bootstrap-memory',
  '30000000-0000-0000-0000-000000000003',
  'Do not overwrite',
  'This account has saved memory data.'
);
set local role authenticated;
select is(
  public.preview_account_restore(
    current_setting('knufl.restore_payload')::jsonb,
    repeat('c', 64)
  )->>'action',
  'conflict',
  'an existing memory keeps a bootstrap account conflict-protected'
);
reset role;
delete from public.memories where id = 'bootstrap-memory';
insert into public.milestone_unlocks (user_id, milestone_id) values (
  '30000000-0000-0000-0000-000000000003',
  'bootstrap-milestone'
);
set local role authenticated;
select is(
  public.preview_account_restore(
    current_setting('knufl.restore_payload')::jsonb,
    repeat('c', 64)
  )->>'action',
  'conflict',
  'an earned milestone keeps a bootstrap account conflict-protected'
);
reset role;
delete from public.milestone_unlocks where milestone_id = 'bootstrap-milestone';
set local role authenticated;

select is(
  public.restore_account_data(
    current_setting('knufl.restore_payload')::jsonb,
    repeat('c', 64)
  )->>'status',
  'completed',
  'a format-2 account export restores in dependency order'
);

select is(
  public.export_account_data() - 'exportedAt',
  current_setting('knufl.restore_payload')::jsonb - 'exportedAt',
  'the restored account exports to the same canonical data snapshot'
);

select is(
  public.restore_account_data(
    current_setting('knufl.restore_payload')::jsonb,
    repeat('c', 64)
  )->>'status',
  'already-restored',
  'repeating a format-2 restore is idempotent'
);

update public.profiles
set companion_name = 'Changed after restore'
where user_id = '30000000-0000-0000-0000-000000000003';

select is(
  public.preview_account_restore(
    current_setting('knufl.restore_payload')::jsonb,
    repeat('c', 64)
  )->>'action',
  'conflict',
  'a previously used digest is not called duplicate after account data diverges'
);

select is(
  public.restore_account_data(
    current_setting('knufl.restore_payload')::jsonb,
    repeat('c', 64)
  )->>'status',
  'conflict',
  'a repeated archive never reports recovery success without matching current data'
);

select ok(
  (select count(*) = 1 from public.workout_plans where id = 'restore-plan')
    and (select count(*) = 1 from public.workout_sessions where id = 'restore-session')
    and (select count(*) = 1 from public.completed_sets where id = 'restore-set')
    and (select count(*) = 1 from public.cardio_records where id = 'restore-cardio')
    and (select count(*) = 1 from public.rest_timers where id = 'restore-timer')
    and (select count(*) = 1 from public.memories where id = 'restore-memory')
    and (select count(*) = 1 from public.exercise_day_credits where local_date = '2026-09-05')
    and (select count(*) = 1 from public.milestone_unlocks where milestone_id = 'first-session'),
  'restore preserves plans, actuals, timers, memories and immutable rewards'
);

select set_config(
  'request.jwt.claims',
  '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}',
  true
);

select ok(
  not has_table_privilege('authenticated', 'public.voice_usage_sessions', 'SELECT'),
  'browser clients cannot read the voice usage ledger or provider call IDs'
);

select ok(
  not has_function_privilege('authenticated', 'public.claim_voice_session(uuid,integer,integer,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.close_voice_session(uuid,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.attach_voice_call(uuid,text)', 'EXECUTE'),
  'browser clients cannot invoke legacy auth-derived voice ledger RPCs'
);

select ok(
  not has_function_privilege('authenticated', 'public.claim_voice_session_for_user(uuid,uuid,integer,integer,integer)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.close_voice_session_for_user(uuid,uuid,text)', 'EXECUTE')
    and not has_function_privilege('authenticated', 'public.attach_voice_call_for_user(uuid,uuid,text)', 'EXECUTE'),
  'browser clients cannot invoke explicit-owner voice ledger RPCs'
);

select ok(
  has_function_privilege('service_role', 'public.claim_voice_session_for_user(uuid,uuid,integer,integer,integer)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.close_voice_session_for_user(uuid,uuid,text)', 'EXECUTE')
    and has_function_privilege('service_role', 'public.attach_voice_call_for_user(uuid,uuid,text)', 'EXECUTE'),
  'the Worker service role can invoke the bounded voice ledger RPCs'
);

set local role service_role;

select throws_ok(
  $$
    select * from public.claim_voice_session_for_user(
      '20000000-0000-0000-0000-000000000002',
      '30000000-0000-4000-8000-000000000003', null, 1, 1
    )
  $$,
  '22023',
  null,
  'the Worker cannot accidentally disable a voice budget with a null limit'
);

select ok(
  (select allowed from public.claim_voice_session_for_user(
    '20000000-0000-0000-0000-000000000002',
    '30000000-0000-4000-8000-000000000003', 1, 1, 1
  )),
  'the Worker can claim a bounded voice session for the validated account'
);

select is(
  (select reason from public.claim_voice_session_for_user(
    '20000000-0000-0000-0000-000000000002',
    '30000000-0000-4000-8000-000000000003', 1, 1, 1
  )),
  'already_claimed',
  'a repeated claim cannot issue another provider call under the same budget slot'
);

select is(
  (select reason from public.claim_voice_session_for_user(
    '20000000-0000-0000-0000-000000000002',
    '40000000-0000-4000-8000-000000000004', 1, 1, 1
  )),
  'concurrent_limit',
  'the server rejects a second concurrent voice session'
);

select ok(
  (select closed from public.close_voice_session_for_user(
    '20000000-0000-0000-0000-000000000002',
    '30000000-0000-4000-8000-000000000003', null
  )),
  'closing a voice session records its actual elapsed usage'
);

select ok(
  (select allowed from public.claim_voice_session_for_user(
    '20000000-0000-0000-0000-000000000002',
    '40000000-0000-4000-8000-000000000004', 1, 1, 1
  )),
  'closing the prior call releases the concurrent-session slot'
);

select * from finish(true);
rollback;
