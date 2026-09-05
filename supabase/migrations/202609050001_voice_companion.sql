-- Knufl voice companion cloud model
-- Entity IDs are text so legacy browser IDs can be preserved byte-for-byte.
-- Browser-facing ownership always comes from auth.uid(). Only service-role voice
-- ledger RPCs accept a user ID after the Worker has validated the bearer token.

begin;

create extension if not exists pgcrypto;

create or replace function public.knufl_bump_version()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  new.version := old.version + 1;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  companion_name text not null default 'Knufl' check (char_length(btrim(companion_name)) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0)
);

comment on table public.profiles is
  'Minimal user profile. Companion identity intentionally has no gender or pronoun fields.';

create table public.preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  timezone text not null default 'UTC' check (char_length(btrim(timezone)) between 1 and 100),
  measurement_system text not null default 'metric' check (measurement_system in ('metric', 'imperial')),
  reduced_motion boolean not null default false,
  voice_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0)
);

create table public.workout_plans (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  status text not null default 'draft' check (status in ('draft', 'active', 'archived')),
  weekly_target smallint check (weekly_target between 1 and 14),
  schedule_days text[] not null default '{}'::text[] check (
    cardinality(schedule_days) <= 7
    and schedule_days <@ array['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']::text[]
  ),
  default_activity_key text check (default_activity_key is null or char_length(btrim(default_activity_key)) between 1 and 160),
  activity_detail text check (activity_detail is null or char_length(activity_detail) <= 500),
  next_session_local_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (id, user_id)
);

create table public.plan_exercises (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id text not null,
  position smallint not null check (position >= 0),
  exercise_key text not null check (char_length(btrim(exercise_key)) between 1 and 160),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 160),
  target_sets smallint check (target_sets between 1 and 100),
  target_reps smallint check (target_reps between 1 and 10000),
  target_load numeric(10,3) check (target_load >= 0),
  load_unit text check (load_unit in ('kg', 'lb')),
  load_mode text check (load_mode in ('total', 'per-dumbbell', 'bodyweight', 'assisted')),
  rest_seconds integer check (rest_seconds between 0 and 86400),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (id, user_id),
  unique (plan_id, position),
  foreign key (plan_id, user_id) references public.workout_plans(id, user_id) on delete cascade
);

create table public.workout_occurrences (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users(id) on delete cascade,
  plan_id text,
  scheduled_local_date date not null,
  timezone text not null check (char_length(btrim(timezone)) between 1 and 100),
  status text not null default 'scheduled' check (status in ('scheduled', 'completed', 'cancelled', 'skipped')),
  completed_session_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (id, user_id),
  foreign key (plan_id, user_id) references public.workout_plans(id, user_id) on delete set null (plan_id)
);

create table public.workout_sessions (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users(id) on delete cascade,
  occurrence_id text,
  source text not null check (source in ('planned', 'manual', 'legacy')),
  status text not null default 'active' check (status in ('active', 'completed', 'abandoned')),
  local_date date not null,
  timezone text not null check (char_length(btrim(timezone)) between 1 and 100),
  started_at timestamptz not null,
  completed_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds >= 0),
  feeling text check (feeling is null or char_length(feeling) <= 500),
  notes text check (notes is null or char_length(notes) <= 4000),
  legacy_source_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (id, user_id),
  unique (user_id, legacy_source_id),
  foreign key (occurrence_id, user_id) references public.workout_occurrences(id, user_id)
    on delete set null (occurrence_id) deferrable initially deferred,
  check ((status = 'completed') = (completed_at is not null))
);

comment on column public.workout_sessions.local_date is
  'Calendar date at session start in the captured timezone; frozen after creation, including during travel.';
comment on column public.workout_sessions.timezone is
  'IANA timezone captured at session start. Legacy exports without a timezone use the explicit Legacy/Unknown marker.';

alter table public.workout_occurrences
  add constraint workout_occurrences_completed_session_owner_fk
  foreign key (completed_session_id, user_id)
  references public.workout_sessions(id, user_id)
  on delete set null (completed_session_id)
  deferrable initially deferred;

create table public.exercise_instances (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id text not null,
  plan_exercise_id text,
  position smallint not null check (position >= 0),
  exercise_key text not null check (char_length(btrim(exercise_key)) between 1 and 160),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 160),
  planned_sets smallint check (planned_sets between 1 and 100),
  planned_reps smallint check (planned_reps between 1 and 10000),
  planned_load numeric(10,3) check (planned_load >= 0),
  planned_load_unit text check (planned_load_unit in ('kg', 'lb')),
  planned_load_mode text check (planned_load_mode in ('total', 'per-dumbbell', 'bodyweight', 'assisted')),
  rest_seconds integer check (rest_seconds between 0 and 86400),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (id, user_id),
  unique (id, session_id, user_id),
  unique (session_id, position),
  foreign key (session_id, user_id) references public.workout_sessions(id, user_id) on delete cascade,
  foreign key (plan_exercise_id, user_id) references public.plan_exercises(id, user_id) on delete set null (plan_exercise_id)
);

create table public.operation_receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  operation_key text not null check (char_length(btrim(operation_key)) between 1 and 200),
  operation_type text not null check (char_length(btrim(operation_type)) between 1 and 80),
  entity_type text check (entity_type is null or char_length(btrim(entity_type)) between 1 and 80),
  entity_id text,
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  result jsonb,
  error_code text,
  client_created_at timestamptz,
  claim_token uuid,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, operation_key),
  unique (id, user_id),
  check ((claim_token is null) = (lease_expires_at is null)),
  check ((status = 'pending') = (completed_at is null)),
  check (status = 'pending' or (claim_token is null and lease_expires_at is null))
);

create table public.completed_sets (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id text not null,
  exercise_instance_id text not null,
  set_order smallint not null check (set_order between 1 and 1000),
  reps integer not null check (reps between 1 and 100000),
  load numeric(10,3) check (load >= 0),
  load_unit text check (load_unit in ('kg', 'lb')),
  load_mode text check (load_mode in ('total', 'per-dumbbell', 'bodyweight', 'assisted')),
  effort numeric(4,2) check (effort between 0 and 10),
  feeling text check (feeling is null or char_length(feeling) <= 500),
  completed_at timestamptz not null,
  corrected_at timestamptz,
  deleted_at timestamptz,
  last_operation_id uuid,
  sync_state text not null default 'synced' check (sync_state in ('pending', 'synced', 'conflict')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (id, user_id),
  foreign key (session_id, user_id) references public.workout_sessions(id, user_id) on delete cascade,
  foreign key (exercise_instance_id, session_id, user_id)
    references public.exercise_instances(id, session_id, user_id) on delete cascade,
  foreign key (last_operation_id, user_id) references public.operation_receipts(id, user_id) on delete set null (last_operation_id),
  check (load is null or load_mode = 'bodyweight' or load_unit is not null)
);

create table public.set_revisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  set_id text not null,
  revision integer not null check (revision > 0),
  change_kind text not null check (change_kind in ('record', 'correct', 'delete', 'restore')),
  before_value jsonb,
  after_value jsonb,
  operation_id uuid,
  created_at timestamptz not null default now(),
  unique (set_id, revision),
  foreign key (set_id, user_id) references public.completed_sets(id, user_id) on delete cascade,
  foreign key (operation_id, user_id) references public.operation_receipts(id, user_id) on delete set null (operation_id)
);

create table public.cardio_records (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id text not null,
  activity_key text not null check (char_length(btrim(activity_key)) between 1 and 160),
  display_name text not null check (char_length(btrim(display_name)) between 1 and 160),
  distance numeric(12,3) not null check (distance > 0),
  distance_unit text not null check (distance_unit in ('m', 'km', 'mi')),
  duration_seconds integer not null check (duration_seconds > 0),
  completed_at timestamptz not null,
  local_date date not null,
  timezone text not null check (char_length(btrim(timezone)) between 1 and 100),
  feeling text check (feeling is null or char_length(feeling) <= 500),
  deleted_at timestamptz,
  last_operation_id uuid,
  sync_state text not null default 'synced' check (sync_state in ('pending', 'synced', 'conflict')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (id, user_id),
  foreign key (session_id, user_id) references public.workout_sessions(id, user_id) on delete cascade,
  foreign key (last_operation_id, user_id) references public.operation_receipts(id, user_id) on delete set null (last_operation_id)
);

create table public.rest_timers (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id text not null,
  exercise_instance_id text,
  status text not null default 'running' check (status in ('running', 'finished', 'cancelled')),
  started_at timestamptz not null,
  ends_at timestamptz not null,
  stopped_at timestamptz,
  last_operation_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (id, user_id),
  foreign key (session_id, user_id) references public.workout_sessions(id, user_id) on delete cascade,
  foreign key (exercise_instance_id, session_id, user_id)
    references public.exercise_instances(id, session_id, user_id) on delete set null (exercise_instance_id),
  foreign key (last_operation_id, user_id) references public.operation_receipts(id, user_id) on delete set null (last_operation_id),
  check (ends_at >= started_at),
  check ((status = 'running' and stopped_at is null) or (status <> 'running' and stopped_at is not null))
);

create table public.memories (
  id text primary key default gen_random_uuid()::text,
  user_id uuid not null references auth.users(id) on delete cascade,
  associated_session_id text,
  title text not null check (char_length(btrim(title)) between 1 and 160),
  note text not null check (char_length(btrim(note)) between 1 and 2000),
  editable boolean not null default true,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 1 check (version > 0),
  unique (id, user_id),
  foreign key (associated_session_id, user_id) references public.workout_sessions(id, user_id) on delete set null (associated_session_id)
);

-- Credits and milestone unlocks are append-only to the signed-in application.
-- A completed session trigger awards them; deleting/editing/rest never retracts them.
create table public.exercise_day_credits (
  user_id uuid not null references auth.users(id) on delete cascade,
  local_date date not null,
  timezone text not null check (char_length(btrim(timezone)) between 1 and 100),
  first_session_id text,
  earned_at timestamptz not null default now(),
  primary key (user_id, local_date),
  foreign key (first_session_id, user_id) references public.workout_sessions(id, user_id) on delete set null (first_session_id)
);

comment on table public.exercise_day_credits is
  'Append-only earned credits, unique per account and frozen session-local date; no weekly cap or inactivity reduction.';

create table public.milestone_unlocks (
  user_id uuid not null references auth.users(id) on delete cascade,
  milestone_id text not null check (char_length(btrim(milestone_id)) between 1 and 100),
  associated_session_id text,
  unlocked_at timestamptz not null default now(),
  primary key (user_id, milestone_id),
  foreign key (associated_session_id, user_id) references public.workout_sessions(id, user_id) on delete set null (associated_session_id)
);

comment on table public.milestone_unlocks is
  'Append-only earned milestones. Normal authenticated clients have no update/delete privilege.';

create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  source_version integer not null check (source_version > 0),
  source_digest text not null check (source_digest ~ '^[a-f0-9]{64}$'),
  status text not null default 'previewed' check (status in ('previewed', 'importing', 'completed', 'conflict', 'failed')),
  preview jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, source_digest),
  unique (id, user_id)
);

