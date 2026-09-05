-- The hosted http build accepts http_set_curlopt but silently ignores newer
-- http.curlopt_* GUC placeholders. Use the extension's compatible API so a
-- timeout is actually two seconds (verified with a live no-credential probe).
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
  perform extensions.http_set_curlopt('CURLOPT_TIMEOUT_MS','2000');
  perform extensions.http_set_curlopt('CURLOPT_CONNECTTIMEOUT_MS','1000');
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
commit;
