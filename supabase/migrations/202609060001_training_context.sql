-- Stored with existing owner-scoped preferences: exported/restored by the
-- existing row-based account archive. Older imports leave it null safely.
begin;
alter table public.preferences add column training_context jsonb
  check (training_context is null or (jsonb_typeof(training_context)='object' and octet_length(training_context::text)<=20000));
comment on column public.preferences.training_context is
  'Recoverable workout draft and explicit exercise cursor. Never completed-set facts; resolve every referenced ID within the verified owner/workout.';
-- Normalize pre-context version-2 archives as well as newer archives. Keep the
-- existing private-field stripping and exact, conflict-aware restore checks.
create or replace function public.knufl_restore_snapshot(p_payload jsonb)
returns jsonb language sql immutable strict security invoker
set search_path=pg_catalog,public,pg_temp as $$
  select jsonb_build_object(
    'profile',case when p_payload->'profile'='null'::jsonb then 'null'::jsonb else public.knufl_strip_private_json(p_payload->'profile')-'gender'-'pronouns' end,
    'preferences',case when p_payload->'preferences'='null'::jsonb then 'null'::jsonb else jsonb_build_object('training_context',null) || (public.knufl_strip_private_json(p_payload->'preferences')-'gender'-'pronouns') end,
    'plans',public.knufl_strip_private_json(p_payload->'plans'),
    'planExercises',public.knufl_strip_private_json(p_payload->'planExercises'),
    'occurrences',public.knufl_strip_private_json(p_payload->'occurrences'),
    'sessions',public.knufl_strip_private_json(p_payload->'sessions'),
    'exercises',public.knufl_strip_private_json(p_payload->'exercises'),
    'completedSets',public.knufl_strip_private_json(p_payload->'completedSets'),
    'setRevisions',public.knufl_strip_private_json(p_payload->'setRevisions'),
    'cardioRecords',public.knufl_strip_private_json(p_payload->'cardioRecords'),
    'restTimers',public.knufl_strip_private_json(p_payload->'restTimers'),
    'memories',public.knufl_strip_private_json(p_payload->'memories'),
    'milestones',public.knufl_strip_private_json(p_payload->'milestones'),
    'exerciseDayCredits',public.knufl_strip_private_json(p_payload->'exerciseDayCredits'),
    'operations',public.knufl_strip_private_json(p_payload->'operations')
  );
$$;
create function public.put_training_state_for_user(p_user_id uuid,p_patch jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare merged jsonb; workout_id text; exercise_id text;
begin
  if p_patch is null or jsonb_typeof(p_patch)<>'object' or p_patch - array['draft','sessionId','exerciseId','superset'] <> '{}'::jsonb
    then raise exception 'Invalid training context'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':training-context',0));
  select coalesce(training_context,'{}'::jsonb) || p_patch into merged from public.preferences where user_id=p_user_id;
  merged:=coalesce(merged,p_patch);
  workout_id:=merged->>'sessionId';
  exercise_id:=merged->>'exerciseId';
  if workout_id is not null and not exists(select 1 from public.workout_sessions where id=workout_id and user_id=p_user_id)
    then raise exception 'Workout not owned'; end if;
  if exercise_id is not null and not exists(select 1 from public.exercise_instances where id=exercise_id and session_id=workout_id and user_id=p_user_id)
    then raise exception 'Exercise not owned'; end if;
  insert into public.preferences(user_id,training_context) values(p_user_id,merged)
    on conflict(user_id) do update set training_context=excluded.training_context;
  return merged;
end;
$$;
revoke all on function public.put_training_state_for_user(uuid,jsonb) from public,anon,authenticated;
grant execute on function public.put_training_state_for_user(uuid,jsonb) to service_role;
-- Cursor advancement and the completed set commit atomically, including retries.
-- Supersets deliberately require selecting the next exercise, never guessing it.
create function knufl_private.advance_training_cursor() returns trigger
language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
begin
  if new.deleted_at is null then
    update public.preferences set training_context=coalesce(training_context,'{}'::jsonb) ||
      jsonb_build_object('sessionId',new.session_id,'exerciseId',
        case when training_context->>'sessionId'=new.session_id and training_context->>'superset'='true'
          then null else new.exercise_instance_id end)
      where user_id=new.user_id and training_context->>'sessionId'=new.session_id
        and exists(select 1 from public.workout_sessions where id=new.session_id and user_id=new.user_id and status='active')
        and not exists(select 1 from public.import_batches where user_id=new.user_id and status='importing');
  end if;
  return new;
end;
$$;
revoke all on function knufl_private.advance_training_cursor() from public,anon,authenticated;
create trigger completed_sets_advance_cursor after insert on public.completed_sets
for each row execute function knufl_private.advance_training_cursor();
commit;
