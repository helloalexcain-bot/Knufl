# Knufl voice companion architecture

Status: feature preview on `codex/voice-companion`; the public GitHub Pages site on `main` is intentionally unchanged.

## Baseline and framework decision

The repository is a React 19 / Next-compatible app built by Vinext and Vite. Its primary build already runs in the Cloudflare Workers runtime through `@cloudflare/vite-plugin`, while a separate static Vite build publishes the existing `/Knufl/` GitHub Pages prototype. The voice work therefore uses Vinext route handlers for same-origin Worker APIs; it does not replace the framework or add a second application.

Cloudflare serves the app and `/api/*` route handlers. Supabase Auth and Postgres are the only identity/data system. OpenAI Realtime is reached over WebRTC through an authenticated Worker endpoint; the standard OpenAI API key is never sent to the browser. Browser audio is not recorded by Knufl.

```text
phone browser
  ├─ Supabase OAuth (PKCE) ──────────────> Supabase Auth
  ├─ Supabase user session ──────────────> app-namespaced browser auth storage
  ├─ /api/tools + bearer token ──────────> Cloudflare Worker ──> validated owner writes
  └─ WebRTC SDP + bearer token ──────────> Cloudflare Worker ──> OpenAI Realtime
                audio/media path <─────────────────────────────> OpenAI Realtime
```

## Trust boundaries

- The Worker resolves the authenticated user from the bearer token. Tool arguments never contain or choose an owner ID.
- A central privileged-request guard also requires the verified owner on every service-role row, filter or RPC argument. Live integration tests attack the authenticated Worker paths as well as testing RLS independently.
- Supabase RLS repeats the ownership check at every exposed read and RPC boundary, including parent/child records. Authenticated browsers cannot mutate workout-domain tables directly; after validating the bearer, the Worker uses its service credential only for explicitly owner-filtered table writes. Profile, preferences and editable-memory writes remain owner-scoped browser operations under RLS.
- Mutations use stable operation IDs. Replayed requests return the existing result rather than creating duplicate sets, timers or exercise-day credit.
- OpenAI receives server-owned character instructions and typed tool declarations. It interprets speech; application tools validate and persist facts.
- Progress answers are calculated from stored compatible records and include the comparison window. Empty or incompatible data produces an explicit no-data result.
- Realtime issuance is guarded by an authenticated, database-backed concurrent-session and daily-minutes budget. The browser cannot call the service-role-only ledger functions. No request-scoped or user state is kept in a Worker global.
- Logs contain operation outcome, latency and provider usage metadata only. They do not contain raw audio or full workout conversation text.

## Persistence and recovery

Authenticated data is cloud-backed. The UI keeps only an account-namespaced pending-operation queue (`knufl.voice.pending.v1::<account-id>`) for retrying confirmed manual or voice actions after a connection failure. Signing out clears the active in-memory view and cannot expose another account's cache.

Returning focus, becoming visible or coming back online refreshes the account-scoped context from cloud storage. Rest countdowns recover from their saved absolute deadlines; this is not realtime multi-device streaming.

The static prototype continues to export `knufl.progress.v1` JSON on the old origin. Its separate `pages/index.html` entry imports `app/legacy-prototype.tsx`, so the Cloudflare page cannot replace the GitHub Pages experience by accident. A new-origin import is explicit: select that file, preview counts/name, then confirm. Legacy identity fields are discarded; IDs, sessions, memories and permanent milestone unlocks are retained. Import batches and source IDs make retries idempotent, and existing cloud records are not silently overwritten.

Authenticated account exports use format version 2. Onboarding and Settings detect that format, preview it with the dedicated restore RPC, and restore only into a bootstrap-only account (or return the exact prior restore as a no-op). The portable snapshot recursively removes account IDs, live operation leases and provider call IDs while preserving stable data/audit links. Stable IDs mean a different-account disaster recovery can happen only after the source account data has been deleted; live accounts cannot share those IDs. Normal two-device recovery does not require an export: the second device signs into the same Supabase account and reads the same RLS-protected records. The development demonstrator has its own explicitly labelled archive format and can restore it only inside the demonstrator.

## Character rendering boundary

`CharacterController` owns state, gaze, energy, audio amplitude, visemes and deterministic gesture events without depending on OpenAI or a renderer. The preview renderer maps those events to the five approved PNG poses and clearly labels itself as a development demonstrator. This proves event wiring and interruption semantics, not lifelike animation. The renderer can be replaced by the production glTF adapter without changing voice or workout logic.

See [character-rig-contract.md](./character-rig-contract.md) for the missing production deliverable.

## Deployment safety

- `main` and its GitHub Pages workflow remain unchanged and continue to serve the export-capable prototype.
- The new Worker is deployed only as a separate review preview; no domain or production route is moved.
- Provider secrets are supplied through the hosting environment. `.env.example` lists names only.
- Apple/Google buttons appear only when both the Supabase project and the corresponding provider flag are configured.
- Realtime connects muted; the user explicitly unmutes or holds push-to-talk after the processing disclosure.
- The browser closes at its server-issued expiry as a UX safeguard. Independently, Supabase Cron sweeps a private durable outbox every second and calls OpenAI's hangup endpoint using a Vault-held key. No request-scoped Worker or browser timer is responsible for enforcement. A stale/missing supervisor blocks new sessions. Failed hangups retry without releasing budget or concurrency; outstanding cleanup survives account deletion. The private `http` transport keeps credential headers out of pg_net's platform-owned shared queue; calls are bounded to eight seconds each, one per sweep (live OpenAI absent-call responses exceeded five seconds). Vault/private functions are denied to browser roles. Deadline enforcement is best-effort to scheduler/provider latency, not a hard-real-time guarantee during outages; live OpenAI verification is a separate gate.

## Native boundary

This stage is a phone-first web implementation. Background audio, lock-screen behaviour, Bluetooth interruption handling and installed-PWA behaviour are not claimed until physical iPhone testing. Capacitor/native audio remains a separate stage-five spike.
