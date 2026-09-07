# AI Agent Reference for Ivy

**Quick onboarding guide for AI agents.** Read this first when starting a new session.


## What is Ivy?

Ivy is a local-first audiobook/podcast player written in React Native (Expo, Android-focused). It can:

- Import audio files into its library (from local files), extracting metadata, artwork and chapters
- Play audio files in the library (GPU-accelerated Skia timeline, system media controls, auto-resume)
- Extract, play and share clips, with on-device Whisper transcription (privacy-first)
- Remember listening sessions (history + histogram)
- Auto-sync data and clips to Google Drive


## How to Work on Ivy?

The team values clean code, careful architectural decisions and standardized use of git. This last point is especially important.

Git messages are one-liners in the form '<scope>: <change>', without extended descriptions and without attributions. For example, these are good messages:
        
        store: add foobar state
        library: adjust styling of book artwork
        downloader: fix progress indicator reading -1%
        ui: refactor dialogs to be generic

Respecting this convention forces you to commit changes in tightly scoped units, and away from large commits with entire features or refactors. Commit as you work to avoid accumulation of changes across scopes.

Git worktrees go in `worktrees/` (e.g. `git worktree add worktrees/my-feature`). That path is gitignored and excluded from jest, tsc, eslint, metro, and container builds — a worktree anywhere else pollutes them all with a duplicate checkout.


## Topics

These are in-depth guides to aspects of the application. CRITICAL: before you start working on one of the following topics, read the corresponding guide to learn about it.

EQUALLY CRITICAL: the markdowns describe reality — keep them true. When a change alters behavior covered by a guide, or by this file (schema, store state, file structure, quick summaries), update the affected markdowns as part of the same piece of work. Significant features also get a dated design doc in `docs/` (`YYYY-MM-DD-<topic>.md`) recording the idea, rationale, and rejected alternatives.

### Books and Library

File import (local files), metadata editing, archiving, deletion, and restoration. See **[docs/BOOKS.md](docs/BOOKS.md)** for the full guide.

**Quick summary:** Files are copied to app-owned storage on import. Each book is fingerprinted (file size + first 4KB) for duplicate detection. Adding a file that matches an archived/deleted book restores it with preserved position. Books use soft-delete (`hidden` flag), never hard-delete.

**Key rules for working with books:**
- `book.uri` can be null — always check before using for playback (null = archived or deleted)
- Use `book.id` (UUID) as the stable identifier, not `uri` (which changes on restore)
- Archive/delete are optimistic with rollback — update store first, then DB
- Every book mutation must queue for sync (`db.queueChange`) — except archive/delete, which are per-device and must NOT queue or bump `updated_at` (see docs/SYNC.md)
- On restore, existing metadata (title/artist/artwork) wins over ID3 tags — protects user edits
- Metadata extras (summary, narrator, series, ...) come only from ffmetadata (best-effort; ffmpeg failure → null); lazy re-extraction is gated by `metadata_version` vs `EXTRACTED_METADATA_VERSION`
- Extras are editable and edits win: extraction fills only null fields (`fillMissingExtras`); `''` means "edited and cleared" (never refilled, hidden in display)

### Playback

Audio playback via react-native-track-player v5. See **[docs/PLAYBACK.md](docs/PLAYBACK.md)** for the full guide.

**Quick summary:** `AudioPlayerService` wraps TrackPlayer with a millisecond API (TrackPlayer uses seconds). Multiple components can control playback via an ownership model (`playback.ownerId`). Playback state is hardware-only — no book metadata, just uri/position/duration/status/ownerId.

**Key rules for working with playback:**
- All times are milliseconds — the ms↔seconds boundary is inside `AudioPlayerService` only
- Pass `{ fileUri, position, ownerId }` when calling `play()` from UI components
- Check `playback.ownerId === myId` before syncing from global playback state
- Don't update `playback.status` from audio events while in `'loading'` state
- Only `MAIN_PLAYER_OWNER_ID` persists position to the database

### Clips

Bookmarks with their own audio files. See **[docs/CLIPS.md](docs/CLIPS.md)** for the full guide.

**Quick summary:** Clips are sliced from source books as standalone `.m4a` audio files at `clips/{uuid}.m4a`. The viewer always plays the clip's own audio (the source book is only for editing and "go to source"), so clips work identically with the book archived. Each clip has a note (user-written) and a transcription (auto-generated).

