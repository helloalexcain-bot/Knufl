# Knufl

Knufl is a phone-first training companion with an expressive character, typed workout actions and an optional live OpenAI Realtime voice session. This feature branch implements the stages 1–4 preview architecture while keeping the export-capable GitHub Pages prototype on `main` unchanged.

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Without provider configuration, choose **Open development demonstrator**. It exercises the character controller, plan/set/correction/rest/progress tools and browser persistence without pretending to provide cloud recovery or live AI voice.

The five approved PNG poses remain the visual reference. They are a clearly labelled development renderer, not the final lifelike character rig. See [the rig contract](docs/character-rig-contract.md) for the exact missing production asset.

## Architecture

- Vinext/React app and same-origin route handlers deploy together on Cloudflare Workers.
- Supabase Auth/Postgres owns accounts and durable workout data; every record is protected by per-user RLS.
- OpenAI Realtime uses WebRTC. The Worker creates authenticated sessions and never exposes the standard API key.
- Typed tools—not the model—validate and persist plans, actual sets, corrections, undo, rest timers, cardio, completion and grounded progress.
- Confirmed offline actions use the account-specific key `knufl.voice.pending.v1::<account-id>`. The local demonstrator uses `knufl.voice.demo.v1::development-demonstrator`; Supabase Auth uses `knufl.auth.v1`.

See [architecture](docs/voice-companion-architecture.md) and [provider setup](docs/provider-setup.md).

## Existing progress and the public prototype

The existing `/Knufl/` GitHub Pages app remains built separately from
`pages/index.html` and `app/legacy-prototype.tsx` with:

```bash
npm run build:pages
```

Its route and `knufl.progress.v1` export remain available. Browser storage cannot move between origins or devices automatically. Export JSON from the old site, then choose that file during cloud onboarding or later in Settings. Import shows a preview, preserves stable session/memory/milestone IDs, discards legacy gender/pronoun fields and is idempotent.

Cloud account exports use format version 2 and can also be restored during onboarding or from Settings into a bootstrap-only signed-in account. The restore previews counts and conflicts, preserves linked IDs/audit history/credits/unlocks, and never silently merges over different cloud history. Signing into the same Supabase account remains the ordinary cross-device recovery path. Because archive IDs remain stable and globally unique, restoring into a different account is a disaster-recovery path only after the source account data has been deleted; two live accounts cannot own the same archive IDs. Demonstrator archives are deliberately development-only and restore only in the demonstrator.

## Verification

```bash
npm test
npm run lint
npx tsc --noEmit --incremental false
npm run build
npm run build:pages
```

Node tests include provider-independent domain/controller tests and Worker integration tests explicitly labelled `[mocked]`. The Supabase pgTAP suite is in `supabase/tests/voice_companion_rls.sql` and requires a disposable Supabase/Postgres project. Real OAuth, RLS isolation, Realtime audio, cross-device recovery and iPhone behaviour require the external configuration and device checks listed in the provider guide.

No gender or pronoun fields are collected. The companion keeps its editable name and uses natural first-person dialogue.
