-- Hosted pg_net defaults grant browser roles access to the HTTP queue. Its
-- headers briefly contain the supervisor bearer key, so deny those roles even
-- if a future deployment exposes another schema/RPC. Only the postgres-owned
-- SECURITY DEFINER supervisor needs these resources.
begin;
revoke all on schema net from public, anon, authenticated, service_role;
revoke all on net.http_request_queue, net._http_response
  from public, anon, authenticated, service_role;
revoke all on vault.decrypted_secrets from public, anon, authenticated, service_role;
commit;
