-- Durable server-side hangup. Supabase Cron runs this independently of the
-- browser and the Cloudflare request. No callback through the private Site gate.
begin;
create extension if not exists pg_cron;
create extension if not exists pg_net;
create extension if not exists supabase_vault;

create schema if not exists knufl_private;
revoke all on schema knufl_private from public, anon, authenticated, service_role;

create table knufl_private.voice_supervisor_health (
  singleton boolean primary key default true check (singleton),
  last_tick_at timestamptz,
  provider_key_ready boolean not null default false
);
insert into knufl_private.voice_supervisor_health(singleton) values (true);

-- Deliberately no cascading FK: deleting an account must not discard a live
-- provider call before it has been terminated. Only minimal call metadata lives here.
create table knufl_private.voice_hangups (
  session_id uuid primary key,
  call_id text not null unique check (call_id ~ '^[A-Za-z0-9_-]{1,200}$'),
  due_at timestamptz not null,
  request_id bigint,
  requested_at timestamptz,
  attempts integer not null default 0,
  confirmed_at timestamptz,
  last_status integer
);
create index voice_hangups_due_idx on knufl_private.voice_hangups(due_at)
  where confirmed_at is null;
revoke all on all tables in schema knufl_private from public, anon, authenticated, service_role;

-- Recover calls issued by the previous preview, whose ledger could mark an
-- expired/closed row before a remote hangup was acknowledged.
insert into knufl_private.voice_hangups(session_id, call_id, due_at)
select id, openai_call_id, least(expires_at, clock_timestamp()) from public.voice_usage_sessions
where openai_call_id ~ '^[A-Za-z0-9_-]{1,200}$' and started_at > clock_timestamp() - interval '1 day'
on conflict do nothing;

create function public.voice_supervisor_status()
returns jsonb language sql security definer
set search_path = pg_catalog, knufl_private, pg_temp as $$
  select jsonb_build_object(
    'healthy', coalesce(last_tick_at > clock_timestamp() - interval '15 seconds', false)
      and provider_key_ready,
    'lastTickAt', last_tick_at,
    'providerKeyReady', provider_key_ready,
    'overdueCalls', (select count(*) from knufl_private.voice_hangups
      where confirmed_at is null and due_at < clock_timestamp() - interval '15 seconds')
  ) from knufl_private.voice_supervisor_health where singleton;
$$;
revoke all on function public.voice_supervisor_status() from public, anon, authenticated;
grant execute on function public.voice_supervisor_status() to service_role;