create table public.import_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  batch_id uuid not null,
  source_kind text not null check (source_kind in ('profile', 'plan', 'session', 'memory', 'milestone')),
  source_id text not null,
  target_id text,
  source_digest text not null check (source_digest ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('imported', 'duplicate', 'conflict', 'skipped')),
  created_at timestamptz not null default now(),
  unique (user_id, source_kind, source_id),
  foreign key (batch_id, user_id) references public.import_batches(id, user_id) on delete cascade
);

create table public.sync_conflicts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entity_type text not null check (char_length(btrim(entity_type)) between 1 and 80),
  entity_id text not null,
  expected_version integer not null check (expected_version >= 0),
  actual_version integer not null check (actual_version > 0),
  client_payload jsonb not null,
  status text not null default 'open' check (status in ('open', 'resolved', 'discarded')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  check ((status = 'open' and resolved_at is null) or (status <> 'open' and resolved_at is not null))
);

-- Server-enforced Realtime budget ledger. This stores usage metadata only, never audio or transcripts.
create table public.voice_usage_sessions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'closed', 'expired')),
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  expires_at timestamptz not null,
  openai_call_id text,
  created_at timestamptz not null default now(),
  unique (id, user_id),
  check (expires_at > started_at),
  check ((status = 'active' and ended_at is null) or (status <> 'active' and ended_at is not null))
);

create index workout_plans_user_idx on public.workout_plans(user_id, updated_at desc);
create index plan_exercises_owner_parent_idx on public.plan_exercises(user_id, plan_id, position);
create index workout_occurrences_owner_date_idx on public.workout_occurrences(user_id, scheduled_local_date);
create index workout_sessions_owner_date_idx on public.workout_sessions(user_id, local_date desc, started_at desc);
create unique index workout_sessions_one_active_per_user_idx
  on public.workout_sessions(user_id)
  where status = 'active';
create index exercise_instances_owner_parent_idx on public.exercise_instances(user_id, session_id, position);
create index completed_sets_owner_exercise_idx on public.completed_sets(user_id, exercise_instance_id, completed_at);
create index completed_sets_owner_session_idx on public.completed_sets(user_id, session_id, set_order);
create index cardio_records_owner_activity_idx on public.cardio_records(user_id, activity_key, completed_at);
create index rest_timers_owner_session_idx on public.rest_timers(user_id, session_id, started_at desc);
create unique index rest_timers_one_running_per_session_idx
  on public.rest_timers(user_id, session_id)
  where status = 'running';
create index memories_owner_created_idx on public.memories(user_id, created_at desc);
create index operation_receipts_owner_created_idx on public.operation_receipts(user_id, created_at desc);
create index voice_usage_sessions_owner_started_idx on public.voice_usage_sessions(user_id, started_at desc);

do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'profiles', 'preferences', 'workout_plans', 'plan_exercises',
    'workout_occurrences', 'workout_sessions', 'exercise_instances',
    'completed_sets', 'cardio_records', 'rest_timers', 'memories'
  ] loop
    execute format('create trigger %I before update on public.%I for each row execute function public.knufl_bump_version()', relation_name || '_bump_version', relation_name);
  end loop;
end;
$$;

create or replace function public.knufl_freeze_session_calendar_context()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.local_date is distinct from old.local_date
    or new.timezone is distinct from old.timezone
    or new.started_at is distinct from old.started_at then
    raise exception 'A session local date, timezone and start time are frozen when it starts'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger workout_sessions_freeze_calendar_context
before update on public.workout_sessions
for each row execute function public.knufl_freeze_session_calendar_context();

create or replace function public.knufl_validate_cardio_session_context()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  parent_date date;
  parent_timezone text;
begin
  select s.local_date, s.timezone into parent_date, parent_timezone
  from public.workout_sessions s
  where s.id = new.session_id and s.user_id = new.user_id;

  if not found
    or new.local_date is distinct from parent_date
    or new.timezone is distinct from parent_timezone then
    raise exception 'Cardio date and timezone must match its workout session'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger cardio_records_validate_session_context
before insert or update of session_id, local_date, timezone on public.cardio_records
for each row execute function public.knufl_validate_cardio_session_context();

create or replace function public.knufl_capture_set_revision()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  revision_kind text;
begin
  if tg_op = 'INSERT' then
    revision_kind := 'record';
  elsif old.deleted_at is null and new.deleted_at is not null then
    revision_kind := 'delete';
  elsif old.deleted_at is not null and new.deleted_at is null then
    revision_kind := 'restore';
  else
    revision_kind := 'correct';
  end if;

  insert into public.set_revisions (
    user_id, set_id, revision, change_kind, before_value, after_value, operation_id
  ) values (
    new.user_id,
    new.id,
    new.version,
    revision_kind,
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    to_jsonb(new),
    new.last_operation_id
  );
  return new;
end;
$$;

create trigger completed_sets_capture_revision
after insert or update on public.completed_sets
for each row execute function public.knufl_capture_set_revision();

create or replace function public.knufl_award_completed_session()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  credit_count integer;
begin
  if new.status <> 'completed' or (tg_op = 'UPDATE' and old.status = 'completed') then
    return new;
  end if;

  -- Keep a linked scheduled occurrence truthful in the same transaction as the
  -- session completion. The conditional avoids version churn during exact restores.
  if new.occurrence_id is not null then
    update public.workout_occurrences occurrence
    set status = 'completed', completed_session_id = new.id
    where occurrence.id = new.occurrence_id
      and occurrence.user_id = new.user_id
      and (occurrence.status, occurrence.completed_session_id)
        is distinct from ('completed'::text, new.id);
  end if;

  insert into public.exercise_day_credits (
    user_id, local_date, timezone, first_session_id, earned_at
  ) values (
    new.user_id, new.local_date, new.timezone, new.id, coalesce(new.completed_at, now())
  ) on conflict (user_id, local_date) do nothing;

  insert into public.milestone_unlocks (
    user_id, milestone_id, associated_session_id, unlocked_at
  ) values (
    new.user_id, 'first-session', new.id, coalesce(new.completed_at, now())
  ) on conflict (user_id, milestone_id) do nothing;

  select count(*) into credit_count
  from public.exercise_day_credits
  where user_id = new.user_id;

  if credit_count >= 3 then
    insert into public.milestone_unlocks (
      user_id, milestone_id, associated_session_id, unlocked_at
    ) values (
      new.user_id, 'little-mountain', new.id, coalesce(new.completed_at, now())
    ) on conflict (user_id, milestone_id) do nothing;
  end if;

  return new;
end;
$$;

create trigger workout_sessions_award_completion
after insert or update of status on public.workout_sessions
for each row execute function public.knufl_award_completed_session();

-- Operation identity is immutable. Mutating it would let one idempotency key be
-- repurposed for a different tool after a result had already been committed.
create or replace function public.knufl_freeze_operation_identity()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.id is distinct from old.id
    or new.user_id is distinct from old.user_id
    or new.operation_key is distinct from old.operation_key
    or new.operation_type is distinct from old.operation_type then
    raise exception 'An operation receipt identity cannot be changed'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger operation_receipts_freeze_identity
before update on public.operation_receipts
for each row execute function public.knufl_freeze_operation_identity();

