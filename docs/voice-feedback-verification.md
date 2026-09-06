# Voice feedback implementation — 6 September 2026

Private preview: https://knufl-voice-companion.alcain.chatgpt.site/

The final application deployment (version 7, runtime revision 4) succeeded at **08:22:46 UTC**, from `0a36aa8b29bf5036809e218cca8b57b487790a32`. It was opened and verified at the actual published URL. Later documentation/test-harness-only edits do not change the deployed application. GitHub `main`, public Pages and the owner-only access policy (revision 1) were not changed. Feature work is pushed on `codex/voice-companion`.

## Cause and fix

The old plan lived in the browser's current interaction rather than durable active-exercise state. Realtime did not receive a compact, refreshed account of that plan/current exercise after each tool. The logging path could therefore see an incomplete workout and ask for an exercise the user had already supplied. Prompt wording alone could not repair that lost context.

The preview now persists a draft and explicit active exercise through an owner-scoped atomic database operation. Context contains exercise/session IDs, planned load/unit/mode, actual latest set ID/version, next set position and rest settings. The client retrieves it before connecting, refreshes it after mutations, and feeds verified facts back into Realtime. A shared resolver inherits established load but never planned completed reps. A database trigger keeps the cursor coherent even after direct authenticated set writes; supersets clear it until the next explicit selection. Archived/imported histories do not advance the active cursor.

Explicit completed reports save without an exercise confirmation when the context is unambiguous. Receipts use persisted rows; corrections retain the set ID and audit version. Existing operation-key deduplication, optimistic concurrency, account scoping and earned-day/milestone rules remain in force. Old version-2 archives without training context still restore.

## Voice and animation

Cedar is the provisional default. **Menu → Settings → Owner-only voice audition** offers Cedar, Ash and Ballad reading the same original lines. Only the configured Supabase owner can request these at the Worker. Every sample uses a fresh real call, no microphone/tools, ordinary usage accounting and a server-enforced one-minute maximum; it closes after playback. No public voice/gender questionnaire was added.

The approved PNGs are unchanged. The new approximately 1 MB GLB is genuine node-articulated 3D, with cream/sage materials, separate face/jaw/eyes/paws and procedural surface nap. Breathing, irregular blinks, listening tilt/gaze, real output-audio RMS jaw motion, restrained head/paw gestures, weighted shift/recovery, paw tap and smooth interruption settling are wired to the existing controller. Reduced-motion behaviour has deterministic coverage.

This is explicitly a **provisional articulated study**, not a production-approved sculpt or lifelike final character. It lacks continuous skin deformation, approved plush fur and refined facial/paw anatomy. Mouth movement is amplitude-driven, not phoneme-accurate. The exact small replacement-asset brief and arbitrary-node mapping contract are in [the artist handoff](character-rig-contract.md). No Blender or connected 3D asset-production service was available; no service was purchased.

## Automated and live evidence

- 110 unit/contract tests passed. Provider-fetch and browser-media mocks in this suite are explicitly simulated.
- 107 local PostgreSQL/PGlite assertions passed; local Auth, extensions and supervisor transport are simulated.
- 107 hosted pgTAP assertions passed, including the new context RPC/trigger isolation and import cases. Fixtures roll back. Supervisor HTTP responses in pgTAP are simulated, not real hangups.
- Lint, TypeScript, Cloudflare/vinext production build and legacy `/Knufl/` build passed. The dynamically loaded Three.js bundle still produces a build-size advisory; mobile performance is not certified.
- Migration `202609060001` was applied and recorded on the existing preview project. No account setup or access changes were required.
- **13 real deployed integration groups passed again on the final publication.** Worker/Auth/database verification covers cross-account mutation attacks through the service-role paths, duplicate delivery, same-ID corrections, stale-device conflicts, independent authenticated-client recovery, exact timer deadlines and one credit per local exercise day. Both disposable users and all their records were removed. This is not a claim of two physical-device verification.

Live conversation verification uses typed utterances sent to the actual OpenAI model and real WebRTC output audio, shipped context resolution and deployed tools. It does **not** use the offline phrase parser, mock tool responses or a physical microphone. Test users and workout records are disposable.

The initial live runs found a data-channel readiness race, a tool-follow-up playback gap and truncation at the previous 320-token output limit. Those were fixed, with focused regression tests and a 1,024-token output ceiling. The harness now waits for the final spoken reply, not merely the end of a preamble. Initial interrupted/incomplete runs are not counted as a full scenario pass.

Across actual-model runs, the bench plan persisted with zero completions; “First set done, eight reps” immediately saved eight at sixty without an exercise question; “Actually six” updated that same ID to version 2; and “Same again” saved a second six-rep set at sixty. Repeated HTTP deliveries returned the identical set ID. A 90-second rest used the persisted deadline. A fresh Realtime call recovered bench and sixty kilograms for set three. Workout completion unlocked the first-session milestone and one day credit.

The final focused model run passed all four steps: an ambiguous superset report saved nothing; an explicit switch (with the earlier ambiguous report expressly withdrawn) selected Barbell Row; “Eight done” saved one eight-rep set at forty kilograms; and the full spoken progress answer cited that set and said one set was insufficient for comparison. OpenAI reported completed responses and actual output RMS was nonzero. Superset setup in this focused run was an explicit fixture created through real tools, **not** a model-generated plan; the earlier full run separately verified model-generated superset planning.

The full final bench script did **not** pass uninterrupted: its progress tool returned correct saved records, but the spoken follow-up timed out at 45 seconds. The later focused progress call completed successfully. No raw diagnostic trace was available for the earlier timeout, so its exact cause remains unproven; this is not claimed fixed by the passing retry. Another test's “Switch to rows” was reasonably interpreted by the model as resolving the preceding ambiguous eight-rep report, which it saved correctly. The harness now explicitly withdraws that report when testing selection without logging. All disposable conversation accounts/data were removed after their runs.

All three owner auditions produced real output and visible speech-driven jaw motion. Observed jaw values included 0.068 (Cedar), 0.656 (Ash) and 0.623 (Ballad), settling to 0.000 at silence; these are renderer input observations, not lip-sync quality measurements. Interrupting Ash stopped playback and returned the character to its quiet state. The real ledger recorded three distinct closed calls, each capped at exactly 60 seconds. The supervisor remained healthy with no overdue calls.

The published screen was visually inspected at 390×844 and 1280×900, with ears, paws, feet and controls visible and no horizontal overflow. Refresh retained the owner's sign-in and companion name. A Three.js shadow-map deprecation warning found in the browser was corrected; no new warning/error was captured after loading the final renderer. Phone viewport emulation is not physical-iPhone verification.

## Remaining limitations and owner checks

- Live Realtime still sometimes adds a short pre-tool preamble despite the brevity instructions. Post-save receipts are factual and short; exact wording and total response length remain model-dependent.
- One 45-second progress-reply timeout occurred; a later targeted live call passed. A consistently successful single uninterrupted full conversation run is not yet established.
- Accept/refine the production character using the [minimal artist handoff](character-rig-contract.md); the study's many draw calls, seams and geometric nap do not meet the final mobile-quality target.
- Compare the three voices yourself; Cedar is provisional, not a claim of your final approval.
- Repeat the short [physical-iPhone script](provider-setup.md#short-physical-iphone--second-profile-script), especially microphone transcription, interruption, Safari/Bluetooth/lock-screen behaviour and recovery in a second real browser profile/device. No microphone recording was fabricated to stand in for those checks.
- No new credentials are needed for Google/OpenAI. Apple remains configuration-ready but disabled; its exact callback/setup destinations remain in the provider guide.