create or replace function public.claim_voice_session_for_user(
  p_user_id uuid, p_session_id uuid, p_daily_minutes integer,
  p_concurrent_limit integer, p_max_session_minutes integer default 30
)
returns table(allowed boolean, reason text, session_id uuid, active_count integer,
  used_seconds integer, remaining_seconds integer, expires_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare
  request_time timestamptz := clock_timestamp();
  day_start timestamptz := date_trunc('day', request_time at time zone 'UTC') at time zone 'UTC';
  day_end timestamptz := day_start + interval '1 day';
  used integer; committed integer; active integer; remaining integer;
  requested_expiry timestamptz;
  existing public.voice_usage_sessions%rowtype;
begin
  if p_user_id is null or p_session_id is null
    or p_daily_minutes is null or p_daily_minutes not between 1 and 240
    or p_concurrent_limit is null or p_concurrent_limit not between 1 and 3
    or p_max_session_minutes is null or p_max_session_minutes not between 1 and 60 then
    raise exception 'Invalid voice budget limits' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 5796621));
  -- Fail closed when the independently scheduled supervisor or its key is absent.
  if not coalesce((public.voice_supervisor_status()->>'healthy')::boolean, false)
    or (public.voice_supervisor_status()->>'overdueCalls')::integer > 0 then
    return query select false, 'supervisor_unavailable', p_session_id, 0, 0, 0, null::timestamptz;
    return;
  end if;
  select * into existing from public.voice_usage_sessions where id = p_session_id;
  if found then
    return query select false,
      case when existing.user_id <> p_user_id then 'session_id_unavailable'
        when existing.status = 'active' then 'already_claimed' else 'session_closed' end,
      p_session_id, 0, 0, 0, null::timestamptz;
    return;
  end if;
  -- An expired deadline is NOT evidence that the remote call ended. Outstanding
  -- calls retain their slot and continue accruing usage until confirmed closed.
  select count(*)::integer into active from public.voice_usage_sessions
    where user_id = p_user_id and status = 'active';
  select coalesce(ceil(sum(greatest(0, extract(epoch from (
    least(coalesce(v.ended_at, request_time), day_end) - greatest(v.started_at, day_start)
  )))))::integer, 0) into used from public.voice_usage_sessions v
    where v.user_id = p_user_id and v.started_at < day_end
      and coalesce(v.ended_at, request_time) > day_start;
  select coalesce(ceil(sum(greatest(0, extract(epoch from (
    least(case when v.status = 'active' then greatest(v.expires_at, request_time)
      else v.ended_at end, day_end) - greatest(v.started_at, day_start)
  )))))::integer, 0) into committed from public.voice_usage_sessions v
    where v.user_id = p_user_id and v.started_at < day_end;
  remaining := greatest(0, p_daily_minutes * 60 - committed);
  if active >= p_concurrent_limit then
    return query select false, 'concurrent_limit', p_session_id, active, used, remaining, null::timestamptz;
    return;
  end if;
  -- Prevent rapid failed-handshake/stop/start churn as well as concurrent abuse.
  if (select count(*) from public.voice_usage_sessions where user_id = p_user_id
      and started_at > request_time - interval '1 minute') >= 6 then
    return query select false, 'start_rate_limit', p_session_id, active, used, remaining, null::timestamptz;
    return;
  end if;
  if remaining <= 0 then
    return query select false, 'daily_budget_exhausted', p_session_id, active, used, 0, null::timestamptz;
    return;
  end if;
  -- End at UTC midnight so an existing reservation cannot escape the next day's budget.
  requested_expiry := least(day_end, request_time + make_interval(secs => least(p_max_session_minutes * 60, remaining)));
  insert into public.voice_usage_sessions(id, user_id, started_at, expires_at)
    values (p_session_id, p_user_id, request_time, requested_expiry);
  return query select true, 'allowed', p_session_id, active + 1, used, remaining, requested_expiry;
end;
$$;

create or replace function public.attach_voice_call_for_user(
  p_user_id uuid, p_session_id uuid, p_openai_call_id text
)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
declare usage_row public.voice_usage_sessions%rowtype;
begin
  if p_user_id is null or p_openai_call_id is null
    or p_openai_call_id !~ '^[A-Za-z0-9_-]{1,200}$' then
    raise exception 'Invalid voice call identity' using errcode = '22023';
  end if;
  select * into usage_row from public.voice_usage_sessions
    where id = p_session_id and user_id = p_user_id for update;
  if not found or usage_row.status <> 'active'
    or (usage_row.openai_call_id is not null and usage_row.openai_call_id <> p_openai_call_id) then
    return false;
  end if;
  update public.voice_usage_sessions set openai_call_id = p_openai_call_id where id = p_session_id;
  insert into knufl_private.voice_hangups(session_id, call_id, due_at)
    values (p_session_id, p_openai_call_id, usage_row.expires_at)
    on conflict (session_id) do nothing;
  -- Always retain a late provider response for cleanup, but never return its SDP.
  return usage_row.expires_at > clock_timestamp();
end;
$$;

create function public.request_voice_close_for_user(p_user_id uuid, p_session_id uuid)
returns boolean language plpgsql security definer
set search_path = pg_catalog, public, pg_temp as $$
begin
  update knufl_private.voice_hangups h set due_at = least(h.due_at, clock_timestamp())
    from public.voice_usage_sessions v
    where v.id = p_session_id and v.user_id = p_user_id and h.session_id = v.id;
  return found;
end;
$$;
revoke all on function public.request_voice_close_for_user(uuid,uuid) from public, anon, authenticated;
grant execute on function public.request_voice_close_for_user(uuid,uuid) to service_role;