-- Claims serialize by account and idempotency key. A short lease lets a retry
-- recover after a Worker crash, while the opaque token prevents the previous
-- executor from finalizing after a newer executor has reclaimed the operation.
create or replace function public.claim_operation_receipt(
  p_operation_key text,
  p_operation_type text,
  p_receipt_id uuid,
  p_client_created_at timestamptz default null,
  p_lease_seconds integer default 90
)
returns table (
  claimed boolean,
  reason text,
  receipt_id uuid,
  operation_type text,
  status text,
  claim_token uuid,
  lease_expires_at timestamptz,
  result jsonb,
  entity_type text,
  entity_id text,
  error_code text
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  normalized_key text := btrim(p_operation_key);
  normalized_type text := btrim(p_operation_type);
  receipt_row public.operation_receipts%rowtype;
  new_claim_token uuid;
  new_lease_expires_at timestamptz;
begin
  if owner_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if normalized_key is null or char_length(normalized_key) not between 1 and 200 then
    raise exception 'A valid operation key is required' using errcode = '22023';
  end if;
  if normalized_type is null or char_length(normalized_type) not between 1 and 80 then
    raise exception 'A valid operation type is required' using errcode = '22023';
  end if;
  if p_receipt_id is null then
    raise exception 'A receipt ID is required' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 5 and 300 then
    raise exception 'lease_seconds must be between 5 and 300' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(owner_id::text || E'\\x1f' || normalized_key, 0)
  );

  select receipt.* into receipt_row
  from public.operation_receipts receipt
  where receipt.user_id = owner_id
    and receipt.operation_key = normalized_key;

  if found then
    -- Check the tool type before any succeeded fast path. An idempotency key is
    -- permanently scoped to exactly one operation type.
    if receipt_row.operation_type <> normalized_type then
      return query select
        false, 'type_conflict'::text, receipt_row.id, receipt_row.operation_type,
        receipt_row.status, null::uuid, null::timestamptz, null::jsonb,
        receipt_row.entity_type, receipt_row.entity_id, receipt_row.error_code;
      return;
    end if;

    if receipt_row.status = 'succeeded' then
      return query select
        false, 'succeeded'::text, receipt_row.id, receipt_row.operation_type,
        receipt_row.status, null::uuid, null::timestamptz, receipt_row.result,
        receipt_row.entity_type, receipt_row.entity_id, receipt_row.error_code;
      return;
    end if;

    if receipt_row.status = 'pending'
      and receipt_row.claim_token is not null
      and receipt_row.lease_expires_at > clock_timestamp() then
      return query select
        false, 'in_progress'::text, receipt_row.id, receipt_row.operation_type,
        receipt_row.status, null::uuid, receipt_row.lease_expires_at, null::jsonb,
        receipt_row.entity_type, receipt_row.entity_id, receipt_row.error_code;
      return;
    end if;

    new_claim_token := gen_random_uuid();
    new_lease_expires_at := clock_timestamp() + make_interval(secs => p_lease_seconds);
    update public.operation_receipts receipt
    set status = 'pending',
        result = null,
        entity_type = null,
        entity_id = null,
        error_code = null,
        completed_at = null,
        claim_token = new_claim_token,
        lease_expires_at = new_lease_expires_at,
        attempt_count = receipt.attempt_count + 1,
        client_created_at = coalesce(receipt.client_created_at, p_client_created_at)
    where receipt.id = receipt_row.id
      and receipt.user_id = owner_id
    returning receipt.* into receipt_row;
  else
    -- IDs are globally unique even though idempotency keys are account-scoped.
    if exists (select 1 from public.operation_receipts receipt where receipt.id = p_receipt_id) then
      return query select
        false, 'receipt_id_unavailable'::text, p_receipt_id, normalized_type,
        'failed'::text, null::uuid, null::timestamptz, null::jsonb,
        null::text, null::text, null::text;
      return;
    end if;

    new_claim_token := gen_random_uuid();
    new_lease_expires_at := clock_timestamp() + make_interval(secs => p_lease_seconds);
    insert into public.operation_receipts (
      id, user_id, operation_key, operation_type, status, client_created_at,
      claim_token, lease_expires_at, attempt_count
    ) values (
      p_receipt_id, owner_id, normalized_key, normalized_type, 'pending',
      p_client_created_at, new_claim_token, new_lease_expires_at, 1
    )
    returning * into receipt_row;
  end if;

  return query select
    true, 'claimed'::text, receipt_row.id, receipt_row.operation_type,
    receipt_row.status, receipt_row.claim_token, receipt_row.lease_expires_at,
    null::jsonb, receipt_row.entity_type, receipt_row.entity_id,
    receipt_row.error_code;
end;
$$;

create or replace function public.finish_operation_receipt(
  p_receipt_id uuid,
  p_claim_token uuid,
  p_succeeded boolean,
  p_entity_type text default null,
  p_entity_id text default null,
  p_result jsonb default null,
  p_error_code text default null,
  p_completed_at timestamptz default null
)
returns table (
  finalized boolean,
  reason text,
  status text,
  result jsonb
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  receipt_row public.operation_receipts%rowtype;
  receipt_operation_key text;
begin
  if owner_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_receipt_id is null or p_claim_token is null or p_succeeded is null then
    raise exception 'Receipt ID, claim token and outcome are required' using errcode = '22023';
  end if;
  if p_entity_type is not null
    and char_length(btrim(p_entity_type)) not between 1 and 80 then
    raise exception 'entity_type must be 1 to 80 characters' using errcode = '22023';
  end if;
  if p_entity_id is not null and char_length(p_entity_id) > 500 then
    raise exception 'entity_id must be no more than 500 characters' using errcode = '22023';
  end if;
  if p_error_code is not null and char_length(p_error_code) > 200 then
    raise exception 'error_code must be no more than 200 characters' using errcode = '22023';
  end if;

  -- Read only the immutable key, acquire the same lock as the claim path, then
  -- re-read/update. This prevents a stale finisher racing a lease reclaim and
  -- replacing the newer executor's pending state.
  select receipt.operation_key into receipt_operation_key
  from public.operation_receipts receipt
  where receipt.id = p_receipt_id
    and receipt.user_id = owner_id;

  if not found then
    return query select false, 'not_found'::text, null::text, null::jsonb;
    return;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(owner_id::text || E'\\x1f' || receipt_operation_key, 0)
  );

  update public.operation_receipts receipt
  set status = case when p_succeeded then 'succeeded' else 'failed' end,
      entity_type = nullif(btrim(p_entity_type), ''),
      entity_id = p_entity_id,
      result = p_result,
      error_code = case when p_succeeded then null else p_error_code end,
      completed_at = coalesce(p_completed_at, clock_timestamp()),
      claim_token = null,
      lease_expires_at = null
  where receipt.id = p_receipt_id
    and receipt.user_id = owner_id
    and receipt.status = 'pending'
    and receipt.claim_token = p_claim_token
  returning receipt.* into receipt_row;

  if found then
    return query select
      true, 'finalized'::text, receipt_row.status, receipt_row.result;
    return;
  end if;

  select receipt.* into receipt_row
  from public.operation_receipts receipt
  where receipt.id = p_receipt_id
    and receipt.user_id = owner_id;

  if not found then
    return query select false, 'not_found'::text, null::text, null::jsonb;
  elsif receipt_row.status <> 'pending' then
    return query select
      false, 'already_finished'::text, receipt_row.status, receipt_row.result;
  else
    return query select
      false, 'claim_lost'::text, receipt_row.status, null::jsonb;
  end if;
end;
$$;

create or replace function public.claim_voice_session(
  p_session_id uuid,
  p_daily_minutes integer,
  p_concurrent_limit integer,
  p_max_session_minutes integer default 30
)
returns table (
  allowed boolean,
  reason text,
  session_id uuid,
  active_count integer,
  used_seconds integer,
  remaining_seconds integer,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  request_time timestamptz := clock_timestamp();
  utc_day_start timestamptz;
  utc_day_end timestamptz;
  daily_limit_seconds integer;
  used integer;
  committed integer;
  active integer;
  remaining integer;
  requested_expiry timestamptz;
  existing public.voice_usage_sessions%rowtype;
  existing_found boolean := false;
begin
  if owner_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_session_id is null then
    raise exception 'session_id is required' using errcode = '22023';
  end if;
  if p_daily_minutes is null
    or p_concurrent_limit is null
    or p_max_session_minutes is null
    or p_daily_minutes < 1 or p_daily_minutes > 1440
    or p_concurrent_limit < 1 or p_concurrent_limit > 10
    or p_max_session_minutes < 1 or p_max_session_minutes > 180 then
    raise exception 'Invalid voice budget limits' using errcode = '22023';
  end if;

  -- Serialise claims for this account so concurrent tabs cannot both pass the limit.
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text, 5796621));

  update public.voice_usage_sessions as usage
  set status = 'expired', ended_at = least(request_time, usage.expires_at)
  where usage.user_id = owner_id and usage.status = 'active' and usage.expires_at <= request_time;

  select * into existing from public.voice_usage_sessions where id = p_session_id;
  existing_found := found;
  if existing_found and existing.user_id <> owner_id then
    return query select false, 'session_id_unavailable', p_session_id, 0, 0, 0, null::timestamptz;
    return;
  end if;

  utc_day_start := date_trunc('day', request_time at time zone 'UTC') at time zone 'UTC';
  utc_day_end := utc_day_start + interval '1 day';
  daily_limit_seconds := p_daily_minutes * 60;

  select coalesce(sum(greatest(0, extract(epoch from (
    least(coalesce(v.ended_at, request_time), v.expires_at, utc_day_end)
    - greatest(v.started_at, utc_day_start)
  )))::integer), 0)
  into used
  from public.voice_usage_sessions v
  where v.user_id = owner_id
    and v.started_at < utc_day_end
    and coalesce(v.ended_at, request_time) > utc_day_start;

  -- Active calls reserve through their enforced expiry so two concurrent claims
  -- cannot jointly exceed the daily limit. Closed calls count only actual time.
  select coalesce(sum(greatest(0, extract(epoch from (
    least(
      case when v.status = 'active' then v.expires_at else coalesce(v.ended_at, request_time) end,
      v.expires_at,
      utc_day_end
    ) - greatest(v.started_at, utc_day_start)
  )))::integer), 0)
  into committed
  from public.voice_usage_sessions v
  where v.user_id = owner_id
    and v.started_at < utc_day_end
    and case when v.status = 'active' then v.expires_at else coalesce(v.ended_at, request_time) end > utc_day_start;

  select count(*)::integer into active
  from public.voice_usage_sessions v
  where v.user_id = owner_id and v.status = 'active' and v.expires_at > request_time;

  remaining := greatest(0, daily_limit_seconds - committed);

  if existing_found and existing.status = 'active' and existing.expires_at > request_time then
    return query select true, 'already_active', existing.id, active, used, remaining, existing.expires_at;
    return;
  elsif existing_found then
    return query select false, 'session_closed', existing.id, active, used, remaining, existing.expires_at;
    return;
  end if;

  if active >= p_concurrent_limit then
    return query select false, 'concurrent_limit', p_session_id, active, used, remaining, null::timestamptz;
    return;
  end if;
  if remaining <= 0 then
    return query select false, 'daily_budget_exhausted', p_session_id, active, used, 0, null::timestamptz;
    return;
  end if;

  requested_expiry := request_time
    + make_interval(secs => least(p_max_session_minutes * 60, remaining));
  insert into public.voice_usage_sessions (
    id, user_id, status, started_at, expires_at
  ) values (
    p_session_id, owner_id, 'active', request_time, requested_expiry
  );

  return query select true, 'allowed', p_session_id, active + 1, used, remaining, requested_expiry;
end;
$$;

