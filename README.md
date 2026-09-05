# Knufl prototype

A mobile-first, local-only fitness companion prototype. Knufl helps adults follow through on exercise plans they already understand and rewards one completed, user-reported exercise day at a time.

## Run locally

Requirements: Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open the local address shown in the terminal (normally `http://localhost:3000`). For production checks, use `npm run build` and `npm run build:pages`.

## GitHub Pages

The static Pages build uses the `/Knufl/` base path and outputs to `dist-pages/`. Every push to `main` runs tests, lint and the static build before deploying through `.github/workflows/deploy-pages.yml`.

The app uses a single static route. `404.html` mirrors the app shell so a direct refresh under the project path still loads the prototype.

## What is included

- Two-step companion naming and flexible plan onboarding.
- The companion name remains editable in settings; there are no gender or pronoun fields.
- Persistent session timer plus planned, shorter and already-completed logging flows.
- Optional duration and feeling, editable/deletable history, rest days and a warm return flow.
- One practice credit per local calendar day with a permanent Little Mountain unlock after three credited days.
- First-session and milestone memories tied to the relevant session.
- Local JSON export/import and a confirmed reset.
- Static supplied character poses with restrained CSS greeting, wobble and paw-tap treatments; reduced-motion preferences are respected.

## Local persistence and transferring progress

Progress is stored in browser `localStorage` under the app-specific key `knufl.progress.v1`. There is no account, backend or cloud sync. Localhost, the hosted Pages site and each phone/browser have separate storage.

To transfer progress:

1. On the source browser, open **You → Local progress → Export progress**.
2. Move the downloaded JSON file to the destination device if necessary, for example through Files, AirDrop or another method you trust.
3. Open the hosted Knufl URL on the destination browser.
4. Choose **You → Local progress → Import progress** and select the JSON file.

Older Knufl exports that contain gender or pronoun fields remain importable. The companion name, plan, workouts, memories and milestones are retained; removed identity fields are discarded.

## Product rules and copy

- Progression and calendar rules: `lib/progression.ts`
- Data model and defaults: `lib/types.ts`
- Scripted companion dialogue: `lib/dialogue.ts`
- Browser persistence and import migration: `lib/storage.ts`
- Focused rule and migration tests: `lib/*.test.ts`
- App flow and UI: `app/page.tsx`

The character files in `public/bram/` are crops prepared from the supplied approved reference sheet. Motion is applied to static artwork; the character is not fully rigged or skeletal-animated in this prototype.