-- A service caller may acknowledge closure only for the exact persisted call.
-- Passing null is allowed solely for a reservation with no issued provider call.
create or replace function public.close_voice_session_for_user(
  p_user_id uuid, p_session_id uuid, p_openai_call_id text default null
)
returns table(closed boolean, session_id uuid, used_seconds integer)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp as $$
declare v public.voice_usage_sessions%rowtype; finished timestamptz := clock_timestamp();
begin
  select * into v from public.voice_usage_sessions
    where id = p_session_id and user_id = p_user_id for update;
  if not found or v.openai_call_id is distinct from p_openai_call_id then
    return query select false, p_session_id, 0; return;
  end if;
  if v.status = 'active' then
    update public.voice_usage_sessions set status = 'closed', ended_at = finished where id = v.id;
    update knufl_private.voice_hangups set confirmed_at = finished
      where knufl_private.voice_hangups.session_id = v.id and confirmed_at is null;
  end if;
  return query select true, v.id,
    greatest(0, ceil(extract(epoch from (coalesce(v.ended_at, finished) - v.started_at)))::integer);
end;
$$;

create function knufl_private.retain_deleted_voice_call()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  update knufl_private.voice_hangups set due_at = least(due_at, clock_timestamp())
    where session_id = old.id and confirmed_at is null;
  return old;
end;
$$;
create trigger retain_deleted_voice_call before delete on public.voice_usage_sessions
  for each row execute function knufl_private.retain_deleted_voice_call();

create function knufl_private.supervise_voice_calls()
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  api_key text; job record; result record; tick timestamptz := clock_timestamp();
  request bigint;
begin
  -- One bounded sweep at a time, including manual runs. Never log headers or keys.
  if not pg_try_advisory_xact_lock(5796621002) then return; end if;
  select decrypted_secret into api_key from vault.decrypted_secrets
    where name = 'knufl_openai_api_key' limit 1;
  update knufl_private.voice_supervisor_health set last_tick_at = tick,
    provider_key_ready = coalesce(length(api_key) > 0, false) where singleton;

  for job in select * from knufl_private.voice_hangups
      where confirmed_at is null and due_at <= tick order by due_at limit 50 for update skip locked loop
    if job.request_id is not null then
      select status_code, timed_out into result from net._http_response where id = job.request_id;
      if found and not coalesce(result.timed_out, false)
        and (result.status_code between 200 and 299 or result.status_code in (404,410)) then
        update knufl_private.voice_hangups set confirmed_at = tick, last_status = result.status_code
          where session_id = job.session_id;
        update public.voice_usage_sessions set status = 'closed', ended_at = tick
          where id = job.session_id and status = 'active';
        continue;
      end if;
      if not found and job.requested_at > tick - interval '15 seconds' then continue; end if;
      update knufl_private.voice_hangups set last_status = result.status_code where session_id = job.session_id;
      -- Retry failures without giving back the concurrent slot or budget.
      if job.requested_at > tick - interval '5 seconds' then continue; end if;
    end if;
    if coalesce(length(api_key),0) = 0 then continue; end if;
    select net.http_post(
      url := 'https://api.openai.com/v1/realtime/calls/' || job.call_id || '/hangup',
      headers := jsonb_build_object('Authorization','Bearer ' || api_key,'Content-Type','application/json'),
      body := '{}'::jsonb, timeout_milliseconds := 5000
    ) into request;
    update knufl_private.voice_hangups set request_id = request, requested_at = tick, attempts = attempts + 1
      where session_id = job.session_id;
  end loop;
  -- Only acknowledged minimal metadata is removed. Outstanding calls survive indefinitely.
  delete from knufl_private.voice_hangups where confirmed_at < tick - interval '1 day';
end;
$$;
revoke all on all functions in schema knufl_private from public, anon, authenticated, service_role;
select cron.schedule('knufl-voice-supervisor', '1 second', 'select knufl_private.supervise_voice_calls()');

comment on table knufl_private.voice_hangups is
  'Durable remote-call hangup outbox, including account-deletion cleanup. No audio or transcripts.';
commit;
