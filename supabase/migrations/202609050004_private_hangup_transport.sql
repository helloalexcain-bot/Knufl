-- Hosted pg_net's PUBLIC queue grant belongs to supabase_admin: project-level
-- REVOKE cannot remove it. Do not place provider credentials in that queue.
-- Use bounded synchronous HTTP inside the independently scheduled supervisor;
-- the private durable outbox contains call metadata only, never request headers.
begin;
create extension if not exists http with schema extensions;

create function knufl_private.hangup_provider_call(p_call_id text)
returns integer language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare api_key text; provider_status integer;
begin
  if p_call_id is null or p_call_id !~ '^[A-Za-z0-9_-]{1,200}$' then return null; end if;
  select decrypted_secret into api_key from vault.decrypted_secrets
    where name='knufl_openai_api_key' limit 1;
  if coalesce(length(api_key),0)=0 then return null; end if;
  -- Never persist/log headers. Bound each request and retain TLS verification.
  perform extensions.http_reset_curlopt();
  perform set_config('http.curlopt_timeout_ms','2000',true);
  perform set_config('http.curlopt_connecttimeout_ms','1000',true);
  perform set_config('http.curlopt_ssl_verifypeer','1',true);
  perform set_config('http.curlopt_ssl_verifyhost','2',true);
  select h.status into provider_status from extensions.http((
    'POST', 'https://api.openai.com/v1/realtime/calls/' || p_call_id || '/hangup',
    array[('Authorization','Bearer ' || api_key)::extensions.http_header],
    'application/json', '{}'
  )::extensions.http_request) h;
  return provider_status;
exception when others then
  -- A timeout is not closure. Do not surface provider payloads or diagnostics.
  return null;
end;
$$;
revoke all on function knufl_private.hangup_provider_call(text)
  from public,anon,authenticated,service_role;

create or replace function knufl_private.supervise_voice_calls()
returns void language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare job record; provider_status integer; tick timestamptz:=clock_timestamp();
begin
  if not pg_try_advisory_xact_lock(5796621002) then return; end if;
  update knufl_private.voice_supervisor_health set last_tick_at=tick,
    provider_key_ready=exists(select 1 from vault.decrypted_secrets
      where name='knufl_openai_api_key' and length(decrypted_secret)>0) where singleton;
  -- At most five requests, each bounded to two seconds. Other calls remain
  -- reserved and are picked up by subsequent sweeps; overloaded cleanup fails closed.
  for job in select * from knufl_private.voice_hangups
    where confirmed_at is null and due_at<=tick
      and (requested_at is null or requested_at<=tick-interval '5 seconds')
    order by due_at limit 5 for update skip locked loop
    provider_status:=knufl_private.hangup_provider_call(job.call_id);
    update knufl_private.voice_hangups set requested_at=clock_timestamp(),request_id=null,
      attempts=attempts+1,last_status=provider_status where session_id=job.session_id;
    if provider_status between 200 and 299 or provider_status in (404,410) then
      update knufl_private.voice_hangups set confirmed_at=clock_timestamp()
        where session_id=job.session_id;
      update public.voice_usage_sessions set status='closed',ended_at=clock_timestamp()
        where id=job.session_id and status='active';
    end if;
  end loop;
  delete from knufl_private.voice_hangups where confirmed_at<tick-interval '1 day';
end;
$$;
revoke all on function knufl_private.supervise_voice_calls()
  from public,anon,authenticated,service_role;
update knufl_private.voice_supervisor_health set last_tick_at=null,provider_key_ready=false;
comment on function knufl_private.hangup_provider_call(text) is
  'Bounded provider HTTP; credentials exist only in backend memory, never in the PUBLIC pg_net queue.';
commit;
