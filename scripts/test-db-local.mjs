import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();

try {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    create schema auth;
    create schema extensions;
    create table auth.users(
      instance_id uuid,
      id uuid primary key,
      aud text,
      role text,
      email text,
      encrypted_password text,
      email_confirmed_at timestamptz,
      raw_app_meta_data jsonb,
      raw_user_meta_data jsonb,
      created_at timestamptz,
      updated_at timestamptz
    );
    create function auth.uid() returns uuid language sql stable as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub'
      )::uuid
    $$;
    grant usage on schema auth to authenticated, service_role;
    grant execute on function auth.uid() to authenticated, service_role;

    create function public.plan(integer) returns text language sql as
      $$ select 'plan'::text $$;
    create function public.ok(boolean, text) returns text language plpgsql as $$
    begin
      if $1 is not true then
        raise exception 'pgTAP ok failed: %', $2;
      end if;
      return 'ok';
    end;
    $$;
    create function public.is(anyelement, anyelement, text) returns text language plpgsql as $$
    begin
      if $1 is distinct from $2 then
        raise exception 'pgTAP is failed: % (actual %, expected %)', $3, $1, $2;
      end if;
      return 'ok';
    end;
    $$;
    create function public.hasnt_column(text, text, text, text) returns text language plpgsql as $$
    begin
      if exists (
        select 1 from information_schema.columns
        where table_schema = $1 and table_name = $2 and column_name = $3
      ) then
        raise exception 'pgTAP hasnt_column failed: %', $4;
      end if;
      return 'ok';
    end;
    $$;
    create function public.throws_ok(text, text, text, text) returns text language plpgsql as $$
    declare
      caught_state text;
      caught_message text;
    begin
      begin
        execute $1;
      exception when others then
        get stacked diagnostics
          caught_state = returned_sqlstate,
          caught_message = message_text;
        if caught_state <> $2 or ($3 is not null and caught_message <> $3) then
          raise exception 'pgTAP throws_ok failed: % (state %, message %)', $4, caught_state, caught_message;
        end if;
        return 'ok';
      end;
      raise exception 'pgTAP throws_ok failed: % (no exception)', $4;
    end;
    $$;
    create function public.finish(boolean default false) returns setof text language sql as
      $$ select 'ok'::text where false $$;
  `);


  // PGlite executes real PostgreSQL SQL/RLS; hosted extensions and Auth are
  // explicitly simulated. This is not a live Supabase or pgTAP-extension run.
  await db.exec(`
    create schema cron;
    create table cron.job(jobname text primary key, schedule text, command text, active boolean default true);
    create function cron.schedule(text,text,text) returns bigint language plpgsql as $$
      begin insert into cron.job values($1,$2,$3,true) on conflict(jobname) do update set schedule=$2,command=$3;
      return 1; end $$;
    create schema vault;
    create table vault.decrypted_secrets(name text primary key, decrypted_secret text);
    insert into vault.decrypted_secrets values('knufl_openai_api_key','test-key-no-live-provider');
    create function vault.create_secret(text,text,text default null) returns uuid language plpgsql as $$
      begin insert into vault.decrypted_secrets values($2,$1); return gen_random_uuid(); end $$;
    create schema net;
    create table net.http_request_queue(id bigint generated always as identity, url text, headers jsonb, body jsonb);
    create table net._http_response(id bigint, status_code integer, timed_out boolean);
    -- Match the broad hosted pg_net defaults that migration 003 must revoke.
    grant usage on schema net to public, anon, authenticated, service_role;
    grant select on net.http_request_queue to public, anon, authenticated, service_role;
    create function net.http_post(url text, body jsonb default '{}'::jsonb,
      params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000)
      returns bigint language plpgsql as $$ declare r bigint; begin
        insert into net.http_request_queue(url,headers,body) values($1,$4,$2) returning id into r;
        return r; end $$;
  `);
  for (const name of (await readdir('supabase/migrations')).filter(n=>n.endsWith('.sql')).sort()) {
    const sql = (await readFile('supabase/migrations/' + name,'utf8'))
      .replace(/^create extension[^;]*;/gm, '');
    await db.exec(sql);
  }
  for (const name of (await readdir('supabase/tests')).filter(n=>n.endsWith('.sql')).sort()) {
    const sql = (await readFile('supabase/tests/' + name,'utf8'))
      .replace(/^create extension[^;]*;/gm, '');
    const results = await db.exec(sql);
    const assertions = results.flatMap(r=>r.rows).filter(r=>Object.values(r).includes('ok')).length;
    const planned = Number(sql.match(/select plan\((\d+)\)/i)?.[1]);
    if (assertions !== planned) throw new Error(name + ': assertion count differs from plan');
    console.log('[local PostgreSQL; simulated Auth/extensions] ' + name + ': ' + assertions + ' assertions passed.');
  }
} catch (error) {
  console.error('Database check failed:', error.message, error.where ?? '', error.position ?? '');
  process.exitCode = 1;
} finally {
  await db.close();
}