**Key rules for working with clips:**
- Check `clip.file_uri !== null` before enabling edit or "go to source"
- Playback in the viewer uses `clip.uri` (the clip's own file), never the source; only the editor and `seekClip` play `clip.file_uri`
- Clips LEFT JOIN their book: **all** `file_*` fields (`file_name`, `file_duration` included) are null when the book row is missing — don't assume any of them
- Every clip mutation must queue for sync (`db.queueChange`); clip deletion is global (propagates via sync tombstones)
- `note` and `transcription` are separate fields — don't conflate them

### Transcription

On-device automatic clip transcription using Whisper. See **[docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md)** for the full guide.

**Quick summary:** Clips are queued for transcription on creation → processed sequentially by a background queue → first 3 minutes of audio extracted and fed to on-device Whisper (longer clips get a `...` suffix) → result persisted via the store's `updateClip` action (the queue never writes the DB; empty results are valid, only errors skip persistence). Controlled by `settings.transcription_enabled`.


### Sessions

Automatic listening activity tracking. See **[docs/SESSIONS.md](docs/SESSIONS.md)** for the full guide.

**Quick summary:** Main player playback creates sessions (time ranges per book) → `ended_at` updated every 5s while playing → finalized on pause (sessions < 1s are deleted). 5-minute resume window prevents fragmentation. Sessions are synced across devices (whole-entity LWW; deletions propagate via tombstones).

### Sync and Backup

Offline-first multi-device sync via Google Drive. See **[docs/SYNC.md](docs/SYNC.md)** for the full guide.

**Quick summary:** Store actions queue changes to a local outbox → sync pulls remote changes via Drive's change feed (incremental, not full crawl) → per-entity LWW reconciliation (last writer wins, no per-field merging) → outbox drained with update-in-place uploads, stale detection, and retry-forever backoff → store notified of remote changes via events. Deletion semantics: book archive/delete are per-device (never queued, no `updated_at` bump); clip/session deletions propagate via full-payload tombstones. Duplicate book identities (same audio imported on two devices) merge by fingerprint onto the smaller id.

### Migrations

Database migration system and its testing layers. See **[docs/MIGRATIONS.md](docs/MIGRATIONS.md)** for the full guide.

**Quick summary:** Single ordered async migration array in `database.ts`, deps-injected, run by the `runMigrations` action before anything else touches the DB. Pre-migration `VACUUM INTO` snapshot. Tested by jest prefix-replay + device upgrade smoke test (`test --upgrade`) with per-migration hooks.

**Key rules:**
- **Never edit a shipped migration** — append-only; fix mistakes with a new migration
- Migrations must be idempotent (failure = full rerun next launch) and memory-lean (ids first, bulky columns row-at-a-time)
- Data-transforming migrations require a jest case and an upgrade-test hook; ADD COLUMN needs neither
- Decide sync semantics explicitly: converging repair (bump + queue) vs per-device normalization (touch nothing)


## Tech Stack

- React Native 0.81.5 + Expo 54
- Zustand + immer for state
- Expo Router (file-based tabs)
- react-native-track-player v5 (playback + system media controls: notification, lock screen, Bluetooth)
- SQLite (expo-sqlite)
- Skia for timeline rendering
- react-native-fs for most filesystem work (carries a patch in `patches/`, applied by `patch-package` on postinstall); expo-file-system (`Paths.document`, `Directory`, `File`) in a couple of spots
- whisper.rn for on-device transcription (+ react-native-audio-api for audio decode)
- mitt (powers `BaseService` typed events)
- react-native-safe-area-context (not deprecated SafeAreaView)
- expo-splash-screen (manual splash control during async initialization)
- Native Kotlin modules for audio slicing, metadata, file copy (local module in `modules/ivy`, autolinked)
- Vendored FFmpeg runtime (termux-packages build, arm64-v8a) in `modules/ivy` jniLibs — `libffmpeg.so` exec'd for clip slicing + chapter extraction; no external dependency (see docs/2026-08-04-vendor-ffmpeg.md)
- `android/` is generated (`expo prebuild --clean` is safe): never edit or commit it — hand-written native code lives in `modules/ivy`, gradle customization in `plugins/` config plugins

## File Structure

```
/src
  ├── actions/                    # Action factories (one file per action)
  │   ├── constants.ts            # Shared constants (durations, paths)
  │   ├── play.ts, pause.ts, ... # Playback actions
  │   ├── add_clip.ts, ...       # Clip actions
  │   ├── load_file.ts, ...      # Library actions (local files)
  │   ├── initialize_application.ts # App startup (migrations, hydrate store, warm-ups, auto-load)
  │   └── ...                     # ~40 action files total
  ├── store/
  │   ├── index.ts                # All state, action wiring, event listeners
  │   ├── types.ts                # Type definitions (AppState, Action, ActionFactory)
  │   └── __tests__/              # Store-level tests (clips, sessions)
  ├── services/
  │   ├── index.ts                # Singleton registry (every service instance is constructed here) + barrel exports
  │   ├── base.ts                 # BaseService with typed events (on/off/emit; mitt)
  │   ├── audio/
  │   │   ├── player.ts           # react-native-track-player wrapper
  │   │   ├── integration.ts      # Playback service for remote control events
  │   │   ├── metadata.ts         # ID3/metadata extraction
  │   │   ├── ffmetadata.ts       # Tags + chapter extraction (parses raw text from FFmetadataReaderModule.kt)
  │   │   └── slicer.ts           # Audio segment extraction (native module)
  │   ├── storage/
  │   │   ├── database.ts         # SQLite operations
  │   │   ├── files.ts            # App-storage file utilities (stat, delete, list — copying is the native copier's job)
  │   │   ├── copier.ts           # Native file copier (progress, fingerprint, cancel)
  │   │   ├── picker.ts           # Document picker
  │   │   └── __tests__/          # database.test.ts + migrations.test.ts + sqlite_adapter (real SQLite in Jest)
  │   ├── transcription/
  │   │   ├── queue.ts            # Background transcription queue
  │   │   ├── whisper.ts          # On-device speech-to-text (whisper.rn)
  │   │   └── errors.ts           # Transcription error causes (shared with store types)
  │   ├── backup/
  │   │   ├── auth.ts             # Google OAuth (@react-native-google-signin)
  │   │   ├── drive.ts            # Google Drive REST API (upload, download, changes, update-in-place)
  │   │   ├── sync.ts             # Sync engine (pull via change feed, push via outbox, LWW reconcile)
  │   │   ├── types.ts            # Shared backup types
  │   │   └── __tests__/          # Sync engine unit tests + FakeDrive scenario harness
  │   └── system/
  │       ├── sharing.ts          # Share clips via native share sheet
  │       ├── network.ts          # NetworkService (NetInfo wrapper: connectivity + metered events)
  │       ├── toast.ts            # Fire-and-forget Android toast helper
  │       ├── build.ts            # Build-variant detection (isTestBuild, via BuildInfoModule) + test-only whisper model URL override
  │       └── clipboard.ts        # Clipboard helper (copyText)
  ├── screens/
  │   ├── LibraryScreen.tsx       # Book list (active + archived sections) with archive action
  │   ├── PlayerScreen.tsx        # Main player
  │   ├── ClipsListScreen.tsx     # Clip management
  │   ├── SessionsScreen.tsx      # Listening history
  │   ├── SettingsScreen.tsx      # App settings (sync, transcription, about link)
  │   ├── AboutScreen.tsx         # About Ivy (version, build date, licenses incl. GPL text for bundled ffmpeg)
  │   └── about/gpl3.ts           # Bundled GPL-3.0 license text
  ├── components/
  │   ├── MetadataEditor.tsx      # Book metadata editing (all fields; artwork read-only)
  │   ├── BookDetails.tsx         # Read-only book details (extras; Close/Edit; lazy extraction)
  │   ├── BookDetailsDialog.tsx   # Viewer/editor pair dialog (library + player menus)
  │   ├── ClipViewer.tsx          # Clip playback (own position state, timeline, transcription)
  │   ├── ClipEditor.tsx          # Clip editing (own position state, selection timeline, note)
  │   ├── BookItem.tsx            # Library list row
  │   ├── ClipItem.tsx            # Clip list row
  │   ├── SessionItem.tsx         # Session list row
  │   ├── TranscriptionBanner.tsx # Clips-screen transcription status banner (+ transcription_banner_content.ts, pure logic)
  │   ├── SessionHistogram.tsx    # Listening time by day/week/month/year
  │   ├── LibraryLoadingDialog.tsx # "Adding..." / "Loading..." dialog
  │   ├── timeline/               # GPU-accelerated timeline component
  │   │   ├── Timeline.tsx        # Unified timeline (playback + selection)
  │   │   ├── engine.ts           # Pure physics engine (scroll, momentum, playback follow)
  │   │   ├── useTimelinePhysics.ts # React adapter hook (gestures, rAF loop)
  │   │   ├── constants.ts        # Dimensions, physics, animation, zoom constants
  │   │   ├── utils.ts            # timeToX, xToTime, bar heights
  │   │   ├── trace.ts            # Interaction tracing (test builds; see file header for capture workflow)
  │   │   └── index.ts            # Barrel exports
  │   └── shared/
  │       ├── ScreenArea.tsx      # Safe area wrapper (react-native-safe-area-context)
  │       ├── Header.tsx          # Reusable header (title, subtitle, noBorder)
  │       ├── InputHeader.tsx     # Search header (text input, close button)
  │       ├── EmptyState.tsx      # Empty state display
  │       ├── IconButton.tsx      # Circular icon button
  │       ├── ActionMenu.tsx      # Overflow menu (3-dot)
  │       ├── TextButton.tsx      # Simple text button (primary/default variants)
  │       ├── Dialog.tsx          # Simple dialog/modal component
  │       └── ErrorBoundary.tsx   # React error boundary
  ├── utils/
  │   ├── index.ts                # Shared utilities (formatTime, formatDate, stripEnclosingQuotes, ...)
  │   └── __tests__/
  ├── types/
  │   └── whisper.rn.d.ts         # Type augmentation for whisper.rn
  └── theme.ts

/app
  ├── _layout.tsx                 # Root (splash screen control, initialization gate)
  ├── +not-found.tsx              # Catch-all redirect (handles notification clicks)
  ├── settings.tsx                # Settings screen route
  ├── about.tsx                   # About screen route
  ├── sessions.tsx                # Listening history route
  └── (tabs)/
      ├── _layout.tsx             # Tab nav (disables the Player tab when no file is loaded)
      ├── index.tsx               # Library
      ├── player.tsx              # Player
      └── clips.tsx               # Clips

/index.js                         # App entry point (registers RNTP playback service)

/modules/ivy                      # Local native module ("ivy-native"), autolinked via the modules/ dir
  ├── package.json                # Internal package name: ivy-native (must differ from root "ivy")
  ├── react-native.config.js      # Registers IvyPackage with RN core autolinking
  └── android/
      ├── build.gradle            # Library module (no external native deps)
      ├── src/main/jniLibs/       # Vendored ffmpeg runtime (libffmpeg.so + libffmpeg.zip.so bundle) and its extra deps (libexpat, libcrypto, libandroid-*), arm64-v8a only — see docs/CLIPS.md
      └── src/main/java/com/
          └── salezica/ivy/
              ├── IvyPackage.kt           # Single autolinked ReactPackage (lazy BaseReactPackage, declares all modules)
              ├── FFmpegEnvironment.kt    # Bundle extraction + LD_LIBRARY_PATH + soname symlinks for exec'ing libffmpeg.so
              ├── AudioSlicerModule.kt    # Native module for audio slicing
              ├── AudioMetadataModule.kt  # Native module for metadata extraction
              ├── FileCopierModule.kt     # Native module for file copy with progress
              ├── FFmetadataReaderModule.kt # Native module for raw ffmetadata dump (FFmpeg -f ffmetadata; parsed in JS)
              └── BuildInfoModule.kt      # Exposes ivy_build_variant (test-affordance gate), version, build date, maestro whisper model URL to JS

/plugins                          # Expo config plugins (applied in app.json) — recreate all gradle customization on prebuild
  ├── withIvySigning.js           # signingConfigs from secrets/ (release uses $KEYSTORE_PASSWORD)
  ├── withIvyGradleMemory.js      # Gradle JVM heap bump (release-bundle signing needs > default -Xmx)
  ├── withIvyBuildTypes.js        # `preview` + `maestro` buildTypes (R8 on, like release), the ivy_build_variant signal, maestro-only whisper model URL + cleartext placeholder
  ├── withIvyHermesFix.js         # arch-aware hermesc path (arm64 Linux container)
  ├── withIvyVersionName.js       # versionName from package.json at build time
  ├── withIvyApkPathPrint.js      # print APK/AAB output paths after assemble/bundle tasks
  ├── withIvyPackaging.js         # skip llvm-strip on libffmpeg.zip.so (zip, not ELF)
  └── withIvyArchitectures.js     # default reactNativeArchitectures=arm64-v8a (vendored ffmpeg is arm64-only)

/bin
  ├── ivy.ts                      # THE project CLI (build/test/drive/inspect) — see Toolkit CLI Reference below
  ├── upgrade_hooks.ts            # Per-migration seed/verify hooks for `test --upgrade` (kept forever, like migrations)
  └── __tests__/                  # Toolkit tests: hygiene.test.ts (repo gates), ivy.test.ts, upgrade_hooks.test.ts

/secrets                          # Keystores. HARD RULE: secrets are NEVER duplicated —
  │                               # no tooling copies this directory anywhere, ever
  ├── debug.keystore              # Standard Android debug key (committed — public knowledge,
  │                               # makes old-tag checkouts build self-contained)
  └── release.keystore            # Release key (untracked, NEVER commit; alias 'ivy',
                                  # password via $KEYSTORE_PASSWORD)

/android                          # GENERATED by `expo prebuild --clean` — untracked, never hand-edited
/ios                              # GENERATED likewise — untracked (app is Android-focused)

/maestro                          # Maestro e2e test flows (see maestro/README.md)
  ├── config.yaml                 # Shared config
  ├── smoke-test.yaml             # Empty state verification
  ├── load-and-play.yaml          # File loading and playback
  ├── add-clip.yaml               # Clip creation
  ├── clip-crud.yaml              # Clip edit/delete lifecycle
  ├── clip-dismiss-release.yaml   # Clip dialog dismissal returns playback to main player
  ├── book-details.yaml           # Book details viewer/editor round trip
  ├── chapter-extraction.yaml     # Chaptered import
  ├── delete-original.yaml        # Delete original after import
  ├── timeline-gestures.yaml      # Timeline drag/fling/tap
  ├── artwork-cap.yaml            # Oversized-cover import → artwork extraction cap (bridge DB check)
  ├── sleep-timer.yaml            # Sleep timer arm/expiry (needs maestro build variant)
  ├── transcription-states.yaml   # Model-download lifecycle against the bridge model server + network gates (needs maestro build variant)
  ├── transcription-inference.yaml # Whisper end to end: tiny model from the bridge → clip → persisted transcription (needs maestro build variant)
  ├── playback-integration.yaml   # Media-button play/pause, background playback, cold-restart auto-resume (bridge media key + DB checks)
  ├── scripts/bridge.js           # Shared helper calling the toolkit bridge (device control, DB checks, model-server modes mid-flow)
  ├── scripts/sleep.js            # Busy-wait for real-time effects (maestro has no sleep command)
  ├── subflows/                   # Shared steps (import-book)
  ├── playstore/                  # Play Store screenshot flow (screenshots.yaml, run by `generate --screenshots`)
  ├── screenshots/                # GENERATED (gitignored): screenshot-flow output
  └── README.md

/assets/test
  ├── test-audio.m4a              # Bundled test file (chapters + standard extras tags: narrator, summary, date)
  ├── test-audio-2.m4a            # Second fixture: all extras filled (Libation-style freeform atoms)
  ├── test-audio-cover.m4a        # Oversized embedded cover (~900KB, 1400px) — artwork-cap.yaml import-path check
  └── test-artwork.jpg            # >100KB-as-base64 JPEG — upgrade-test hook seed for the artwork repair migration

/cache                            # GENERATED (gitignored): persistent toolkit caches
                                  # upgrade/ivy-maestro-<version>.apk — upgrade-test bases, written by prepare
                                  # whisper/ggml-tiny.bin — model served to maestro builds by the e2e bridge (fetched once)

/samples                          # Committed sources for generated store/web assets
  ├── data.json                   # Demo library fixture (screenshot seeding; see docs/2026-07-21-playstore-screenshots.md)
  ├── feature.html                # Feature graphic source (rendered by `generate --feature`)
  └── generate-artwork.py         # Demo cover generator (Pillow; run via `generate --artwork`)

/dist                             # GENERATED (gitignored): store assets + release artifacts
                                  # audio/, artwork/, screenshots/, feature.png, icon-512.png (bin/ivy.ts generate)
                                  # ivy-release-X.Y.Z.aab/.apk/-mapping.txt (delivered by release builds)

/docs                             # Guides (BOOKS, PLAYBACK, CLIPS, ...), dated records (YYYY-MM-DD-<topic>.md),
                                  # VERSIONS.md (changelog), IDEAS.md (backlog of ideas)
/web                              # Project site (index.html, privacy.html, assets/ — refreshed by generate --screenshots)
/patches                          # patch-package patches (react-native-fs), applied on postinstall
/captures                         # GENERATED (gitignored): device screenshots from `bin/ivy.ts capture`
/worktrees                        # Git worktrees (gitignored; the only sanctioned worktree location)
```

## Database Schema

Column lists below are annotated summaries — NOT NULL constraints, foreign keys, and indexes are elided; `database.ts` holds the authoritative CREATE statements.

**files table (stores `Book` entities):**
```sql
id TEXT PRIMARY KEY            -- UUID, stable identifier
uri TEXT                       -- Local file:// path (NULL if archived/deleted)
name TEXT
duration INTEGER               -- milliseconds
position INTEGER               -- milliseconds (resume position)
updated_at INTEGER             -- timestamp (last modification)
updated_by TEXT                -- device ID that last modified this entity
title TEXT
artist TEXT
artwork TEXT                   -- base64 data URI, capped at 512px on extraction (see docs/2026-09-02-artwork-oom-repair.md)
file_size INTEGER              -- File size in bytes (indexed for fast lookup)
fingerprint BLOB               -- First 4KB of file (for exact matching)
hidden INTEGER NOT NULL DEFAULT 0  -- Soft-deleted (1 = removed from library)
chapters TEXT                  -- JSON array of chapter metadata
speed INTEGER NOT NULL DEFAULT 100  -- Playback speed (100 = 1.0x)
last_played_at INTEGER         -- Local-only (never synced); drives startup auto-load
summary TEXT                   -- Extras extracted from ffmetadata tags (see docs/BOOKS.md):
narrator TEXT                  --   summary=comment, narrator=composer
series TEXT
part TEXT                      -- TEXT: parts can be "0.5" or "1-3"
subtitle TEXT
date TEXT
language TEXT
metadata_version INTEGER       -- Extractor version that produced the extras (NULL = never extracted)
```

**clips table:**
```sql
id TEXT PRIMARY KEY            -- UUID
source_id TEXT                 -- References files.id (parent book)
uri TEXT                       -- Clip's own audio file
start INTEGER                  -- milliseconds (position in source file)
duration INTEGER               -- milliseconds
note TEXT
transcription TEXT             -- Auto-generated from audio (Whisper)
source_title TEXT              -- Book title/name snapshot at creation (survives book row loss)
source_artist TEXT             -- Book artist snapshot at creation
created_at INTEGER
updated_at INTEGER
updated_by TEXT                -- device ID that last modified this entity
```

**sessions table** (listening history):
```sql
id TEXT PRIMARY KEY            -- UUID
book_id TEXT NOT NULL          -- References files.id
started_at INTEGER NOT NULL    -- Timestamp when session began
ended_at INTEGER NOT NULL      -- Timestamp when session ended (updated during playback)
updated_at INTEGER
updated_by TEXT                -- device ID that last modified this entity
```

**sync_manifest table** (transport metadata — maps entities to Drive file IDs):
```sql
entity_type TEXT NOT NULL      -- 'book' | 'clip' | 'session'
entity_id TEXT NOT NULL
local_updated_at INTEGER       -- Legacy field (not used by new sync engine)
remote_updated_at INTEGER      -- Legacy field (not used by new sync engine)
remote_file_id TEXT            -- Drive file ID (JSON)
remote_audio_file_id TEXT      -- Drive file ID (audio, clips only)
remote_audio_version TEXT      -- Audio content version on Drive (md5Checksum, clips only)
synced_at INTEGER NOT NULL
PRIMARY KEY (entity_type, entity_id)
```

**sync_queue table** (outbox — pending changes to push):
```sql
id TEXT PRIMARY KEY
entity_type TEXT NOT NULL      -- 'book' | 'clip' | 'session'
entity_id TEXT NOT NULL
operation TEXT NOT NULL        -- 'upsert' | 'delete'
queued_at INTEGER NOT NULL
updated_at_when_queued INTEGER  -- Entity's updated_at when queued (stale detection)
attempts INTEGER DEFAULT 0     -- Retry count (retry forever; >= 3 surfaced as failing)
last_error TEXT
next_attempt_at INTEGER DEFAULT 0  -- Earliest next push attempt (exponential backoff)
UNIQUE(entity_type, entity_id) -- One pending op per entity
```

**sync_checkpoint table** (Drive changes cursor):
```sql
id INTEGER PRIMARY KEY CHECK (id = 1)
last_page_token TEXT           -- Drive changes.list page token
last_full_reconcile_at INTEGER -- Timestamp of last full reconcile
```

**sync_metadata table** (key-value sync state):
```sql
key TEXT PRIMARY KEY           -- 'lastSyncTime', 'deviceId'
value TEXT NOT NULL
```

**settings table** (single-row app settings):
```sql
id INTEGER PRIMARY KEY CHECK (id = 1)  -- Enforces single row
sync_enabled INTEGER NOT NULL DEFAULT 0
transcription_enabled INTEGER NOT NULL DEFAULT 1
delete_original_after_import INTEGER NOT NULL DEFAULT 0
clip_editor_linked INTEGER NOT NULL DEFAULT 1  -- Editor link toggle memory
```

**status table** (migration tracking):
```sql
id INTEGER PRIMARY KEY CHECK (id = 1)  -- Enforces single row
migration INTEGER NOT NULL             -- Last applied migration index
```


## Store State Structure

`store/types.ts` is the authoritative, annotated definition (`AppState` interface): `initialized`, `library`, `books`, `playback`, `clips`, `transcription`, `sync`, `settings`, `sessions`, `currentSessionBookId`. Context its comments don't carry:

- `initialized` — false until `initializeApplication` completes (the splash screen covers that window)
- `library.addOpId` — active import operation ID; the cancellation ownership claim
- `playback.uri`/`duration` — hardware state (what's loaded in the player), not book metadata
- `sync.failingCount` — push items with attempts >= 3, plus pull-quarantined ones
- `sessions` — keyed by session id; `currentSessionBookId` is a *book* id (no session id is held)


## Critical Architecture Decisions

### 1. **File Storage Strategy** 
External content: URIs (like Google Drive) become invalid after app restart. **Solution:**
- **All files are copied to app-owned storage** on first load
- Database stores: `uri` (local file:// path for playback)
- The native `FileCopier` module performs the copy to `Paths.document/audio/` (progress, fingerprint, cancel); `FileStorageService` provides the surrounding file utilities (stat, delete, list)
- Audio playback **only uses local file:// URIs**

### 2. **Time Units**
Everything internal is **milliseconds**. Convert to MM:SS only at display boundaries.

### 3. **State Management**
Single Zustand store is the source of truth for app state. Services hold only internal operational state (the player's setup flag and cached duration, the transcription queue's job list, the sync engine's in-flight/quarantine tracking) — never app state; they are constructed once in `services/index.ts` (the singleton registry). Store uses **immer middleware** for immutable updates via direct mutations:
- `store/types.ts` - Type definitions (AppState, Action, ActionFactory)
- `store/index.ts` - All state, action wiring, and event listeners in one place

**Async initialization:** The store is created synchronously with default state (`initialized: false`, `DEFAULT_SETTINGS`). The root layout calls `initializeApplication()` on mount, which runs database migrations first (`runMigrations` action — nothing touches the DB before it resolves), hydrates settings, starts the network watcher, warms the FFmpeg runtime (fire-and-forget `slicer.warmUp()`), seeds demo data if a seed bundle is present, hydrates the store (books, clips, sessions), auto-loads the last played book, starts transcription if enabled, and sets `initialized: true`. The native splash screen stays visible until then — `app/_layout.tsx` dismisses it when `initialized` flips (via `expo-splash-screen`).

**Migrations are async** (`(db, deps) => Promise<void>`, awaited in order), with native services injected via `MigrationDeps` so data-repair migrations can do real work (e.g. artwork re-encoding). Rules for writing one — a failed migration doesn't bump the index and reruns fully next launch:
- **Idempotent:** gate data work so a rerun after a mid-way failure is safe
- **Memory-lean:** never SELECT bulky columns for all rows at once; fetch ids first, then process row-at-a-time

### 4. **Async Database Layer**
All database methods use expo-sqlite's async API (`runAsync`, `getFirstAsync`, `getAllAsync`) to avoid blocking the UI thread. A few methods are intentionally kept synchronous for store initialization and fire-and-forget writes:
- **Sync reads:** `getSettings()`, `getLastPlayedBook()`, `getLastSyncTime()`, `getSyncMetadata()`, `getDeviceId()` (plus the cached `deviceId` getter) — tiny single-row lookups used during store init, covered by the splash screen; `getCheckpoint()` is the one sync read called outside init (mid-sync, same single-row rationale)
- **Sync writes:** `updateBookPosition()`, `updateSessionEndedAt()` — called from event handlers as fire-and-forget (the caller doesn't await them)
- **Sync utility:** `clearAllData()` — destructive, rarely called

**Action Factories:** Actions are defined in `src/actions/` as factory functions with explicit dependencies. This enables unit testing actions in isolation:

```typescript
// actions/update_settings.ts
export interface UpdateSettingsDeps {
  db: DatabaseService
  set: SetState
}

export type UpdateSettings = Action<[Settings]>

export const createUpdateSettings: ActionFactory<UpdateSettingsDeps, UpdateSettings> = (deps) => (
  async (settings) => {
    const { db, set } = deps
    await db.setSettings(settings)
    set({ settings })
  }
)

// store/index.ts - wires up dependencies
const updateSettings = createUpdateSettings({ db, set })
```

All actions are async (`Action<Args>` returns `Promise<void>`). Dependencies are wired in `store/index.ts`.

**Service Events:** Services extend `BaseService<Events>` and emit typed events. The store subscribes to relevant events during initialization:

```typescript
// In store initialization
audio.on('status', (status) => {
  set((state) => { state.playback.position = status.position })
})

// Service emits events internally
this.emit('status', { status: 'playing', position: 1000, duration: 60000 })
```

**Immer usage:** State updates use direct mutations on a draft (immer converts to immutable):
```typescript
// ✅ Correct - mutate draft directly
set((state) => {
  state.playback.status = 'playing'
  state.clips[id].note = 'updated'
  delete state.clips[id]
})

// ❌ Avoid - spread patterns are verbose and error-prone
set((state) => ({
  playback: { ...state.playback, status: 'playing' }
}))
```

**Store subscriptions:** Components must subscribe with narrow selectors
(`useStore(s => s.books)`), never selector-less `useStore()` — playback ticks
the store at 1 Hz, and whole-store subscriptions re-render every subscriber
every second, even with the screen off (background playback keeps JS alive).
Components that don't display position select scalar playback fields
(`status`/`uri`/`ownerId`), not the `playback` object. The root layout also
wraps the app in react-freeze's `<Freeze>` while backgrounded, deferring all
renders until the app returns to foreground (see
docs/2026-08-10-background-battery-fix.md).

## Unit Testing (Jest)

Run with `npm test` (or `npm run test:watch` for watch mode).

Tests are colocated in `__tests__/` directories next to the code they test — including the toolkit's own (`bin/__tests__/`, where `hygiene.test.ts` enforces repo gates). Action tests use shared helpers from `actions/__tests__/helpers.ts` for mock state, services, and immer-compatible `set`.


## Adding Features

### New Action
1. Create action factory in `src/actions/my_action.ts` with deps interface and type
2. Wire up in `store/index.ts`
3. Add to `AppState` interface in `store/types.ts`
4. Add UI in relevant screen/component

### New Database Field
1. Update interface in `services/storage/database.ts`
2. Append an async migration to the `migrations` array (idempotent + memory-lean; see rules above)
3. Update `upsertFile` or relevant methods
4. Update TypeScript types

### New Screen
1. Create in `src/screens/`
2. Add a route: `app/(tabs)/` for a tab (then update `app/(tabs)/_layout.tsx`), or a root route file in `app/` (like `settings.tsx`, `about.tsx`, `sessions.tsx`) for a pushed screen


## Quick Reference

Everything project-specific goes through the toolkit CLI — `bin/ivy.ts` (full reference at the end of this file).

**Start dev server (Metro/Fast Refresh, Mac-only):** `bin/ivy.ts dev` (`npm start` redirects here)
**Run unit tests:** `npm test` (with console logs: `npm run test:verbose`)
**Typecheck / lint:** `npx tsc --noEmit` / `npm run lint` (not run by the toolkit or `prepare` — run them yourself)
**Run e2e tests:** `bin/ivy.ts test --e2e`
**Build (env-aware, Mac or container):** `bin/ivy.ts build <variant> [--install]`
**Recreate Play Store screenshots (+ web/README refresh):** `bin/ivy.ts generate --screenshots` (see docs/2026-07-21-playstore-screenshots.md)
**Prepare a release (user-run, interactive):** `bin/ivy.ts prepare --version X.Y.Z --changes <markdown>`
**Environment + built-APK report (incl. ffmpeg linking):** `bin/ivy.ts doctor`

### Driving the running app from the CLI

`bin/ivy.ts help` — read WORKFLOW, RECIPES and GOTCHAS before touching the device (reproduced at the end of this file). App and emulator facts the toolkit can't fix for you:

- A fresh app has no media session until a book is opened (`state` says so). Play at the end of a book does not restart it: seek first.
- A dialog on top (Error, Archive Book) blocks every tap under it; dismiss it first. Books archived by a flow (add-clip.yaml) open as "Book Unavailable"; re-run `maestro/subflows/import-book.yaml` for a clean library.
- The document picker's search finds nothing if MediaStore is wedged (`device fix-media`) or Gboard's stylus promo steals the field (the toolkit disables it before flows; `settings put secure stylus_handwriting_enabled 0` by hand).
- `adb shell am start` URLs containing `&` must be quoted (`drive --seek` does).

## Preparing a Release

The whole release is one toolkit command, **run by the user on the Mac** (it prompts for the keystore password — interactive-only, never stored, never in agent logs). Design: docs/2026-08-11-release-command.md.

```bash
bin/ivy.ts prepare --version X.Y.Z --changes '<markdown>' [--screenshots]
```

Pipeline: preflight (tools, node_modules, release keystore, samples/data.json, emulator, local.properties pollution, clean tree on master, version valid, no VERSIONS.md section yet, tag free) → password prompt + verify → version bump (package.json + lockfile via `npm version` + VERSIONS.md section — files only, committed after tests; a failure reverts them) → maestro build → upgrade test (previous release → this build) → jest + full e2e suite → [screenshots + web/README refresh, committed as `web: refresh screenshots`] → commit `release: vX.Y.Z` → release build → artifact checks (version stamp, ffmpeg closure, R8) → deliver `dist/ivy-release-X.Y.Z.{aab,apk,-mapping.txt}` + cache the maestro APK as the next release's upgrade-test base → tag `vX.Y.Z` → checklist of the remaining manual steps (push, Play Console upload, GitHub release — never automated).

**Agent's role:** write the `--changes` markdown (changeset since last tag, VERSIONS.md style: Features/Fixes/Infra), print the exact `prepare` command for the user to paste, and stop — the command itself needs a TTY the agent doesn't have. Pass `--screenshots` only if UI changed since the last release.

Versioning: package.json is the single version of record; `withIvyVersionName` derives versionName and versionCode (major\*10000 + minor\*100 + patch; Play requires strictly increasing, so minor/patch stay < 100 — `prepare` preflight enforces this). app.json's `version` field exists but is unmaintained — ignore it.

`bin/ivy.ts build release` alone still builds, checks, and delivers to `dist/` (for rebuilds), but never tags — tagging is `prepare`'s job, gated on the test suite.


## Native Packaging Changes

Any change touching native packaging — `modules/ivy` jniLibs (including the vendored ffmpeg runtime), `FFmpegEnvironment.kt`, `expo.useLegacyPackaging` — needs two checks JS tests can't provide:

1. **Closure check:** `bin/ivy.ts doctor` walks the `NEEDED` graph from `libffmpeg.so` in every built APK it finds, cross-checks `FFmpegEnvironment.SYMLINKED_LIBS`, and fails on any soname that won't resolve on device (see docs/CLIPS.md "Vendored shared libs"). Run it after any packaging change. (This used to be a build-time gate — `withIvyFfmpegClosureCheck`, dropped 2026-07-30 once the packaging refactor had settled; revive from git history if packaging churn returns.)
2. **Fresh-install smoke test (manual):** create a clip / import a chaptered file on a **freshly installed** app, not an upgrade — `no_backup/` survives updates, and stale extracted libs there can mask linking failures that break fresh installs (this happened: see git history of `FFmpegEnvironment.kt`). **Uninstalling requires explicit user approval** — the user knows the device's installation state and whether the upgrade path (e.g. pending DB migrations) must be tested before wiping it.

**Build-variant note:** four buildTypes — `debug` (Metro dev loop), `maestro` (e2e: preview clone + test affordances; NOT debuggable — that flips CMake to Debug and breaks linking against the release prefab; DB tooling uses adb root on it), `preview` (release twin for on-device testing, zero test surface), `release`. Test affordances gate on the `ivy_build_variant` resource (`debug`/`maestro`/`production`, see `plugins/withIvyBuildTypes.js` + `BuildInfoModule.kt`) — never on `__DEV__`. `release`, `preview` and `maestro` are all minified + obfuscated by R8 (full mode; `enableMinifyInReleaseBuilds` in app.json, and the `preview` block sets `minifyEnabled`/`proguardFiles` explicitly because the template wires them into `release {}` only) — so the e2e suite runs the shipped bytecode; `debug` stays unminified. R8 can't affect the exec'd-binary link path (native/filesystem, not JVM); the `*Module` classes are kept by name via RN's `NativeModule` rule, and whisper.rn + react-native-audio-api are kept whole (they resolve Java members from JNI by name; keep rules in app.json). `doctor` and the post-build artifact checks verify all of this statically (R8 marker per DEX, mapping id, kept modules, keep-whole packages) and `build release`/`prepare` deliver the mapping to `dist/`. Design + testing plan: docs/2026-09-05-r8-obfuscation.md.


## Environment

If the current working directory is `/workspace`, you are running inside a container. In that case, you can install software, run scripts, etc with freedom and permissions will be automatically granted.

**CRITICAL — `/workspace` is a bind mount of the developer's Mac checkout.** Android build artifacts embed absolute paths (`sdk.dir` in `local.properties`, module paths in `android/build/generated/autolinking/autolinking.json`, CMake caches under `node_modules/*/android/.cxx`), so a Gradle build run inside the container **breaks the next build on the Mac**, and vice versa (the symptom is "No matching variant … No variants exist" for every RN library at once, or a bad-`sdk.dir` warning).

Rules for Android builds in the container:

- **NEVER run Gradle in `/workspace` directly.** Use the toolkit, which in the container mirrors the repo to a container-local clone (`/home/claude/ivy-build`) and builds there — incremental across sessions, zero pollution of the mount:

  ```bash
  bin/ivy.ts build debug --arch arm64-v8a
  ```

  It rsyncs the full working tree (including uncommitted and untracked files, excluding node_modules and build outputs).
- The whole `android/` tree is untracked (generated by `expo prebuild --clean`), so nothing under it can be committed. Never edit it by hand either — change `modules/ivy` or the `plugins/` config plugins instead, then regenerate.
- **Recovery only** — if `/workspace` was polluted anyway (a Gradle run in the mount, from either side; symptom above), fix it with `bin/ivy.ts clean` (sweeps `modules/ivy/android/build` and `node_modules/*/android/{build,.cxx}`, then regenerates `android/` from scratch via `expo prebuild --clean`). The next build on the affected machine is a slow full rebuild — that's why the isolated build is the rule, not cleaning.

## Toolkit CLI Reference

Full `bin/ivy.ts help` output (keep in sync when the toolkit changes):

```
Ivy toolkit — project CLI (build, test, prepare, drive, inspect)

Usage: bin/ivy.ts <command> [args] [--device <serial>]

Commands:

  build <variant> [--install] [--arch <abi>]
      Variants: debug | maestro | preview | release.
      Env-aware: on the Mac builds in android/; in the container mirrors the
      tree to $IVY_BUILD_DIR (default /home/claude/ivy-build) and builds
      there (never Gradle in /workspace). release = assemble + bundle (AAB),
      runs prebuild --clean first and needs $KEYSTORE_PASSWORD (prompts on
      a TTY). preview/release artifacts are checked after building (version
      stamp, ffmpeg closure, R8 marker + mapping + kept classes); release is
      also copied to dist/ivy-release-<version>.{aab,apk,-mapping.txt}.
      --install installs the built APK on the device. --arch limits native ABIs (e.g. arm64-v8a for emulator).

  clean
      Recover a Gradle-polluted /workspace: sweep native build outputs and
      regenerate android/ via expo prebuild --clean.

  dev [--clear]
      Start the Metro dev server (Fast Refresh) for the installed debug
      build. Mac-only (the emulator cannot reach a container-local Metro);
      never builds native — install first with `build debug --install`.
      --clear resets the Metro cache. Ctrl-C to stop.

  test [name] [--unit | --e2e | --upgrade [--from <tag>]] [--server-only [--port <n>]]
      No flag = both suites. --unit = jest. --e2e = maestro suite; pushes and
      media-scans the fixtures first, verifies delete-original afterwards.
      [name] runs a single case (jest pattern or maestro flow name) and needs
      exactly one of --unit/--e2e. E2e runs auto-start the bridge server —
      a localhost HTTP interface flows use for device control (network
      toggles, media keys, DB checks) via maestro/scripts/bridge.js, and
      which serves the Whisper model to maestro builds (cache/whisper/
      ggml-tiny.bin, fetched once; reached from the device via adb reverse;
      model/mode/* simulates download failures). BRIDGE_URL is injected
      into every run, adb goes root up front (rootable emulator), and
      network state is restored afterwards (emulator only). --server-only
      starts just the bridge (foreground, Ctrl-C to stop) for hand-run
      maestro sessions.
      --upgrade = migration upgrade smoke test (emulator-only, wipes app
      state): installs the previous release's maestro APK (from cache/upgrade/,
      cache-missed tags are rebuilt from git — Mac-only), seeds old-schema
      data + per-migration hooks (bin/upgrade_hooks.ts), upgrade-installs the
      current maestro build, verifies migrations + data + no crash. --from
      tests against a specific cached base tag. Needs a built maestro APK,
      sqlite3, and a rootable emulator image (DB access via adb root — the
      maestro variant is not debuggable). See docs/MIGRATIONS.md.

  drive --file <flow.yaml> | --inline '<steps yaml>' | --tap <id|text> | --nav <route>
        | --seek <ms> | --play | --pause
      Make the running app do something (one mode per call).
        --file    run a maestro flow (fixtures pushed first)
        --inline  run ad-hoc maestro steps, no flow file needed
                  e.g. --inline '- tapOn: "Library"' (the steps run from a
                  temp file: refer to scripts by absolute path)
        --tap     find element by resource-id/text/content-desc in the view
                  hierarchy and tap it via adb (fast path, no maestro startup)
        --nav     deep-link via ivy:// scheme (e.g. --nav player)
        --seek    move the main player to <ms> (test builds; deep link
                  ivy://player?seek=<ms>), confirmed via the media session
        --play / --pause
                  deterministic play/pause through the media session: presses
                  the media key only if the state differs, then confirms it
      Flow screenshots (takeScreenshot: screenshots/<name>) are collected into
      maestro/screenshots/ after every --file/--inline run.

  generate [--audio] [--artwork] [--feature] [--screenshots] [--icon]
      Generate store/web assets from samples/ into dist/ (one or more flags).
        --audio        silent demo MP3s from samples/data.json (cached)
        --artwork      demo covers from samples/data.json (python3 + Pillow)
        --feature      render samples/feature.html -> dist/feature.png (chromium)
        --screenshots  Play Store screenshots (seed demo data, status-bar demo
                       mode, maestro flow) -> dist/screenshots/; also refreshes
                       web/assets/ and the README composite. Emulator-only.
        --icon         dist/icon-512.png from the app icon (ImageMagick)

  prepare --version <X.Y.Z> --changes <markdown> [--screenshots]
      The release pipeline, start to finish. Interactive (keystore password
      prompted up front, held in memory only) — run it on the Mac from a
      terminal. Steps: preflight -> password -> version bump (files only;
      committed after tests) -> maestro build -> upgrade test -> jest + e2e
      suite -> [screenshots ->] commit -> release build -> artifact checks ->
      dist/ delivery + upgrade-base cache -> tag. A test failure reverts the
      bumped files, leaving the tree clean. Nothing is pushed or uploaded; it
      ends with a checklist of the manual Play Console / GitHub steps.

  doctor
      Full environment report: tools, devices, project state, the
      local.properties pollution check, all built APKs/AABs found (with
      version name/code, ffmpeg closure check on each APK, R8 checks: marker
      in every DEX, mapping id, native modules kept by name, JNI-lookup
      packages unstripped). Exits nonzero on failures.

  device connect
      adb connect to the Mac-hosted emulator (host.docker.internal:5555).

  device wipe
      Clear app data (pm clear). Emulator-only.

  device fix-media
      Recover a wedged MediaStore (force-stop provider + full volume rescan).

  device put [--fixtures] [--samples]
      --fixtures  push + media-scan the e2e test audio files
      --samples   push the demo seed bundle; the app wipes its DB and
                  self-seeds on next launch. Emulator-only.

  capture [name]
      Screenshot the device into captures/<name>.png (default: shot-<timestamp>).

  state
      One-line playback state from the system media session (playing/paused,
      position, speed, title) — the hardware truth, any build, sub-second.

  tree [--raw]
      Dump the view hierarchy. uiautomator while the app is idle; maestro's
      hierarchy (slower JVM start, no idle wait) while it is playing or when
      uiautomator gives up on a never-idle UI. Default output is condensed to
      elements with text/resource-id/content-desc; --raw prints the full XML
      (or maestro's JSON). Note: React Native testIDs surface as resource-ids.

  logs [--tag <tag>] [--follow]
      Logcat scoped to the app's pid (app must be running). Default dumps and
      exits; --follow streams. --tag filters (e.g. ReactNativeJS).

  query "<sql>"
      Run SQL against a pulled copy of the app database (read-only; needs
      sqlite3 on the host, plus the debug build variant — run-as only works
      on debuggable builds — or, for other variants, a rootable emulator
      (adb root fallback).

  help
      This text.

Global:
  --device <serial>   target device; defaults to the sole attached device,
                      honors $ANDROID_SERIAL (same as adb)
  --no-log            skip the run log. build/test/generate/prepare/doctor
                      tee their full output (stdout+stderr, ANSI stripped)
                      to log/<command>.txt, overwritten each run.

Destructive commands (wipe, put --samples, generate --screenshots) refuse to
run on anything that is not verifiably an emulator. There is no override flag.

WORKFLOW
  Seeing a change in the real app, from a cold start:
    device connect                       # container -> Mac-hosted emulator
    build maestro --install --arch arm64-v8a   # ~3 min; JS-only changes too
    drive --file maestro/subflows/import-book.yaml   # known state: fresh app,
                                         #   one book, transcription off
    drive --tap "Ivy Test Book"          # library row -> player, playing
    state                                # playing at 0.0s @1x — Ivy Test Book
    capture before                       # captures/before.png
  Then act (drive), observe (state, tree, capture, logs, query), repeat.
  Variant: maestro (e2e twin of the release build, with test affordances:
  --seek, TLTRACE, 5s sleep preset). debug needs Metro on the Mac.

  Observe                              Act
    state    playback, sub-second        drive --play/--pause  confirmed toggle
    tree     screen elements + bounds    drive --seek <ms>     main player
    capture  screenshot -> captures/     drive --tap <id|text> one element
    logs     app logcat (--tag)          drive --nav <route>   deep link
    query    the app DB, read-only       drive --inline/--file maestro steps

RECIPES
  Book at a known position, playing:
    drive --seek 5000 && drive --play
  Clip of ~N seconds (draft grows with linked bounds while playing):
    drive --inline '- tapOn: { id: add-clip-button }
    - runScript: { file: /abs/path/maestro/scripts/sleep.js, env: { MS: "3000" } }
    - tapOn: { id: clip-editor-pause-button }
    - tapOn: "Save"'
  Value changing over time (timer labels, counters) — dumps are too slow:
    for i in $(seq 12); do adb exec-out screencap -p > s/$i.png; sleep 0.3; done
    then crop the region from each and stack the crops into one image.
  Screen state from a flow's own eyes:
    takeScreenshot: screenshots/<name>   ->  maestro/screenshots/<name>.png
  Timeline internals (maestro/debug builds):
    logs --tag ReactNativeJS | grep TLTRACE   # gestures, seeks, mode changes
  Playback ownership / actions:
    logs --tag ReactNativeJS | grep -F -e '[Play]' -e '[Pause]' -e '[Seek]'

GOTCHAS
  - The app's play/pause button and the media key are toggles. Never press
    them blind: state first, or drive --play/--pause, which check.
  - A *stopped* session (track ended, clip viewer open) ignores the media
    key: drive --seek first, or tap the on-screen button.
  - tree: instant while idle, ~4s while playing (maestro hierarchy), ~25s
    only when uiautomator times out on an animating, non-playing screen.
  - Toolkit startup is cheap (~0.2s); maestro sessions are not (~10s JVM).
    Batch steps in one --inline rather than many --tap/--inline calls.
```


# Next Steps

You have read the introduction to Ivy. If you were told you'll be working on specific topics, and there's guides for those topics, read them now. Learn. When done, inform the user you've read them.

