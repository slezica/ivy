# Play Store Screenshot Pipeline

Reproducible screenshots with curated demo data. One command regenerates everything:

```bash
npm run screenshots        # → playstore/shots/*.png
```

## Core Idea

The app seeds itself with demo data when a **seed bundle** is present in its external files directory (`/sdcard/Android/data/com.salezica.ivy/files/demo/`). The driver script clears app data, pushes the bundle via adb, and runs a Maestro flow that navigates the seeded app and takes screenshots.

Everything is data-driven from `playstore/data.json` — books, positions, clips, transcriptions, sessions, cover palettes. Edit it, re-run the command, get new screenshots.

## Rationale

- **Real data path**: the seed writes through `DatabaseService` (the same `restore*FromBackup` methods sync uses), and the hero book auto-loads through the normal startup path. Screens render exactly what they'd render for a real user.
- **adb-pushed bundle, no rebuild**: fixture changes need no new APK. The bundle lives in app-owned external storage — writable by adb (emulators; debuggable builds on devices), readable by the app without permissions.
- **Presence-of-file trigger**: no intent plumbing, no dev menu. The trigger ships in all build variants; only someone with adb or physical access to app-owned storage can create the bundle, at which point they own the device's app data anyway.
- **Honest audio durations**: the player position display syncs with the real file (`fetchPlaybackState` reads hardware position on focus), so a fake DB duration alone won't survive. The hero book's silent MP3 is generated at its full stated duration by repeating a single pre-encoded 72-byte silent frame (~1KB/s, ~21MB for 6h, instant to generate, no ffmpeg dependency). Non-hero books never load into the player, so they share a 60s file.

## Components

| Piece | Role |
|---|---|
| `playstore/data.json` | The fixture: books, clips, sessions, cover palettes |
| `playstore/artwork/*.png` | Generated covers (committed) |
| `playstore/generate-artwork.py` | Regenerates covers from `data.json` (Pillow; run after editing titles/palettes) |
| `playstore/gen-audio.js` | Generates silent MP3s into `playstore/cache/` (gitignored, cached) |
| `src/actions/seed_demo_data.ts` | Seeds DB + files from the bundle, then deletes it |
| `maestro/playstore/screenshots.yaml` | Navigates and shoots (excluded from the e2e suite) |
| `scripts/playstore-shots.sh` | The one command: gen → clear → push → maestro → collect |

## Seeding Semantics

- Runs at startup, inside `initializeApplication`, **before** store hydration; failures are logged and startup continues.
- Wipes all data (`clearAllData`) — the script also runs `pm clear`, so this only matters when re-pushing a bundle without clearing.
- Books get explicit descending `updated_at` (fixture order = library order) and no `last_played_at`, making `books[0]` the auto-load hero via the `updated_at` fallback.
- Book/clip/session inserts use the backup-restore DB methods: no sync queueing, full timestamp control.
- Sync and transcription are disabled in settings (quiet queues; clips carry pre-written transcriptions).
- The bundle is deleted after seeding, so relaunches keep the seeded state without re-seeding.

## Fixture Notes

- Session times are relative (`daysAgo` + fractional `startHour` + `minutes`) and resolve against the device clock at seed time — the histogram always shows "the last week".
- Clip `daysAgo` drives `created_at` (list order).
- A book without `audio` / with `archived: true` seeds as archived (uri stays null).
- All text is public-domain (classic literature); covers are generated, so there's no third-party artwork in Play Store listings.

## Requirements

App installed on the target (preview build recommended), adb + maestro on PATH, and an emulator (or a debuggable build, for adb access to `/sdcard/Android/data/<app>/`). Screenshot resolution = device resolution; pick the emulator accordingly.