create or replace function public.close_voice_session(
  p_session_id uuid,
  p_openai_call_id text default null
)
returns table (
  closed boolean,
  session_id uuid,
  used_seconds integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  closed_at timestamptz := clock_timestamp();
  usage_row public.voice_usage_sessions%rowtype;
begin
  if owner_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  update public.voice_usage_sessions as usage
  set status = case when usage.expires_at <= closed_at then 'expired' else 'closed' end,
      ended_at = least(closed_at, usage.expires_at),
      openai_call_id = coalesce(p_openai_call_id, usage.openai_call_id)
  where usage.id = p_session_id and usage.user_id = owner_id and usage.status = 'active'
  returning * into usage_row;

  if not found then
    select * into usage_row
    from public.voice_usage_sessions
    where id = p_session_id and user_id = owner_id;
  end if;

  if not found then
    return query select false, p_session_id, 0;
    return;
  end if;

  return query select
    usage_row.status <> 'active',
    usage_row.id,
    greatest(0, extract(epoch from (
      least(coalesce(usage_row.ended_at, closed_at), usage_row.expires_at)
      - usage_row.started_at
    ))::integer);
end;
$$;

create or replace function public.attach_voice_call(
  p_session_id uuid,
  p_openai_call_id text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
begin
  if owner_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_openai_call_id is null or char_length(btrim(p_openai_call_id)) not between 1 and 300 then
    raise exception 'A valid OpenAI call ID is required' using errcode = '22023';
  end if;

  update public.voice_usage_sessions
  set openai_call_id = btrim(p_openai_call_id)
  where id = p_session_id
    and user_id = owner_id
    and status = 'active'
    and expires_at > now();
  return found;
end;
$$;

-- Voice-budget mutations are server-only. The Worker validates the caller's
-- bearer token, then invokes these explicit-owner variants with the service
-- role. Keeping ownership out of browser-callable arguments prevents a client
-- from closing only the usage ledger while leaving its OpenAI call running.
create or replace function public.claim_voice_session_for_user(
  p_user_id uuid,
  p_session_id uuid,
  p_daily_minutes integer,
  p_concurrent_limit integer,
  p_max_session_minutes integer default 30
)
returns table (
  allowed boolean,
  reason text,
  session_id uuid,
  active_count integer,
  used_seconds integer,
  remaining_seconds integer,
  expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  owner_id uuid := p_user_id;
  request_time timestamptz := clock_timestamp();
  utc_day_start timestamptz;
  utc_day_end timestamptz;
  daily_limit_seconds integer;
  used integer;
  committed integer;
  active integer;
  remaining integer;
  requested_expiry timestamptz;
  existing public.voice_usage_sessions%rowtype;
  existing_found boolean := false;
begin
  if owner_id is null then
    raise exception 'user_id is required' using errcode = '22023';
  end if;
  if p_session_id is null then
    raise exception 'session_id is required' using errcode = '22023';
  end if;
  if p_daily_minutes is null
    or p_concurrent_limit is null
    or p_max_session_minutes is null
    or p_daily_minutes < 1 or p_daily_minutes > 1440
    or p_concurrent_limit < 1 or p_concurrent_limit > 10
    or p_max_session_minutes < 1 or p_max_session_minutes > 180 then
    raise exception 'Invalid voice budget limits' using errcode = '22023';
  end if;

  -- Serialise claims for this account so concurrent requests cannot both pass.
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text, 5796621));

  update public.voice_usage_sessions as usage
  set status = 'expired', ended_at = least(request_time, usage.expires_at)
  where usage.user_id = owner_id and usage.status = 'active' and usage.expires_at <= request_time;

  select * into existing from public.voice_usage_sessions where id = p_session_id;
  existing_found := found;
  if existing_found and existing.user_id <> owner_id then
    return query select false, 'session_id_unavailable', p_session_id, 0, 0, 0, null::timestamptz;
    return;
  end if;

  utc_day_start := date_trunc('day', request_time at time zone 'UTC') at time zone 'UTC';
  utc_day_end := utc_day_start + interval '1 day';
  daily_limit_seconds := p_daily_minutes * 60;

  select coalesce(sum(greatest(0, extract(epoch from (
    least(coalesce(v.ended_at, request_time), v.expires_at, utc_day_end)
    - greatest(v.started_at, utc_day_start)
  )))::integer), 0)
  into used
  from public.voice_usage_sessions v
  where v.user_id = owner_id
    and v.started_at < utc_day_end
    and coalesce(v.ended_at, request_time) > utc_day_start;

  select coalesce(sum(greatest(0, extract(epoch from (
    least(
      case when v.status = 'active' then v.expires_at else coalesce(v.ended_at, request_time) end,
      v.expires_at,
      utc_day_end
    ) - greatest(v.started_at, utc_day_start)
  )))::integer), 0)
  into committed
  from public.voice_usage_sessions v
  where v.user_id = owner_id
    and v.started_at < utc_day_end
    and case when v.status = 'active' then v.expires_at else coalesce(v.ended_at, request_time) end > utc_day_start;

  select count(*)::integer into active
  from public.voice_usage_sessions v
  where v.user_id = owner_id and v.status = 'active' and v.expires_at > request_time;

  remaining := greatest(0, daily_limit_seconds - committed);

  if existing_found and existing.status = 'active' and existing.expires_at > request_time then
    return query select true, 'already_active', existing.id, active, used, remaining, existing.expires_at;
    return;
  elsif existing_found then
    return query select false, 'session_closed', existing.id, active, used, remaining, existing.expires_at;
    return;
  end if;

  if active >= p_concurrent_limit then
    return query select false, 'concurrent_limit', p_session_id, active, used, remaining, null::timestamptz;
    return;
  end if;
  if remaining <= 0 then
    return query select false, 'daily_budget_exhausted', p_session_id, active, used, 0, null::timestamptz;
    return;
  end if;

  requested_expiry := request_time
    + make_interval(secs => least(p_max_session_minutes * 60, remaining));
  insert into public.voice_usage_sessions (
    id, user_id, status, started_at, expires_at
  ) values (
    p_session_id, owner_id, 'active', request_time, requested_expiry
  );

  return query select true, 'allowed', p_session_id, active + 1, used, remaining, requested_expiry;
end;
$$;

create or replace function public.close_voice_session_for_user(
  p_user_id uuid,
  p_session_id uuid,
  p_openai_call_id text default null
)
returns table (
  closed boolean,
  session_id uuid,
  used_seconds integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  owner_id uuid := p_user_id;
  closed_at timestamptz := clock_timestamp();
  usage_row public.voice_usage_sessions%rowtype;
begin
  if owner_id is null then
    raise exception 'user_id is required' using errcode = '22023';
  end if;

  update public.voice_usage_sessions as usage
  set status = case when usage.expires_at <= closed_at then 'expired' else 'closed' end,
      ended_at = least(closed_at, usage.expires_at),
      openai_call_id = coalesce(p_openai_call_id, usage.openai_call_id)
  where usage.id = p_session_id and usage.user_id = owner_id and usage.status = 'active'
  returning * into usage_row;

  if not found then
    select * into usage_row
    from public.voice_usage_sessions
    where id = p_session_id and user_id = owner_id;
  end if;

  if not found then
    return query select false, p_session_id, 0;
    return;
  end if;

  return query select
    usage_row.status <> 'active',
    usage_row.id,
    greatest(0, extract(epoch from (
      least(coalesce(usage_row.ended_at, closed_at), usage_row.expires_at)
      - usage_row.started_at
    ))::integer);
end;
$$;

create or replace function public.attach_voice_call_for_user(
  p_user_id uuid,
  p_session_id uuid,
  p_openai_call_id text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  owner_id uuid := p_user_id;
begin
  if owner_id is null then
    raise exception 'user_id is required' using errcode = '22023';
  end if;
  if p_openai_call_id is null or char_length(btrim(p_openai_call_id)) not between 1 and 300 then
    raise exception 'A valid OpenAI call ID is required' using errcode = '22023';
  end if;

  update public.voice_usage_sessions
  set openai_call_id = btrim(p_openai_call_id)
  where id = p_session_id
    and user_id = owner_id
    and status = 'active'
    and expires_at > now();
  return found;
end;
$$;

create or replace function public.preview_legacy_import(
  p_payload jsonb,
  p_source_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  companion_name text;
  current_name text;
  profile_action text;
  plan_action text := 'absent';
  legacy_plan_id text := 'legacy-plan-v1:' || owner_id::text;
  incoming_plan jsonb;
  current_plan public.workout_plans%rowtype;
  log_item jsonb;
  memory_item jsonb;
  milestone_item jsonb;
  item_id text;
  item_date date;
  item_timestamp timestamptz;
  activity_name text;
  duration_value integer;
  feeling_value text;
  incoming_memory_session text;
  existing_session public.workout_sessions%rowtype;
  existing_memory public.memories%rowtype;
  session_importable jsonb := '[]'::jsonb;
  session_duplicates jsonb := '[]'::jsonb;
  session_conflicts jsonb := '[]'::jsonb;
  memory_importable jsonb := '[]'::jsonb;
  memory_duplicates jsonb := '[]'::jsonb;
  memory_conflicts jsonb := '[]'::jsonb;
  milestone_importable jsonb := '[]'::jsonb;
  milestone_duplicates jsonb := '[]'::jsonb;
begin
  if owner_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_source_digest is null or p_source_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'source_digest must be a lowercase SHA-256 digest' using errcode = '22023';
  end if;
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or p_payload->>'version' <> '1'
    or jsonb_typeof(p_payload->'profile') <> 'object'
    or jsonb_typeof(p_payload->'logs') <> 'array' then
    raise exception 'Unsupported Knufl progress export' using errcode = '22023';
  end if;

  companion_name := btrim(p_payload#>>'{profile,name}');
  if companion_name is null or char_length(companion_name) not between 1 and 80 then
    raise exception 'The export has no valid companion name' using errcode = '22023';
  end if;

  select p.companion_name into current_name
  from public.profiles p
  where p.user_id = owner_id;
  if not found then
    profile_action := 'importable';
  elsif current_name = companion_name then
    profile_action := 'duplicate';
  else
    profile_action := 'conflict';
  end if;

  incoming_plan := p_payload->'plan';
  if incoming_plan is not null and jsonb_typeof(incoming_plan) = 'object' then
    select * into current_plan
    from public.workout_plans p
    where p.user_id = owner_id and p.id = legacy_plan_id;
    if not found then
      plan_action := 'importable';
    elsif (current_plan.weekly_target is not distinct from (
          case when incoming_plan->>'weeklyTarget' ~ '^\d+$' then (incoming_plan->>'weeklyTarget')::smallint else null end
        ))
      and current_plan.schedule_days = coalesce(
        array(select jsonb_array_elements_text(incoming_plan->'days')),
        '{}'::text[]
      )
      and current_plan.default_activity_key is not distinct from nullif(btrim(incoming_plan->>'activity'), '')
      and current_plan.activity_detail is not distinct from nullif(btrim(incoming_plan->>'activityDetail'), '')
      and (current_plan.next_session_local_date is not distinct from (
        case when incoming_plan->>'nextSessionDate' ~ '^\d{4}-\d{2}-\d{2}$'
          then (incoming_plan->>'nextSessionDate')::date else null end
      )) then
      plan_action := 'duplicate';
    else
      plan_action := 'conflict';
    end if;
  end if;

  for log_item in select value from jsonb_array_elements(p_payload->'logs') loop
    item_id := log_item->>'id';
    if item_id is null or btrim(item_id) = ''
      or log_item->>'date' !~ '^\d{4}-\d{2}-\d{2}$'
      or log_item->>'createdAt' is null then
      raise exception 'A legacy session is missing its stable ID, date or timestamp' using errcode = '22023';
    end if;
    item_date := (log_item->>'date')::date;
    item_timestamp := (log_item->>'createdAt')::timestamptz;
    activity_name := coalesce(nullif(btrim(log_item->>'activity'), ''), 'Activity');
    duration_value := case
      when log_item->>'duration' ~ '^\d+$' then (log_item->>'duration')::integer * 60
      else null
    end;
    feeling_value := nullif(btrim(log_item->>'feeling'), '');
    select * into existing_session
    from public.workout_sessions s
    where s.id = item_id;
    if not found then
      if exists (
        select 1 from public.exercise_instances exercise
        where exercise.id = item_id || ':legacy-activity'
          and exercise.user_id <> owner_id
      ) then
        session_conflicts := session_conflicts || to_jsonb(item_id);
      else
        session_importable := session_importable || to_jsonb(item_id);
      end if;
    elsif existing_session.user_id <> owner_id then
      session_conflicts := session_conflicts || to_jsonb(item_id);
    elsif existing_session.source = 'legacy'
      and existing_session.legacy_source_id = item_id
      and existing_session.status = 'completed'
      and existing_session.occurrence_id is null
      and existing_session.local_date = item_date
      and existing_session.timezone = 'Legacy/Unknown'
      and existing_session.started_at = item_timestamp
      and existing_session.completed_at = item_timestamp
      and existing_session.duration_seconds is not distinct from duration_value
      and existing_session.feeling is not distinct from feeling_value
      and existing_session.notes is null
      and exists (
        select 1
        from public.exercise_instances exercise
        where exercise.id = item_id || ':legacy-activity'
          and exercise.user_id = owner_id
          and exercise.session_id = item_id
          and exercise.plan_exercise_id is null
          and exercise.position = 0
          and exercise.exercise_key = lower(activity_name)
          and exercise.display_name = activity_name
          and exercise.planned_sets is null
          and exercise.planned_reps is null
          and exercise.planned_load is null
          and exercise.planned_load_unit is null
          and exercise.planned_load_mode is null
          and exercise.rest_seconds is null
      ) then
      session_duplicates := session_duplicates || to_jsonb(item_id);
    else
      session_conflicts := session_conflicts || to_jsonb(item_id);
    end if;
  end loop;

  if p_payload ? 'memories' and jsonb_typeof(p_payload->'memories') <> 'array' then
    raise exception 'Legacy memories must be an array' using errcode = '22023';
  end if;
  for memory_item in select value from jsonb_array_elements(coalesce(p_payload->'memories', '[]'::jsonb)) loop
    item_id := memory_item->>'id';
    incoming_memory_session := nullif(btrim(memory_item->>'associatedSessionId'), '');
    if item_id is null or btrim(item_id) = ''
      or nullif(btrim(memory_item->>'title'), '') is null
      or nullif(btrim(memory_item->>'note'), '') is null then
      raise exception 'A legacy memory is missing its stable ID or content' using errcode = '22023';
    end if;
    select * into existing_memory
    from public.memories m
    where m.id = item_id;
    if not found then
      if incoming_memory_session is not null
        and not exists (
          select 1 from public.workout_sessions s
          where s.user_id = owner_id and s.id = incoming_memory_session
          union all
          select 1 from jsonb_array_elements(p_payload->'logs') source_log
          where source_log->>'id' = incoming_memory_session
        ) then
        memory_conflicts := memory_conflicts || to_jsonb(item_id);
      else
        memory_importable := memory_importable || to_jsonb(item_id);
      end if;
    elsif existing_memory.user_id <> owner_id then
      memory_conflicts := memory_conflicts || to_jsonb(item_id);
    elsif existing_memory.title = memory_item->>'title'
      and existing_memory.note = memory_item->>'note'
      and existing_memory.associated_session_id is not distinct from incoming_memory_session then
      memory_duplicates := memory_duplicates || to_jsonb(item_id);
    else
      memory_conflicts := memory_conflicts || to_jsonb(item_id);
    end if;
  end loop;

  if p_payload ? 'unlockedMoves' and jsonb_typeof(p_payload->'unlockedMoves') <> 'array' then
    raise exception 'Legacy milestones must be an array' using errcode = '22023';
  end if;
  for milestone_item in select value from jsonb_array_elements(coalesce(p_payload->'unlockedMoves', '[]'::jsonb)) loop
    if jsonb_typeof(milestone_item) <> 'string' then
      continue;
    end if;
    item_id := trim(both '"' from milestone_item::text);
    if exists (
      select 1 from public.milestone_unlocks m
      where m.user_id = owner_id and m.milestone_id = item_id
    ) then
      milestone_duplicates := milestone_duplicates || to_jsonb(item_id);
    else
      milestone_importable := milestone_importable || to_jsonb(item_id);
    end if;
  end loop;

  return jsonb_build_object(
    'valid', true,
    'sourceVersion', 1,
    'sourceDigest', p_source_digest,
    'companionName', companion_name,
    -- Only the name is surfaced; legacy gender/pronoun fields are discarded.
    'sanitizedProfile', jsonb_build_object('name', companion_name),
    'profile', jsonb_build_object('action', profile_action),
    'plan', jsonb_build_object('action', plan_action, 'id', legacy_plan_id),
    'sessions', jsonb_build_object(
      'importable', session_importable,
      'duplicates', session_duplicates,
      'conflicts', session_conflicts
    ),
    'memories', jsonb_build_object(
      'importable', memory_importable,
      'duplicates', memory_duplicates,
      'conflicts', memory_conflicts
    ),
    'milestones', jsonb_build_object(
      'importable', milestone_importable,
      'duplicates', milestone_duplicates
    )
  );
end;
$$;

create or replace function public.import_legacy_progress(
  p_payload jsonb,
  p_source_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  import_preview jsonb;
  batch_record public.import_batches%rowtype;
  log_item jsonb;
  memory_item jsonb;
  milestone_item jsonb;
  incoming_plan jsonb := p_payload->'plan';
  legacy_plan_id text := 'legacy-plan-v1:' || owner_id::text;
  item_id text;
  item_timestamp timestamptz;
  item_date date;
  activity_name text;
  duration_value integer;
begin
  if owner_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  -- Serialize every account-data import before previewing it. Without this lock,
  -- two different legacy digests can both preview the same stable IDs as new,
  -- then silently drop one payload through ON CONFLICT while both report success.
  perform pg_advisory_xact_lock(
    hashtextextended('knufl-account-import:' || owner_id::text, 0)
  );

  import_preview := public.preview_legacy_import(p_payload, p_source_digest);

  select * into batch_record
  from public.import_batches b
  where b.user_id = owner_id and b.source_digest = p_source_digest;
  if found and batch_record.status = 'completed' then
    return jsonb_build_object(
      'status', 'already-imported',
      'batchId', batch_record.id,
      'preview', batch_record.preview
    );
  end if;

  if (import_preview#>>'{profile,action}') = 'conflict'
    or (import_preview#>>'{plan,action}') = 'conflict'
    or jsonb_array_length(import_preview#>'{sessions,conflicts}') > 0
    or jsonb_array_length(import_preview#>'{memories,conflicts}') > 0 then
    insert into public.import_batches (
      user_id, source_version, source_digest, status, preview
    ) values (
      owner_id, 1, p_source_digest, 'conflict', import_preview
    ) on conflict (user_id, source_digest) do update
      set status = 'conflict', preview = excluded.preview
    returning * into batch_record;
    return jsonb_build_object('status', 'conflict', 'batchId', batch_record.id, 'preview', import_preview);
  end if;

  insert into public.import_batches (
    user_id, source_version, source_digest, status, preview
  ) values (
    owner_id, 1, p_source_digest, 'importing', import_preview
  ) on conflict (user_id, source_digest) do update
    set status = 'importing', preview = excluded.preview
  returning * into batch_record;

  insert into public.profiles (user_id, companion_name)
  values (owner_id, import_preview#>>'{sanitizedProfile,name}')
  on conflict (user_id) do nothing;

  if incoming_plan is not null and jsonb_typeof(incoming_plan) = 'object' then
    insert into public.workout_plans (
      id, user_id, name, status, weekly_target, schedule_days,
      default_activity_key, activity_detail, next_session_local_date
    ) values (
      legacy_plan_id,
      owner_id,
      'Imported Knufl plan',
      'active',
      case when incoming_plan->>'weeklyTarget' ~ '^\d+$' then (incoming_plan->>'weeklyTarget')::smallint else null end,
      coalesce(array(select jsonb_array_elements_text(incoming_plan->'days')), '{}'::text[]),
      nullif(btrim(incoming_plan->>'activity'), ''),
      nullif(btrim(incoming_plan->>'activityDetail'), ''),
      case when incoming_plan->>'nextSessionDate' ~ '^\d{4}-\d{2}-\d{2}$'
        then (incoming_plan->>'nextSessionDate')::date else null end
    ) on conflict (id) do nothing;

    insert into public.import_items (
      user_id, batch_id, source_kind, source_id, target_id, source_digest, status
    ) values (
      owner_id, batch_record.id, 'plan', 'legacy-plan-v1', legacy_plan_id, p_source_digest,
      case when (import_preview#>>'{plan,action}') = 'duplicate' then 'duplicate' else 'imported' end
    ) on conflict (user_id, source_kind, source_id) do nothing;
  end if;

  for log_item in select value from jsonb_array_elements(p_payload->'logs') loop
    item_id := log_item->>'id';
    item_timestamp := (log_item->>'createdAt')::timestamptz;
    item_date := (log_item->>'date')::date;
    activity_name := coalesce(nullif(btrim(log_item->>'activity'), ''), 'Activity');
    duration_value := case
      when log_item->>'duration' ~ '^\d+$' then (log_item->>'duration')::integer * 60
      else null
    end;

    insert into public.workout_sessions (
      id, user_id, source, status, local_date, timezone, started_at,
      completed_at, duration_seconds, feeling, legacy_source_id
    ) values (
      item_id, owner_id, 'legacy', 'completed', item_date, 'Legacy/Unknown', item_timestamp,
      item_timestamp, duration_value, nullif(btrim(log_item->>'feeling'), ''), item_id
    ) on conflict (id) do nothing;

    insert into public.exercise_instances (
      id, user_id, session_id, position, exercise_key, display_name
    ) values (
      item_id || ':legacy-activity', owner_id, item_id, 0, lower(activity_name), activity_name
    ) on conflict (id) do nothing;

    insert into public.import_items (
      user_id, batch_id, source_kind, source_id, target_id, source_digest, status
    ) values (
      owner_id, batch_record.id, 'session', item_id, item_id, p_source_digest,
      case when (import_preview#>'{sessions,duplicates}') ? item_id then 'duplicate' else 'imported' end
    ) on conflict (user_id, source_kind, source_id) do nothing;
  end loop;

  for memory_item in select value from jsonb_array_elements(coalesce(p_payload->'memories', '[]'::jsonb)) loop
    item_id := memory_item->>'id';
    insert into public.memories (
      id, user_id, associated_session_id, title, note, editable, created_at, updated_at
    ) values (
      item_id,
      owner_id,
      nullif(btrim(memory_item->>'associatedSessionId'), ''),
      memory_item->>'title',
      memory_item->>'note',
      true,
      case when nullif(btrim(memory_item->>'createdAt'), '') is null
        then now() else (memory_item->>'createdAt')::timestamptz end,
      case when nullif(btrim(memory_item->>'createdAt'), '') is null
        then now() else (memory_item->>'createdAt')::timestamptz end
    ) on conflict (id) do nothing;

    insert into public.import_items (
      user_id, batch_id, source_kind, source_id, target_id, source_digest, status
    ) values (
      owner_id, batch_record.id, 'memory', item_id, item_id, p_source_digest,
      case when (import_preview#>'{memories,duplicates}') ? item_id then 'duplicate' else 'imported' end
    ) on conflict (user_id, source_kind, source_id) do nothing;
  end loop;

  for milestone_item in select value from jsonb_array_elements(coalesce(p_payload->'unlockedMoves', '[]'::jsonb)) loop
    if jsonb_typeof(milestone_item) <> 'string' then
      continue;
    end if;
    item_id := trim(both '"' from milestone_item::text);
    insert into public.milestone_unlocks (user_id, milestone_id, unlocked_at)
    values (owner_id, item_id, now())
    on conflict (user_id, milestone_id) do nothing;

    insert into public.import_items (
      user_id, batch_id, source_kind, source_id, target_id, source_digest, status
    ) values (
      owner_id, batch_record.id, 'milestone', item_id, item_id, p_source_digest,
      case when (import_preview#>'{milestones,duplicates}') ? item_id then 'duplicate' else 'imported' end
    ) on conflict (user_id, source_kind, source_id) do nothing;
  end loop;

  update public.import_batches
  set status = 'completed', completed_at = now()
  where id = batch_record.id and user_id = owner_id;

  return jsonb_build_object('status', 'completed', 'batchId', batch_record.id, 'preview', import_preview);
end;
$$;

-- Recursively remove account IDs and short-lived provider/lease metadata from
-- portable exports, including those nested inside audit snapshots and tool results.
create or replace function public.knufl_strip_private_json(p_value jsonb)
returns jsonb
language plpgsql
immutable
strict
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
declare
  pair record;
  element jsonb;
  cleaned jsonb;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      cleaned := '{}'::jsonb;
      for pair in select key, value from jsonb_each(p_value) loop
        if pair.key <> all (array[
          'user_id', 'claim_token', 'lease_expires_at', 'openai_call_id'
        ]::text[]) then
          cleaned := cleaned || jsonb_build_object(
            pair.key,
            public.knufl_strip_private_json(pair.value)
          );
        end if;
      end loop;
      return cleaned;
    when 'array' then
      cleaned := '[]'::jsonb;
      for element in select value from jsonb_array_elements(p_value) loop
        cleaned := cleaned || jsonb_build_array(public.knufl_strip_private_json(element));
      end loop;
      return cleaned;
    else
      return p_value;
  end case;
end;
$$;

-- Canonical ordering makes an exported snapshot comparable after a restore.
-- This helper is internal: browser ownership must come from auth.uid() in the
-- public wrapper functions below.
create or replace function public.knufl_account_snapshot(p_user_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'profile', (
      select public.knufl_strip_private_json(to_jsonb(p) - 'user_id')
      from public.profiles p where p.user_id = p_user_id
    ),
    'preferences', (
      select public.knufl_strip_private_json(to_jsonb(p) - 'user_id')
      from public.preferences p where p.user_id = p_user_id
    ),
    'plans', coalesce((
      select jsonb_agg(public.knufl_strip_private_json(to_jsonb(x) - 'user_id') order by x.created_at, x.id)
      from public.workout_plans x where x.user_id = p_user_id
    ), '[]'::jsonb),
    'planExercises', coalesce((
      select jsonb_agg(public.knufl_strip_private_json(to_jsonb(x) - 'user_id') order by x.plan_id, x.position, x.id)
      from public.plan_exercises x where x.user_id = p_user_id
    ), '[]'::jsonb),
    'occurrences', coalesce((
      select jsonb_agg(public.knufl_strip_private_json(to_jsonb(x) - 'user_id') order by x.scheduled_local_date, x.created_at, x.id)
      from public.workout_occurrences x where x.user_id = p_user_id
    ), '[]'::jsonb),
    'sessions', coalesce((
      select jsonb_agg(public.knufl_strip_private_json(to_jsonb(x) - 'user_id') order by x.started_at, x.id)
      from public.workout_sessions x where x.user_id = p_user_id
    ), '[]'::jsonb),
    'exercises', coalesce((
      select jsonb_agg(public.knufl_strip_private_json(to_jsonb(x) - 'user_id') order by x.session_id, x.position, x.id)
      from public.exercise_instances x where x.user_id = p_user_id
    ), '[]'::jsonb),
    'completedSets', coalesce((
      select jsonb_agg(public.knufl_strip_private_json(to_jsonb(x) - 'user_id') order by x.completed_at, x.id)
      from public.completed_sets x where x.user_id = p_user_id
    ), '[]'::jsonb),
    'setRevisions', coalesce((
      select jsonb_agg(public.knufl_strip_private_json(to_jsonb(x) - 'user_id') order by x.set_id, x.revision, x.id)
      from public.set_revisions x where x.user_id = p_user_id
    ), '[]'::jsonb),
    'cardioRecords', coalesce((
      select jsonb_agg(public.knufl_strip_private_json(to_jsonb(x) - 'user_id') order by x.completed_at, x.id)
      from public.cardio_records x where x.user_id = p_user_id
    ), '[]'::jsonb),
    'restTimers', coalesce((
      select jsonb_agg(public.knufl_strip_private_json(to_jsonb(x) - 'user_id') order by x.started_at, x.id)
      from public.rest_timers x where x.user_id = p_user_id
    ), '[]'::jsonb),
    'memories', coalesce((
      select jsonb_agg(public.knufl_strip_private_json(to_jsonb(x) - 'user_id') order by x.created_at, x.id)
      from public.memories x where x.user_id = p_user_id
    ), '[]'::jsonb),
    'milestones', coalesce((
      select jsonb_agg(public.knufl_strip_private_json(to_jsonb(x) - 'user_id') order by x.unlocked_at, x.milestone_id)
      from public.milestone_unlocks x where x.user_id = p_user_id
    ), '[]'::jsonb),
    'exerciseDayCredits', coalesce((
      select jsonb_agg(public.knufl_strip_private_json(to_jsonb(x) - 'user_id') order by x.local_date)
      from public.exercise_day_credits x where x.user_id = p_user_id
    ), '[]'::jsonb),
    'operations', coalesce((
      select jsonb_agg(public.knufl_strip_private_json(to_jsonb(x) - 'user_id') order by x.created_at, x.id)
      from public.operation_receipts x where x.user_id = p_user_id
    ), '[]'::jsonb)
  );
$$;

create or replace function public.knufl_restore_snapshot(p_payload jsonb)
returns jsonb
language sql
immutable
strict
security invoker
set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'profile', case
      when p_payload->'profile' = 'null'::jsonb then 'null'::jsonb
      else public.knufl_strip_private_json(p_payload->'profile') - 'gender' - 'pronouns'
    end,
    'preferences', case
      when p_payload->'preferences' = 'null'::jsonb then 'null'::jsonb
      else public.knufl_strip_private_json(p_payload->'preferences') - 'gender' - 'pronouns'
    end,
    'plans', public.knufl_strip_private_json(p_payload->'plans'),
    'planExercises', public.knufl_strip_private_json(p_payload->'planExercises'),
    'occurrences', public.knufl_strip_private_json(p_payload->'occurrences'),
    'sessions', public.knufl_strip_private_json(p_payload->'sessions'),
    'exercises', public.knufl_strip_private_json(p_payload->'exercises'),
    'completedSets', public.knufl_strip_private_json(p_payload->'completedSets'),
    'setRevisions', public.knufl_strip_private_json(p_payload->'setRevisions'),
    'cardioRecords', public.knufl_strip_private_json(p_payload->'cardioRecords'),
    'restTimers', public.knufl_strip_private_json(p_payload->'restTimers'),
    'memories', public.knufl_strip_private_json(p_payload->'memories'),
    'milestones', public.knufl_strip_private_json(p_payload->'milestones'),
    'exerciseDayCredits', public.knufl_strip_private_json(p_payload->'exerciseDayCredits'),
    'operations', public.knufl_strip_private_json(p_payload->'operations')
  );
$$;

create or replace function public.preview_account_restore(
  p_payload jsonb,
  p_source_digest text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  array_key text;
  id_mapping record;
  incoming_snapshot jsonb;
  current_snapshot jsonb;
  current_is_replaceable boolean := true;
  stable_id_collision boolean := false;
  duplicate_stable_id boolean := false;
  has_duplicate_stable_id boolean := false;
  mapped_collision boolean;
  restore_action text;
  conflicts jsonb := '[]'::jsonb;
  counts jsonb := '{}'::jsonb;
begin
  if owner_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  if p_source_digest is null or p_source_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'source_digest must be a lowercase SHA-256 digest' using errcode = '22023';
  end if;
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or p_payload->>'formatVersion' <> '2'
    or not (p_payload ? 'profile')
    or jsonb_typeof(p_payload->'profile') <> 'object'
    or nullif(btrim(p_payload#>>'{profile,companion_name}'), '') is null
    or char_length(btrim(p_payload#>>'{profile,companion_name}')) > 80
    or not (p_payload ? 'preferences')
    or jsonb_typeof(p_payload->'preferences') not in ('object', 'null') then
    raise exception 'Unsupported Knufl cloud account export' using errcode = '22023';
  end if;

  foreach array_key in array array[
    'plans', 'planExercises', 'occurrences', 'sessions', 'exercises',
    'completedSets', 'setRevisions', 'cardioRecords', 'restTimers',
    'memories', 'milestones', 'exerciseDayCredits', 'operations'
  ] loop
    if not (p_payload ? array_key)
      or jsonb_typeof(p_payload->array_key) <> 'array'
      or exists (
        select 1 from jsonb_array_elements(p_payload->array_key) item
        where jsonb_typeof(item.value) <> 'object'
      ) then
      raise exception 'Cloud account export field % must be an array of objects', array_key
        using errcode = '22023';
    end if;
    counts := counts || jsonb_build_object(array_key, jsonb_array_length(p_payload->array_key));
  end loop;

  incoming_snapshot := public.knufl_restore_snapshot(p_payload);
  current_snapshot := public.knufl_account_snapshot(owner_id);
  -- Auth/onboarding normally creates a profile and preferences before a user can
  -- choose an archive. Those two bootstrap rows contain no earned progress and
  -- may be explicitly replaced by a confirmed restore. Every data-bearing array
  -- below must still be empty.
  foreach array_key in array array[
    'plans', 'planExercises', 'occurrences', 'sessions', 'exercises',
    'completedSets', 'setRevisions', 'cardioRecords', 'restTimers',
    'memories', 'milestones', 'exerciseDayCredits', 'operations'
  ] loop
    current_is_replaceable := current_is_replaceable
      and jsonb_array_length(current_snapshot->array_key) = 0;
  end loop;

  -- Stable entity IDs remain stable. If an ID still belongs to another account,
  -- the preview reports a conflict instead of remapping or partially restoring.
  for id_mapping in
    select * from (values
      ('plans', 'workout_plans'),
      ('planExercises', 'plan_exercises'),
      ('occurrences', 'workout_occurrences'),
      ('sessions', 'workout_sessions'),
      ('exercises', 'exercise_instances'),
      ('completedSets', 'completed_sets'),
      ('setRevisions', 'set_revisions'),
      ('cardioRecords', 'cardio_records'),
      ('restTimers', 'rest_timers'),
      ('memories', 'memories'),
      ('operations', 'operation_receipts')
    ) as mapping(payload_key, table_name)
  loop
    if exists (
      select 1
      from jsonb_array_elements(incoming_snapshot->id_mapping.payload_key) item
      where nullif(btrim(item.value->>'id'), '') is null
    ) then
      raise exception 'Cloud account export field % contains a row without an ID', id_mapping.payload_key
        using errcode = '22023';
    end if;

    select count(*) <> count(distinct item.value->>'id')
    into duplicate_stable_id
    from jsonb_array_elements(incoming_snapshot->id_mapping.payload_key) item;
    if duplicate_stable_id then
      has_duplicate_stable_id := true;
      conflicts := conflicts || jsonb_build_array('duplicate-stable-id-in-export');
    end if;

    execute format(
      'select exists (
         select 1
         from public.%I target
         join jsonb_array_elements($1) item
           on target.id::text = item.value->>''id''
         where target.user_id <> $2
       )',
      id_mapping.table_name
    ) into mapped_collision
    using incoming_snapshot->id_mapping.payload_key, owner_id;
    stable_id_collision := stable_id_collision or mapped_collision;
  end loop;

  if stable_id_collision then
    conflicts := conflicts || jsonb_build_array('stable-id-owned-by-another-account');
  end if;

  -- A prior digest alone is not proof that the current account still matches
  -- the archive: data may have been edited or deleted since that restore.
  if current_snapshot = incoming_snapshot then
    restore_action := 'duplicate';
  elsif current_is_replaceable and not stable_id_collision and not has_duplicate_stable_id then
    restore_action := 'importable';
  else
    restore_action := 'conflict';
    if not current_is_replaceable then
      conflicts := conflicts || jsonb_build_array('account-not-empty-or-different');
    end if;
  end if;

  return jsonb_build_object(
    'valid', true,
    'sourceVersion', 2,
    'sourceDigest', p_source_digest,
    'action', restore_action,
    'companionName', coalesce(incoming_snapshot#>>'{profile,companion_name}', 'Knufl'),
    'counts', counts,
    'conflicts', conflicts
  );
end;
$$;

create or replace function public.restore_account_data(
  p_payload jsonb,
  p_source_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
  restore_preview jsonb;
  incoming_snapshot jsonb;
  batch_record public.import_batches%rowtype;
begin
  if owner_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('knufl-account-import:' || owner_id::text, 0)
  );

  restore_preview := public.preview_account_restore(p_payload, p_source_digest);
  incoming_snapshot := public.knufl_restore_snapshot(p_payload);

  if restore_preview->>'action' = 'duplicate' then
    insert into public.import_batches (
      user_id, source_version, source_digest, status, preview, completed_at
    ) values (
      owner_id, 2, p_source_digest, 'completed', restore_preview, now()
    ) on conflict (user_id, source_digest) do update
      set source_version = 2,
          status = 'completed',
          preview = excluded.preview,
          completed_at = coalesce(public.import_batches.completed_at, excluded.completed_at)
    returning * into batch_record;
    return jsonb_build_object(
      'status', 'already-restored', 'batchId', batch_record.id, 'preview', restore_preview
    );
  end if;

  if restore_preview->>'action' <> 'importable' then
    insert into public.import_batches (
      user_id, source_version, source_digest, status, preview
    ) values (
      owner_id, 2, p_source_digest, 'conflict', restore_preview
    ) on conflict (user_id, source_digest) do update
      set source_version = 2,
          status = 'conflict',
          preview = excluded.preview,
          completed_at = null
    returning * into batch_record;
    return jsonb_build_object(
      'status', 'conflict', 'batchId', batch_record.id, 'preview', restore_preview
    );
  end if;

  insert into public.import_batches (
    user_id, source_version, source_digest, status, preview
  ) values (
    owner_id, 2, p_source_digest, 'importing', restore_preview
  ) on conflict (user_id, source_digest) do update
    set source_version = 2,
        status = 'importing',
        preview = excluded.preview,
        completed_at = null
  returning * into batch_record;

  -- The importable preview guarantees that these are the only account rows
  -- present. Replace the bootstrap values with the archive's exact snapshot.
  delete from public.preferences where user_id = owner_id;
  delete from public.profiles where user_id = owner_id;

  if incoming_snapshot->'profile' <> 'null'::jsonb then
    insert into public.profiles
    select populated.*
    from jsonb_populate_record(
      null::public.profiles,
      incoming_snapshot->'profile' || jsonb_build_object('user_id', owner_id)
    ) populated;
  end if;

  if incoming_snapshot->'preferences' <> 'null'::jsonb then
    insert into public.preferences
    select populated.*
    from jsonb_populate_record(
      null::public.preferences,
      incoming_snapshot->'preferences' || jsonb_build_object('user_id', owner_id)
    ) populated;
  end if;

  insert into public.workout_plans
  select populated.*
  from jsonb_array_elements(incoming_snapshot->'plans') item
  cross join lateral jsonb_populate_record(
    null::public.workout_plans,
    item.value || jsonb_build_object('user_id', owner_id)
  ) populated;

  insert into public.plan_exercises
  select populated.*
  from jsonb_array_elements(incoming_snapshot->'planExercises') item
  cross join lateral jsonb_populate_record(
    null::public.plan_exercises,
    item.value || jsonb_build_object('user_id', owner_id)
  ) populated;

  insert into public.workout_occurrences
  select populated.*
  from jsonb_array_elements(incoming_snapshot->'occurrences') item
  cross join lateral jsonb_populate_record(
    null::public.workout_occurrences,
    item.value || jsonb_build_object('user_id', owner_id)
  ) populated;

  insert into public.workout_sessions
  select populated.*
  from jsonb_array_elements(incoming_snapshot->'sessions') item
  cross join lateral jsonb_populate_record(
    null::public.workout_sessions,
    item.value || jsonb_build_object('user_id', owner_id)
  ) populated;

  -- Completed-session triggers intentionally run during restore. Their generated
  -- awards are replaced below by the exact immutable awards in the export.
  delete from public.exercise_day_credits where user_id = owner_id;
  delete from public.milestone_unlocks where user_id = owner_id;

  insert into public.exercise_instances
  select populated.*
  from jsonb_array_elements(incoming_snapshot->'exercises') item
  cross join lateral jsonb_populate_record(
    null::public.exercise_instances,
    item.value || jsonb_build_object('user_id', owner_id)
  ) populated;

  insert into public.operation_receipts
  select populated.*
  from jsonb_array_elements(incoming_snapshot->'operations') item
  cross join lateral jsonb_populate_record(
    null::public.operation_receipts,
    (item.value - 'claim_token' - 'lease_expires_at') || jsonb_build_object(
      'user_id', owner_id,
      'attempt_count', coalesce((item.value->>'attempt_count')::integer, 0)
    )
  ) populated;

  insert into public.completed_sets
  select populated.*
  from jsonb_array_elements(incoming_snapshot->'completedSets') item
  cross join lateral jsonb_populate_record(
    null::public.completed_sets,
    item.value || jsonb_build_object('user_id', owner_id)
  ) populated;

  -- Set inserts generate audit rows. Replace only those restore-generated rows
  -- with the exact exported history, preserving IDs, revisions and operations.
  delete from public.set_revisions where user_id = owner_id;
  insert into public.set_revisions
  select populated.*
  from jsonb_array_elements(incoming_snapshot->'setRevisions') item
  cross join lateral jsonb_populate_record(
    null::public.set_revisions,
    item.value || jsonb_build_object('user_id', owner_id)
  ) populated;

  insert into public.cardio_records
  select populated.*
  from jsonb_array_elements(incoming_snapshot->'cardioRecords') item
  cross join lateral jsonb_populate_record(
    null::public.cardio_records,
    item.value || jsonb_build_object('user_id', owner_id)
  ) populated;

  insert into public.rest_timers
  select populated.*
  from jsonb_array_elements(incoming_snapshot->'restTimers') item
  cross join lateral jsonb_populate_record(
    null::public.rest_timers,
    item.value || jsonb_build_object('user_id', owner_id)
  ) populated;

  insert into public.memories
  select populated.*
  from jsonb_array_elements(incoming_snapshot->'memories') item
  cross join lateral jsonb_populate_record(
    null::public.memories,
    item.value || jsonb_build_object('user_id', owner_id)
  ) populated;

  insert into public.exercise_day_credits
  select populated.*
  from jsonb_array_elements(incoming_snapshot->'exerciseDayCredits') item
  cross join lateral jsonb_populate_record(
    null::public.exercise_day_credits,
    item.value || jsonb_build_object('user_id', owner_id)
  ) populated;

  insert into public.milestone_unlocks
  select populated.*
  from jsonb_array_elements(incoming_snapshot->'milestones') item
  cross join lateral jsonb_populate_record(
    null::public.milestone_unlocks,
    item.value || jsonb_build_object('user_id', owner_id)
  ) populated;

  if public.knufl_account_snapshot(owner_id) <> incoming_snapshot then
    raise exception 'Cloud account restore verification failed' using errcode = 'P0004';
  end if;

  update public.import_batches
  set status = 'completed', completed_at = now()
  where id = batch_record.id and user_id = owner_id;

  return jsonb_build_object(
    'status', 'completed', 'batchId', batch_record.id, 'preview', restore_preview
  );
end;
$$;

create or replace function public.export_account_data()
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
begin
  if owner_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  return jsonb_build_object(
    'formatVersion', 2,
    'exportedAt', now()
  ) || public.knufl_account_snapshot(owner_id);
end;
$$;

create or replace function public.delete_current_account()
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public, auth, pg_temp
as $$
declare
  owner_id uuid := auth.uid();
begin
  if owner_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;
  -- UI/API callers must obtain explicit confirmation before invoking this RPC.
  -- Deleting auth.users cascades all Knufl rows and invalidates future token refresh.
  delete from auth.users where id = owner_id;
  return found;
end;
$$;

-- Consistent owner-only RLS. Composite foreign keys above prevent a user from
-- attaching their child row to another account's parent, even with guessed IDs.
do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'profiles', 'preferences', 'workout_plans', 'plan_exercises',
    'workout_occurrences', 'workout_sessions', 'exercise_instances',
    'operation_receipts', 'completed_sets', 'set_revisions', 'cardio_records',
    'rest_timers', 'memories', 'exercise_day_credits', 'milestone_unlocks',
    'import_batches', 'import_items', 'sync_conflicts', 'voice_usage_sessions'
  ] loop
    execute format('alter table public.%I enable row level security', relation_name);
    execute format('alter table public.%I force row level security', relation_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = user_id)',
      relation_name || '_select_own', relation_name
    );
  end loop;

  -- Browser DML is intentionally limited to small user-managed account fields.
  -- Workout mutations run through the authenticated Worker so a browser cannot
  -- bypass tool validation, operation receipts, or optimistic version checks.
  foreach relation_name in array array[
    'profiles', 'preferences', 'memories'
  ] loop
    execute format(
      'create policy %I on public.%I for insert to authenticated with check ((select auth.uid()) = user_id)',
      relation_name || '_insert_own', relation_name
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)',
      relation_name || '_update_own', relation_name
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using ((select auth.uid()) = user_id)',
      relation_name || '_delete_own', relation_name
    );
  end loop;
end;
$$;

revoke all on table
  public.profiles,
  public.preferences,
  public.workout_plans,
  public.plan_exercises,
  public.workout_occurrences,
  public.workout_sessions,
  public.exercise_instances,
  public.operation_receipts,
  public.completed_sets,
  public.set_revisions,
  public.cardio_records,
  public.rest_timers,
  public.memories,
  public.exercise_day_credits,
  public.milestone_unlocks,
  public.import_batches,
  public.import_items,
  public.sync_conflicts,
  public.voice_usage_sessions
from anon, authenticated;
grant usage on schema public to authenticated;
grant select on table
  public.profiles,
  public.preferences,
  public.workout_plans,
  public.plan_exercises,
  public.workout_occurrences,
  public.workout_sessions,
  public.exercise_instances,
  public.completed_sets,
  public.cardio_records,
  public.rest_timers,
  public.memories
to authenticated;
grant insert, update, delete on table
  public.profiles,
  public.preferences,
  public.memories
to authenticated;

-- Receipts are claimed/finalized only through the atomic RPCs. The safe read
-- surface supports undo/history without exposing live claim tokens or leases.
revoke all on table public.operation_receipts from authenticated;
grant select (
  id, user_id, operation_key, operation_type, entity_type, entity_id, status,
  result, error_code, client_created_at, attempt_count, created_at, completed_at
) on public.operation_receipts to authenticated;

grant select on table public.sync_conflicts to authenticated;

grant select on table
  public.set_revisions,
  public.exercise_day_credits,
  public.milestone_unlocks,
  public.import_batches,
  public.import_items
to authenticated;

-- The ledger includes a provider call ID and is never browser-readable.
revoke all on table public.voice_usage_sessions from authenticated;
grant select on table public.voice_usage_sessions to service_role;

-- The Worker holds this credential only in its server environment. It still
-- scopes every request to the validated account ID; the browser never receives
-- this role or direct workout DML privileges.
grant select on table
  public.profiles,
  public.preferences,
  public.workout_plans,
  public.plan_exercises,
  public.workout_occurrences,
  public.workout_sessions,
  public.exercise_instances,
  public.operation_receipts,
  public.completed_sets,
  public.set_revisions,
  public.cardio_records,
  public.rest_timers,
  public.memories,
  public.exercise_day_credits,
  public.milestone_unlocks,
  public.import_batches,
  public.import_items,
  public.sync_conflicts
to service_role;
grant insert, update, delete on table
  public.profiles,
  public.preferences,
  public.workout_plans,
  public.plan_exercises,
  public.workout_occurrences,
  public.workout_sessions,
  public.exercise_instances,
  public.completed_sets,
  public.cardio_records,
  public.rest_timers,
  public.memories,
  public.sync_conflicts
to service_role;

revoke all on function public.claim_voice_session(uuid, integer, integer, integer) from public, anon, authenticated, service_role;
revoke all on function public.close_voice_session(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.attach_voice_call(uuid, text) from public, anon, authenticated, service_role;
revoke all on function public.claim_voice_session_for_user(uuid, uuid, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.close_voice_session_for_user(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.attach_voice_call_for_user(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.claim_operation_receipt(text, text, uuid, timestamptz, integer) from public, anon;
revoke all on function public.finish_operation_receipt(uuid, uuid, boolean, text, text, jsonb, text, timestamptz) from public, anon;
revoke all on function public.preview_legacy_import(jsonb, text) from public, anon;
revoke all on function public.import_legacy_progress(jsonb, text) from public, anon;
revoke all on function public.preview_account_restore(jsonb, text) from public, anon;
revoke all on function public.restore_account_data(jsonb, text) from public, anon;
revoke all on function public.export_account_data() from public, anon;
revoke all on function public.delete_current_account() from public, anon;
revoke all on function public.knufl_bump_version() from public, anon, authenticated;
revoke all on function public.knufl_capture_set_revision() from public, anon, authenticated;
revoke all on function public.knufl_award_completed_session() from public, anon, authenticated;
revoke all on function public.knufl_freeze_session_calendar_context() from public, anon, authenticated;
revoke all on function public.knufl_validate_cardio_session_context() from public, anon, authenticated;
revoke all on function public.knufl_freeze_operation_identity() from public, anon, authenticated;
revoke all on function public.knufl_strip_private_json(jsonb) from public, anon, authenticated;
revoke all on function public.knufl_account_snapshot(uuid) from public, anon, authenticated;
revoke all on function public.knufl_restore_snapshot(jsonb) from public, anon, authenticated;
grant execute on function public.claim_voice_session_for_user(uuid, uuid, integer, integer, integer) to service_role;
grant execute on function public.close_voice_session_for_user(uuid, uuid, text) to service_role;
grant execute on function public.attach_voice_call_for_user(uuid, uuid, text) to service_role;
grant execute on function public.claim_operation_receipt(text, text, uuid, timestamptz, integer) to authenticated;
grant execute on function public.finish_operation_receipt(uuid, uuid, boolean, text, text, jsonb, text, timestamptz) to authenticated;
grant execute on function public.preview_legacy_import(jsonb, text) to authenticated;
grant execute on function public.import_legacy_progress(jsonb, text) to authenticated;
grant execute on function public.preview_account_restore(jsonb, text) to authenticated;
grant execute on function public.restore_account_data(jsonb, text) to authenticated;
grant execute on function public.export_account_data() to authenticated;
grant execute on function public.delete_current_account() to authenticated;

comment on function public.claim_voice_session_for_user(uuid, uuid, integer, integer, integer) is
  'Worker-only: atomically applies a UTC-day Realtime budget and concurrent-session cap for an authenticated user validated by the Worker.';
comment on function public.close_voice_session_for_user(uuid, uuid, text) is
  'Worker-only: closes a validated user Realtime usage ledger and records actual elapsed usage.';
comment on function public.attach_voice_call_for_user(uuid, uuid, text) is
  'Worker-only: attaches the private OpenAI call ID to an active validated user ledger.';
comment on table public.voice_usage_sessions is
  'Worker-only Realtime metering metadata. Knufl does not persist raw audio or workout transcripts here.';

commit;
