-- Issuance and independent hangup must use the same configured project key.
-- A wrong Vault project could otherwise mistake a 404 for a closed call.
begin;
create function public.voice_provider_key_matches(p_user_id uuid,p_fingerprint text)
returns boolean language sql security definer set search_path=pg_catalog,pg_temp as $$
  select p_user_id is not null and p_fingerprint ~ '^[a-f0-9]{64}$' and exists(
    select 1 from vault.decrypted_secrets where name='knufl_openai_api_key'
      and encode(sha256(convert_to(decrypted_secret,'UTF8')),'hex')=p_fingerprint
  );
$$;
revoke all on function public.voice_provider_key_matches(uuid,text) from public,anon,authenticated;
grant execute on function public.voice_provider_key_matches(uuid,text) to service_role;
commit;
