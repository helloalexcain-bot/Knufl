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
| Google Cloud OAuth clients (`knufl-preview`) | https://console.cloud.google.com/auth/clients?project=knufl-preview |
| Google OAuth test users | https://console.cloud.google.com/auth/audience?project=knufl-preview |
| OpenAI project API keys (select **Knufl**) | https://platform.openai.com/api-keys |
| Supabase Vault | https://supabase.com/dashboard/project/ntymjigywntaczxiqpdh/integrations/vault/secrets |
| Google/Apple provider callback | `https://ntymjigywntaczxiqpdh.supabase.co/auth/v1/callback` |

The Site URL and exact redirect allow-list entry are saved as `https://knufl-voice-companion.alcain.chatgpt.site/`. Knufl's browser client exchanges the PKCE code at `/`; do not use the Site's `/callback` path (that belongs to the outer Sites sign-in gate). For local OAuth, add only the actual dev server's exact root URL, e.g. `http://localhost:3000/`, not a wildcard.

The Sites owner gate and Supabase app account are separate sign-ins. On another device, first use the same Sites owner identity, then the same Knufl/Supabase account. Testing app account B does not require changing Site access.

## Completed configuration

- The owner created Knufl's new preview database, PostgreSQL 17 in Ireland.
- Migrations `202609050001` through `202609050007` are applied and recorded in Supabase migration history.
- The preview's Sites runtime holds `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and secret `SUPABASE_SERVICE_ROLE_KEY`. Runtime revisions take effect upon preview deployment.
- Google OAuth is configured in the dedicated **Knufl Preview** Cloud project (`knufl-preview`), using the **Knufl Preview Web** client. The owner accepted Google's required user-data policy. No billing or free trial was enabled.
- The Google client permits only the preview origin `https://knufl-voice-companion.alcain.chatgpt.site` and the Supabase callback above. Its secret was transferred directly into Supabase, not written to the repository or chat. Nonce checks remain enabled and email remains required.
- `KNUFL_AUTH_GOOGLE_ENABLED=true` is live in preview runtime revision 2. On 5 September 2026, real Google consent, the Supabase callback, signed-in cloud onboarding and session persistence after refresh all passed in Chrome. The owner's import choice was left untouched. This does not establish physical-iPhone or cross-device OAuth verification.
- Following Google setup, all 13 deployed integration groups passed again, including privileged cross-account mutation checks; both disposable accounts and their records were removed. All 96 unit/contract tests, lint and TypeScript passed. Signed-in onboarding was inspected at 390×844 and 1280×900, with no captured browser warnings/errors. OpenAI tests remain simulated, not live-provider evidence.
- The independent one-second supervisor is installed. It refuses new voice calls until its Vault key is present and its heartbeat is healthy.
- A live check found that pg_net's broad queue grants belong to the platform superuser and cannot be revoked by the project role. Migration 004 replaces that transport with bounded synchronous HTTP; provider headers exist only in private backend memory, never in the shared queue. No real key was configured while pg_net transport was active.

## Smallest remaining account setup

### Google — complete for the owner's preview

No further Google credential setup is needed. Use **Continue with Google** on the private preview, with the owner's configured test account. The consent app remains **External / Testing**, with one owner test user. Its configured scopes are only `openid`, `userinfo.email` and `userinfo.profile`; there are no sensitive or restricted scopes.

The Google screen currently identifies the Supabase project domain rather than a verified Knufl brand. Public brand verification is not complete: Google still flags incomplete branding, and public privacy/terms links remain unset. This did not block the observed test-account sign-in. Do not publish the OAuth app or broaden its test audience in this preview pass. An additional device can use the same Google test account after passing the unchanged Sites owner gate.

For maintenance, use the Google client and audience destinations above. Rotate the client secret directly in Supabase's Google provider if necessary. Knufl uses Supabase's redirect flow, not Google One Tap. Preserve the exact callback; never replace it with the private Site's `/callback` route.

Reference: [Supabase Google OAuth](https://supabase.com/docs/guides/auth/social-login/auth-google).

### OpenAI — credentials configured; media verification separate

The **Knufl** OpenAI project (`proj_r9lbqvj4xUy6PihoRvv7hzSj`) now has a dedicated restricted **Knufl Preview Realtime** key, allowing only model reads and Realtime requests. The secure provisioning plugin was unavailable; the owner-authorised browser flow transferred the key directly into the preview's secret `OPENAI_API_KEY` and Supabase Vault's `knufl_openai_api_key`. Neither key was written to source or chat. No further credential entry is needed. Rotate both copies together.

Live model access returned HTTP 200, including a request from the database. The actual private hangup function returned HTTP 404 for a deliberately nonexistent call in 5,857 ms after migration 007. This verifies authenticated transport, **not termination of an active call**. The owner explicitly authorised brief paid tests and the account's existing auto-reload; no billing configuration was changed. Review the project's data controls before a broader user pilot.

No database password, Supabase token or service-role key is still needed from the owner.

## Independent voice enforcement

The authenticated Worker atomically reserves budget. Supabase Cron—not a browser timer or request-scoped Worker—sweeps a private durable outbox every second and calls OpenAI's `POST /v1/realtime/calls/{call_id}/hangup` with a Vault-held key. Its `http` extension requests are bounded to eight seconds each and one per sweep, so a slow batch cannot consume five consecutive timeout windows. It does not need a callback through the private Site gate, and never puts credentials into pg_net's shared queue.

| Ordinary runtime variable | Default | Bounds |
| --- | --- | --- |
| `KNUFL_REALTIME_MODEL` | `gpt-realtime-2.1` | Must be available to the API project |
| `KNUFL_REALTIME_VOICE` | `marin` | Provider-supported voice |
| `KNUFL_MAX_ACTIVE_REALTIME_SESSIONS` | `1` | 1–3 |
| `KNUFL_DAILY_REALTIME_MINUTES` | `60` | 1–240, UTC usage day |
| `KNUFL_MAX_REALTIME_SESSION_MINUTES` | `30` | 1–60 |

An active reservation holds its remaining duration. An expired deadline does not release an unconfirmed call; actual overruns are charged. Calls end no later than UTC midnight's scheduled deadline, and account start churn is capped at six claims/minute. Exercise-day credits still use the workout's local calendar day.

Failed hangups retry without releasing budget or concurrency. Cleanup survives account deletion. A missing/stale heartbeat or more than 15 seconds of overdue cleanup blocks new issuance. Before calling OpenAI, the Worker also verifies that its key fingerprint matches the Vault key; mismatched projects cannot accidentally treat another project's 404 as closure. Rotate both key copies together and do not change API projects while calls remain outstanding. Browser expiry remains a UX safeguard.

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

Live transport finding: OpenAI's absent-call hangup response took more than five seconds, exceeding the original two-second database and five-second Worker limits. Migration 007 and the Worker now allow eight seconds; the supervisor processes only one request per sweep. Migration 005's `http_set_curlopt` compatibility fix remains necessary because this hosted extension ignores newer timeout GUC names. Authenticated database egress to OpenAI works; the original timeout was not evidence of an egress block.

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
