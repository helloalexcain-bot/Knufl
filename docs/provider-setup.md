# Provider setup for a live Knufl preview

Do not paste credentials into an issue, commit or chat. Add them in the Supabase and Cloudflare/Sites dashboards.

## 1. Supabase

1. Create a Supabase project in the intended region.
2. Run `supabase/migrations/202609050001_voice_companion.sql` in a disposable preview project first, then apply it to the review project.
3. Copy the project URL and publishable/anon key into the preview runtime as `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
4. Enable Google and/or Apple in Supabase Auth only after configuring the provider credentials and every exact callback URL shown by Supabase.
5. Set `KNUFL_AUTH_GOOGLE_ENABLED=true` or `KNUFL_AUTH_APPLE_ENABLED=true` only for providers that are ready. Set `KNUFL_AUTH_EMAIL_OTP_ENABLED=true` only if email OTP delivery is configured.
6. Add the final Cloudflare preview URL and local development URL to the Supabase redirect allow-list. Do not merge Apple private-relay accounts by guessed email.

Apple web OAuth additionally needs an Apple Services ID and a client secret that is rotated before its six-month expiry.

## 2. Cloudflare preview runtime

Set `OPENAI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` as Worker-only secrets. Never use the service-role key in a `NEXT_PUBLIC_*` variable or client code. The Worker validates the Supabase bearer first, derives the owner itself, and then uses the service role only for owner-filtered workout mutations and service-role-only voice-ledger RPCs. Owner-scoped reads, profile/preferences, memories, import and export continue through the signed-in user and RLS.

Set the following ordinary preview variables if the defaults need changing:

- `KNUFL_REALTIME_MODEL` (default `gpt-realtime-2.1`)
- `KNUFL_REALTIME_VOICE` (default `marin`)
- `KNUFL_MAX_ACTIVE_REALTIME_SESSIONS` (default `1`)
- `KNUFL_DAILY_REALTIME_MINUTES` (default `60`)
- `KNUFL_MAX_REALTIME_SESSION_MINUTES` (default `30`)

The selected OpenAI project must have access to the configured Realtime model. Keep the review deployment separate from the existing GitHub Pages origin.

Knufl does not persist raw microphone audio or full transcripts. Audio is sent directly over WebRTC to OpenAI for processing; confirm the selected OpenAI project's current retention and data-control settings before a user pilot. The client closes at the server-issued expiry, but strict provider-side forced hangup at that exact deadline is a documented remaining infrastructure gate.

## 3. Live verification gate

With provider configuration present, verify in two separate browser profiles/devices using the same account:

1. Sign in and import or name the companion.
2. Describe a three-set bench plan; confirm that no completed set exists yet.
3. Record eight reps, correct it to six, and confirm there is still one set with a correction audit entry.
4. Start a 90-second rest and reload; the countdown must recover from its deadline timestamp.
5. Ask for bench progress; compare the spoken/text answer with the stored sets and date window.
6. Open the second device/profile and confirm the same session, corrected set and timer state.
7. Sign in as a second account and run the RLS probes; no first-account parent or child row may be visible or mutable.
8. First verify ordinary cross-device recovery by signing into the same test account in a second browser. For archive disaster-recovery testing, export a disposable account, delete that source account, then preview and restore the format-version-2 archive into a fresh bootstrap-only test account; repeat it and confirm the second restore is a no-op. Stable archive IDs deliberately prevent two live accounts from owning the same records, and restore refuses to merge into different existing history.

These are live-provider checks. Passing mocked unit/browser tests does not satisfy this gate.
