# Knufl live-provider preview setup

Never put credentials in chat, issues, commits, screenshots or shell arguments. Use provider secret fields. This guide targets only the owner-private review deployment, not public GitHub Pages.

## Exact destinations

| Purpose | Destination |
| --- | --- |
| Private Cloudflare/Sites preview | https://knufl-voice-companion.alcain.chatgpt.site/ |
| Public prototype and legacy export | https://helloalexcain-bot.github.io/Knufl/ |
| Supabase project | https://supabase.com/dashboard/project/ntymjigywntaczxiqpdh |
| Supabase Auth providers | https://supabase.com/dashboard/project/ntymjigywntaczxiqpdh/auth/providers |
| Supabase URL configuration | https://supabase.com/dashboard/project/ntymjigywntaczxiqpdh/auth/url-configuration |
| Google/Apple provider callback | `https://ntymjigywntaczxiqpdh.supabase.co/auth/v1/callback` |

The Site URL and exact redirect allow-list entry are saved as `https://knufl-voice-companion.alcain.chatgpt.site/`. Knufl's browser client exchanges the PKCE code at `/`; do not use the Site's `/callback` path (that belongs to the outer Sites sign-in gate). For local OAuth, add only the actual dev server's exact root URL, e.g. `http://localhost:3000/`, not a wildcard.

The Sites owner gate and Supabase app account are separate sign-ins. On another device, first use the same Sites owner identity, then the same Knufl/Supabase account. Testing app account B does not require changing Site access.

## Completed configuration

- The owner created Knufl's new preview database, PostgreSQL 17 in Ireland.
- Migrations `202609050001` through `202609050004` are applied and recorded in Supabase migration history.
- The preview's Sites runtime holds `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and secret `SUPABASE_SERVICE_ROLE_KEY`. Runtime revisions take effect upon preview deployment.
- The independent one-second supervisor is installed. It refuses new voice calls until its Vault key is present and its heartbeat is healthy.
- A live check found that pg_net's broad queue grants belong to the platform superuser and cannot be revoked by the project role. Migration 004 replaces that transport with bounded synchronous HTTP; provider headers exist only in private backend memory, never in the shared queue. No real key was configured while pg_net transport was active.

## Smallest remaining account setup

### Google

