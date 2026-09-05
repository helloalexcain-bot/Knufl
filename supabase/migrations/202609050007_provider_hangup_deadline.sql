-- Live OpenAI returns an absent-call 404 after approximately five seconds.
-- Allow that acknowledgement without allowing a sweep to block the heartbeat
-- for five requests in succession. Failed/queued calls retain their reservation.
begin;
create or replace function knufl_private.hangup_provider_call(p_call_id text)
returns integer language plpgsql security definer set search_path=pg_catalog,pg_temp as $$
declare api_key text; provider_status integer;
begin
  if p_call_id is null or p_call_id !~ '^[A-Za-z0-9_-]{1,200}$' then return null; end if;
  select decrypted_secret into api_key from vault.decrypted_secrets
    where name='knufl_openai_api_key' limit 1;
  if coalesce(length(api_key),0)=0 then return null; end if;
  perform extensions.http_reset_curlopt();
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS','8000');
  perform extensions.http_set_curlopt('CURLOPT_CONNECTTIMEOUT_MS','3000');
  perform extensions.http_set_curlopt('CURLOPT_SSL_VERIFYPEER','1');
  perform extensions.http_set_curlopt('CURLOPT_SSL_VERIFYHOST','2');
  select h.status into provider_status from extensions.http((
    'POST', 'https://api.openai.com/v1/realtime/calls/' || p_call_id || '/hangup',
    array[('Authorization','Bearer ' || api_key)::extensions.http_header],
    'application/json', '{}'
  )::extensions.http_request) h;
  return provider_status;
exception when others then return null;
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
  -- One request, bounded to eight seconds: below the 15-second stale threshold.
  -- Subsequent sweeps process the backlog; overdue cleanup blocks new issuance.
  for job in select * from knufl_private.voice_hangups
    where confirmed_at is null and due_at<=tick
      and (requested_at is null or requested_at<=tick-interval '5 seconds')
    order by due_at limit 1 for update skip locked loop
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
commit;