1. Open [Google Auth Platform → Clients](https://console.cloud.google.com/auth/clients) in the intended Google Cloud project. Configure Branding/Audience if prompted; while the consent app is in Testing, add the intended Google email under Audience → Test users.
2. Create a **Web application** OAuth client with redirect URI exactly `https://ntymjigywntaczxiqpdh.supabase.co/auth/v1/callback`. Knufl uses Supabase's redirect flow, not Google One Tap.
3. Enter the client ID and secret directly into the Google provider at the Supabase destination above, enable it and save. Do not send the secret to Codex.
4. Tell Codex Google is ready. Codex can verify readiness, set the ordinary preview flag `KNUFL_AUTH_GOOGLE_ENABLED=true`, and redeploy privately. The button stays hidden until that step.

Reference: [Supabase Google OAuth](https://supabase.com/docs/guides/auth/social-login/auth-google).

### OpenAI

Enable the **OpenAI Developers** plugin if available so a key can be provisioned through its secure approval flow. That plugin was unavailable in this run. Manual alternative:

1. Use [OpenAI project API keys](https://platform.openai.com/api-keys) in the intended API project. Confirm existing billing/credit and access to `gpt-realtime-2.1`; review project data controls before a user pilot. Do not purchase services in this setup run.
2. Store the key in the **existing Knufl voice preview's Sites runtime settings** as secret `OPENAI_API_KEY`, never a `NEXT_PUBLIC_*` value. With the secure provisioning plugin, Codex can configure this without a chat exchange of the key.
3. Store the same project's key in Supabase → Integrations → Vault, named **`knufl_openai_api_key`**. Use Vault's secret-entry form, not a saved SQL query containing the key. Rotate both copies together.
4. Tell Codex both destinations are ready. Codex can apply the runtime revision, verify model/supervisor readiness, then test Realtime and provider hangup.

No database password, Supabase token or service-role key is still needed from the owner.

## Independent voice enforcement

The authenticated Worker atomically reserves budget. Supabase Cron—not a browser timer or request-scoped Worker—sweeps a private durable outbox every second and calls OpenAI's `POST /v1/realtime/calls/{call_id}/hangup` with a Vault-held key. Its `http` extension requests are bounded to two seconds each and five per sweep. It does not need a callback through the private Site gate, and never puts credentials into pg_net's shared queue.

| Ordinary runtime variable | Default | Bounds |
| --- | --- | --- |
| `KNUFL_REALTIME_MODEL` | `gpt-realtime-2.1` | Must be available to the API project |
| `KNUFL_REALTIME_VOICE` | `marin` | Provider-supported voice |
| `KNUFL_MAX_ACTIVE_REALTIME_SESSIONS` | `1` | 1–3 |
| `KNUFL_DAILY_REALTIME_MINUTES` | `60` | 1–240, UTC usage day |
| `KNUFL_MAX_REALTIME_SESSION_MINUTES` | `30` | 1–60 |

An active reservation holds its remaining duration. An expired deadline does not release an unconfirmed call; actual overruns are charged. Calls end no later than UTC midnight's scheduled deadline, and account start churn is capped at six claims/minute. Exercise-day credits still use the workout's local calendar day.

Failed hangups retry without releasing budget or concurrency. Cleanup survives account deletion. A missing/stale heartbeat or more than 15 seconds of overdue cleanup blocks new issuance. Browser expiry remains a UX safeguard.

This is independent enforcement, **not hard real-time**: scheduler/HTTP/provider outages can delay termination. A creation request that times out before returning a call ID remains reserved for operator reconciliation. SDP is never delivered without a durably attached call ID. Reconcile unknown calls through provider request logs before clearing reservations; do not clear the ledger merely to make the UI work.

Operator read-only SQL (no secrets):

```sql
select public.voice_supervisor_status();
select session_id, due_at, requested_at, attempts, confirmed_at, last_status
from knufl_private.voice_hangups order by due_at desc limit 20;
select id, status, started_at, expires_at, ended_at
from public.voice_usage_sessions order by started_at desc limit 20;
```

Require `healthy=true`, `providerKeyReady=true`, `overdueCalls=0` and successful Cron runs before enabling voice. Monitor outstanding hangups and bound operational-log retention. Knufl persists no raw microphone audio or full transcripts; OpenAI processes audio under that API project's settings.

## Automated verification

```bash
npm test
npm run test:db:local
npm run lint
npx tsc --noEmit --incremental false
npm run build
npm run build:pages
```

After normal authenticated Supabase CLI login:

```bash
npm run test:db:live
npm run test:live:preview
```

- `test:db:local`: real PostgreSQL/PGlite; simulated Auth, pgTAP assertions, Cron, Vault and HTTP. Not hosted-provider verification.
- `test:db:live`: real hosted pgTAP; verifies failure propagation with an intentionally failing assertion first. All fixtures roll back. Supervisor 503/200 HTTP responses are **simulated** by a transaction-local replacement of the private transport, installed before any test sweep. No test request reaches OpenAI.
- `test:live:preview`: real Auth, separate access tokens, RLS/PostgREST and the actual Worker HTTP handler with service-role writes. Creates two disposable confirmed accounts, sends no emails, and deletes only its own test accounts/data. No mock fetch or OpenAI call.
- Deployed variant: `npm run test:live:preview -- --origin https://knufl-voice-companion.alcain.chatgpt.site`. The agent supplies the already-authorized Site access credential over **hidden stdin**, never arguments/chat; access is unchanged. This tests the published Worker, cross-account IDs/owner injection, corrections, recovery and day credits.
- `npm run check:providers`: uses ignored `.env.local` or secure process environment to read supervisor status and OpenAI model visibility. Prints no keys. It does not verify OAuth, media or physical devices.

## Short physical-iPhone / second-profile script

Use disposable workout data, not the development demonstrator. Run after Google and OpenAI are configured.

1. In iPhone Safari open the private preview, pass the owner gate, sign in with Google and name the companion **Pip**. The character must remain labelled a development demonstrator; the production rig is still missing.
2. Enable microphone after the processing disclosure. Say **“Plan three sets of bench press, eight reps at sixty kilograms total, with ninety seconds rest.”** Confirm the plan. Verify **zero completed sets** before reporting completed work.
3. Say **“I completed eight reps at sixty kilograms total”**, then **“Correct that to six reps.”** Verify one set, six reps, same ID/audit history. Say **“Start a ninety-second rest.”** Reload: same end time, not a new ninety seconds.
4. Ask **“What is my bench-press progress today?”** The answer must use the saved six-rep set and acknowledge insufficient history for an improvement comparison. Interrupt a reply; test mute and push-to-talk. A spoken acknowledgement without a saved receipt is not success.
5. On another device/isolated browser profile, pass the **same owner gate** and use the **same Google account**. Verify Pip, the corrected set and saved timer. Returning focus/online on device one must refresh cloud facts. Then use app account B: A's data must be absent. Automated Worker attacks complement this UI check.
6. For a separate limit test, the operator temporarily sets the preview maximum session to **one minute**. Connect voice; a concurrent session on device two must be denied. Put device one in airplane mode before expiry without pressing End. After the deadline, the operator must observe outbox confirmation/provider success and ledger closure. Client UI stopping alone is insufficient. Test minute-budget denial with temporary limits, then restore normal settings.
7. Check speaker/headphones, lock/unlock and reconnect. Record Safari/background limitations; desktop tests cannot establish background audio, Bluetooth or native/PWA behaviour.

## Apple: configuration-ready, not live-verified

Use [Apple Developer → Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list) with the intended existing membership. Configure a primary App ID with Sign in with Apple, linked **Services ID** and signing key. Do not purchase membership here.

- Domain: `ntymjigywntaczxiqpdh.supabase.co`.
- Return URL: `https://ntymjigywntaczxiqpdh.supabase.co/auth/v1/callback`.
- Enter Services ID/client secret directly in Supabase's Apple provider. Keep the `.p8` key secure; rotate the client secret before its six-month expiry.
- After real verification, enable `KNUFL_AUTH_APPLE_ENABLED=true` and deploy the runtime revision. It stays false until ready. Never merge private-relay accounts by guessed email.

Reference: [Supabase Apple OAuth](https://supabase.com/docs/guides/auth/social-login/auth-apple).

## Existing progress

Export JSON from localhost or the public prototype's Settings, transfer the file to the phone if needed, then import into the signed-in cloud preview. Name, session/memory links and earned unlocks are preserved; legacy identity fields are discarded. Browser data does not move automatically. After cloud import, sign into that same account for ordinary cross-device recovery. Version-2 restore to a different account is disaster recovery only after source account data is removed; never delete a real account for a routine sync test.
