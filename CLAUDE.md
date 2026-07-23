# AI Agent Reference for Ivy

**Quick onboarding guide for AI agents.** Read this first when starting a new session.


## What is Ivy?

Ivy is a local-first audiobook/podcast player written in React Native. It can:

- Import audio files into its library (from local files)
- Play audio files in the library
- Extract, play and share clips
- Remember listening sessions
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

### Books and Library

File import (local files), metadata editing, archiving, deletion, and restoration. See **[docs/BOOKS.md](docs/BOOKS.md)** for the full guide.

**Quick summary:** Files are copied to app-owned storage on import. Each book is fingerprinted (file size + first 4KB) for duplicate detection. Adding a file that matches an archived/deleted book restores it with preserved position. Books use soft-delete (`hidden` flag), never hard-delete.

**Key rules for working with books:**
- `book.uri` can be null — always check before using for playback (null = archived or deleted)
- Use `book.id` (UUID) as the stable identifier, not `uri` (which changes on restore)
- Archive/delete are optimistic with rollback — update store first, then DB
- Every book mutation must queue for sync (`db.queueChange`) — except archive/delete, which are per-device and must NOT queue or bump `updated_at` (see docs/SYNC.md)
- On restore, existing metadata (title/artist/artwork) wins over ID3 tags — protects user edits

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

**Quick summary:** Clips are sliced from source books as standalone `.m4a` audio files at `clips/{uuid}.m4a`. They work independently of the source — if the book is archived, clips fall back to their own audio. Each clip has a note (user-written) and a transcription (auto-generated).

**Key rules for working with clips:**
- Check `clip.file_uri !== null` before enabling edit or "go to source"
- Use `clip.file_uri` (source) when available, fall back to `clip.uri` (clip's own file)
- Clips LEFT JOIN their book: **all** `file_*` fields (`file_name`, `file_duration` included) are null when the book row is missing — don't assume any of them
- Every clip mutation must queue for sync (`db.queueChange`); clip deletion is global (propagates via sync tombstones)
- `note` and `transcription` are separate fields — don't conflate them

### Transcription

On-device automatic clip transcription using Whisper. See **[docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md)** for the full guide.

**Quick summary:** Clips are queued for transcription on creation → processed sequentially by a background queue → first 60s of audio extracted and fed to on-device Whisper → result persisted via the store's `updateClip` action (the queue never writes the DB; empty results are valid, only errors skip persistence). Controlled by `settings.transcription_enabled`.


### Sessions

Automatic listening activity tracking. See **[docs/SESSIONS.md](docs/SESSIONS.md)** for the full guide.

**Quick summary:** Main player playback creates sessions (time ranges per book) → `ended_at` updated every 5s while playing → finalized on pause (sessions < 1s are deleted). 5-minute resume window prevents fragmentation. Sessions are synced across devices (whole-entity LWW; deletions propagate via tombstones).

### Sync and Backup

Offline-first multi-device sync via Google Drive. See **[docs/SYNC.md](docs/SYNC.md)** for the full guide.

**Quick summary:** Store actions queue changes to a local outbox → sync pulls remote changes via Drive's change feed (incremental, not full crawl) → per-entity LWW reconciliation (last writer wins, no per-field merging) → outbox drained with update-in-place uploads, stale detection, and retry-forever backoff → store notified of remote changes via events. Deletion semantics: book archive/delete are per-device (never queued, no `updated_at` bump); clip/session deletions propagate via full-payload tombstones. Duplicate book identities (same audio imported on two devices) merge by fingerprint onto the smaller id.


## Project Overview

**React Native Expo app** for podcast/audiobook playback with:
- Library management (file history with resume positions + metadata)
- Clips/bookmarks with notes and automatic transcription
- Listening history (session tracking)
- GPU-accelerated timeline UI (Skia Canvas)
- Auto-play, resume from last position
- On-device speech-to-text via Whisper (privacy-first)
- Metadata extraction (title, artist, artwork) via native Android module
- Clip sharing via native share sheet
- **System media controls** (notification, lock screen, Bluetooth)

**Tech Stack:**
- React Native 0.81.5 + Expo 54
- Zustand + immer for state
- Expo Router (file-based tabs)
- react-native-track-player v5 (playback + system media controls)
- SQLite (expo-sqlite)
- Skia for timeline rendering
- New FileSystem API: `Paths.document`, `Directory`, `File` classes
- whisper.rn for on-device transcription
- react-native-safe-area-context (not deprecated SafeAreaView)
- expo-splash-screen (manual splash control during async initialization)
- Native Kotlin modules for audio slicing, metadata, file copy (local module in `modules/ivy`, autolinked)
- youtubedl-android 0.18.1 — `:ffmpeg` artifact only (bundled `libffmpeg.so` for clip slicing + chapter extraction; the yt-dlp engine was removed, see docs/2026-06-30-remove-ytdlp.md)
- `android/` is generated (`expo prebuild --clean` is safe): never edit or commit it — hand-written native code lives in `modules/ivy`, gradle customization in `plugins/` config plugins

## File Structure

```
/src
  ├── actions/                    # Action factories (one file per action)
  │   ├── constants.ts            # Shared constants (durations, paths)
  │   ├── play.ts, pause.ts, ... # Playback actions
  │   ├── add_clip.ts, ...       # Clip actions
  │   ├── load_file.ts, ...      # Library actions (local files)
  │   ├── initialize_application.ts # App startup (hydrate store, auto-load, dismiss splash)
  │   └── ...                     # ~35 action files total
  ├── store/
  │   ├── index.ts                # All state, action wiring, event listeners
  │   └── types.ts                # Type definitions (AppState, Action, ActionFactory)
  ├── services/
  │   ├── index.ts                # Barrel exports
  │   ├── base.ts                 # BaseService with typed events (on/off/emit)
  │   ├── audio/
  │   │   ├── player.ts           # react-native-track-player wrapper
  │   │   ├── integration.ts      # Playback service for remote control events
  │   │   ├── metadata.ts         # ID3/metadata extraction
  │   │   └── slicer.ts           # Audio segment extraction (native module)
  │   ├── storage/
  │   │   ├── database.ts         # SQLite operations
  │   │   ├── files.ts            # File copying to app storage
  │   │   ├── copier.ts           # Native file copier (progress, fingerprint, cancel)
  │   │   ├── picker.ts           # Document picker
  │   │   └── __tests__/          # database.test.ts + sqlite_adapter (real SQLite in Jest)
  │   ├── transcription/
  │   │   ├── queue.ts            # Background transcription queue
  │   │   └── whisper.ts          # On-device speech-to-text (whisper.rn)
  │   ├── backup/
  │   │   ├── auth.ts             # Google OAuth (@react-native-google-signin)
  │   │   ├── drive.ts            # Google Drive REST API (upload, download, changes, update-in-place)
  │   │   ├── sync.ts             # Sync engine (pull via change feed, push via outbox, LWW reconcile)
  │   │   ├── types.ts            # Shared backup types
  │   │   └── __tests__/          # Sync engine unit tests + FakeDrive scenario harness
  │   └── system/
  │       └── sharing.ts          # Share clips via native share sheet
  ├── screens/
  │   ├── LibraryScreen.tsx       # Book list (active + archived sections) with archive action
  │   ├── PlayerScreen.tsx        # Main player
  │   ├── ClipsListScreen.tsx     # Clip management
  │   ├── SessionsScreen.tsx      # Listening history
  │   └── SettingsScreen.tsx      # App settings (sync, transcription)
  ├── components/
  │   ├── MetadataEditor.tsx      # Book metadata editing (title, artist; artwork read-only)
  │   ├── ClipViewer.tsx          # Clip playback (own position state, timeline, transcription)
  │   ├── ClipEditor.tsx          # Clip editing (own position state, selection timeline, note)
  │   ├── LibraryLoadingDialog.tsx # "Adding..." / "Loading..." dialog
  │   ├── timeline/               # GPU-accelerated timeline component
  │   │   ├── Timeline.tsx        # Unified timeline (playback + selection)
  │   │   ├── engine.ts           # Pure physics engine (scroll, momentum, playback follow)
  │   │   ├── useTimelinePhysics.ts # React adapter hook (gestures, rAF loop)
  │   │   ├── constants.ts        # Dimensions, physics, animation, zoom constants
  │   │   ├── utils.ts            # timeToX, xToTime, bar heights
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
  │   └── index.ts                # Shared utilities (formatTime, formatDate)
  └── theme.ts

/app
  ├── _layout.tsx                 # Root (splash screen control, initialization gate)
  ├── +not-found.tsx              # Catch-all redirect (handles notification clicks)
  ├── settings.tsx                # Settings screen route
  ├── sessions.tsx                # Listening history route
  └── (tabs)/
      ├── _layout.tsx             # Tab nav (disables tabs when no file)
      ├── index.tsx               # Library
      ├── player.tsx              # Player
      └── clips.tsx               # Clips

/index.js                         # App entry point (registers RNTP playback service)

/modules/ivy                      # Local native module ("ivy-native"), autolinked via the modules/ dir
  ├── package.json                # Internal package name: ivy-native (must differ from root "ivy")
  ├── react-native.config.js      # Registers IvyPackage with RN core autolinking
  └── android/
      ├── build.gradle            # Library module; carries the youtubedl-android :ffmpeg dependency
      ├── src/main/jniLibs/       # Vendored ffmpeg runtime deps (libexpat, libcrypto, libandroid-*) per ABI — see docs/CLIPS.md
      └── src/main/java/com/
          ├── salezica/ivy/
          │   ├── IvyPackage.kt           # Single autolinked ReactPackage (aggregates the four below)
          │   ├── FFmpegEnvironment.kt    # LD_LIBRARY_PATH + soname symlinks for exec'ing libffmpeg.so
          │   ├── AudioSlicerModule.kt    # Native module for audio slicing
          │   ├── AudioSlicerPackage.kt
          │   ├── AudioMetadataModule.kt  # Native module for metadata extraction
          │   ├── AudioMetadataPackage.kt
          │   ├── FileCopierModule.kt     # Native module for file copy with progress
          │   ├── FileCopierPackage.kt
          │   ├── ChapterReaderModule.kt  # Native module for chapter extraction (FFmpeg -f ffmetadata)
          │   └── ChapterReaderPackage.kt
          └── yausername/youtubedl_android/
              └── YoutubeDLException.kt   # Shim for the removed yt-dlp :library (see docs/2026-06-30-remove-ytdlp.md)

/plugins                          # Expo config plugins (applied in app.json) — recreate all gradle customization on prebuild
  ├── withIvySigning.js           # signingConfigs from credentials/ (release uses $KEYSTORE_PASSWORD)
  ├── withIvyPreviewBuildType.js  # `preview` buildType (embedded bundle, debug-signed)
  ├── withIvyHermesFix.js         # arch-aware hermesc path (arm64 Linux container)
  └── withIvyVersionName.js       # versionName from package.json at build time

/credentials                      # Keystores (untracked, NEVER commit release.keystore)
  ├── debug.keystore              # Standard RN debug key
  └── release.keystore            # Release key (alias 'ivy', password via $KEYSTORE_PASSWORD)

/android                          # GENERATED by `expo prebuild --clean` — untracked, never hand-edited

/maestro                          # Maestro e2e test flows
  ├── smoke-test.yaml             # Empty state verification
  └── load-and-play.yaml          # File loading and playback test

/assets/test
  └── test-audio.mp3              # Bundled test file for automated tests
```

## Database Schema

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
artwork TEXT                   -- base64 data URI
file_size INTEGER              -- File size in bytes (indexed for fast lookup)
fingerprint BLOB               -- First 4KB of file (for exact matching)
hidden INTEGER NOT NULL DEFAULT 0  -- Soft-deleted (1 = removed from library)
chapters TEXT                  -- JSON array of chapter metadata
speed INTEGER NOT NULL DEFAULT 100  -- Playback speed (100 = 1.0x)
last_played_at INTEGER         -- Local-only (never synced); drives startup auto-load
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
```

**status table** (migration tracking):
```sql
id INTEGER PRIMARY KEY CHECK (id = 1)  -- Enforces single row
migration INTEGER NOT NULL             -- Last applied migration index
```


## Store State Structure

See `store/types.ts` for authoritative type definitions (`AppState` interface).

```typescript
// State
initialized: boolean               // false until initializeApplication completes
library: {
  status: 'idle' | 'adding' | 'duplicate' | 'error'
  addProgress: number | null     // 0-100 percent (copy)
  addOpId: string | null         // Active operation ID (for cancellation)
  message: string | null         // Status message shown during loading
}
books: Record<string, Book>
playback: {
  status: 'idle' | 'loading' | 'paused' | 'playing'
  position: number              // milliseconds
  uri: string | null            // URI currently loaded in player (hardware state)
  duration: number              // Duration of loaded audio (hardware state)
  ownerId: string | null        // ID of component controlling playback
}
clips: Record<string, ClipWithFile>
transcription: {
  status: 'off' | 'starting' | 'on' | 'error'
  pending: Record<string, true>   // Clips currently queued/processing
}
sync: {
  isSyncing: boolean            // Sync in progress
  pendingCount: number          // Items waiting to sync
  failingCount: number          // Repeatedly failing items (push attempts >= 3 + pull quarantined)
  lastSyncTime: number | null   // Timestamp of last successful sync
  error: string | null          // Last sync error (null if successful)
}
settings: { sync_enabled: boolean, transcription_enabled: boolean, delete_original_after_import: boolean }
sessions: Record<string, SessionWithBook>  // Listening history (keyed by id)
currentSessionBookId: string | null
```


## Critical Architecture Decisions

### 1. **File Storage Strategy** 
External content: URIs (like Google Drive) become invalid after app restart. **Solution:**
- **All files are copied to app-owned storage** on first load
- Database stores: `uri` (local file:// path for playback)
- `FileStorageService` manages copying to `Paths.document/audio/`
- Audio playback **only uses local file:// URIs**

### 2. **Time Units**
Everything internal is **milliseconds**. Convert to MM:SS only at display boundaries.

### 3. **State Management**
Single Zustand store is the source of truth. Services are stateless. Store uses **immer middleware** for immutable updates via direct mutations:
- `store/types.ts` - Type definitions (AppState, Action, ActionFactory)
- `store/index.ts` - All state, action wiring, and event listeners in one place

**Async initialization:** The store is created synchronously with default state (`initialized: false`). The root layout calls `initializeApplication()` on mount, which hydrates the store (books, clips, sessions), auto-loads the last played book, starts transcription if enabled, and sets `initialized: true`. The native splash screen stays visible until initialization completes (via `expo-splash-screen`).

### 4. **Async Database Layer**
All database methods use expo-sqlite's async API (`runAsync`, `getFirstAsync`, `getAllAsync`) to avoid blocking the UI thread. A few methods are intentionally kept synchronous for store initialization and fire-and-forget writes:
- **Sync reads:** `getSettings()`, `getLastPlayedBook()`, `getLastSyncTime()`, `getSyncMetadata()`, `getDeviceId()` — tiny single-row lookups used during store init, covered by the splash screen
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
    deps.db.setSettings(settings)
    deps.set({ settings })
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

## Unit Testing (Jest)

Run with `npm test` (or `npm test:watch` for watch mode).

Tests are colocated in `__tests__/` directories next to the code they test. Action tests use shared helpers from `actions/__tests__/helpers.ts` for mock state, services, and immer-compatible `set`.


## Adding Features

### New Action
1. Create action factory in `src/actions/my_action.ts` with deps interface and type
2. Wire up in `store/index.ts`
3. Add to `AppState` interface in `store/types.ts`
4. Add UI in relevant screen/component

### New Database Field
1. Update interface in `services/storage/database.ts`
2. Add migration with `ALTER TABLE` (wrapped in try/catch)
3. Update `upsertFile` or relevant methods
4. Update TypeScript types

### New Screen
1. Create in `src/screens/`
2. Add route in `app/(tabs)/`
3. Update tab bar in `app/(tabs)/_layout.tsx`


## Quick Reference

**Start dev server:** `npm start`
**Run tests:** `npm test`
**Run tests with console logs**: `npm test:verbose`
**Run e2e tests:** `maestro test maestro/`
**Recreate Play Store screenshots:** `npm run screenshots` (see docs/2026-07-21-playstore-screenshots.md)
**Check ffmpeg native linking:** `node scripts/check-ffmpeg-closure.js <built-apk>`


## Native Packaging Changes

Any change touching native packaging — `modules/ivy` jniLibs, `FFmpegEnvironment.kt`, the youtubedl-android `:ffmpeg` artifact, `expo.useLegacyPackaging` — needs two checks JS tests can't provide:

1. **Closure check (build-enforced):** `checkFfmpegClosure` runs automatically as a finalizer of `assembleRelease` and `assemblePreview` (via `plugins/withIvyFfmpegClosureCheck.js`), so a broken closure **fails the build** — no one has to remember. It walks the `NEEDED` graph from `libffmpeg.so`, cross-checks `FFmpegEnvironment.SYMLINKED_LIBS`, and fails on any soname that won't resolve on device (see docs/CLIPS.md "Vendored shared libs"). Run it by hand with `node scripts/check-ffmpeg-closure.js <apk>`.
2. **Fresh-install smoke test (manual):** create a clip / import a chaptered file on a **freshly installed** app, not an upgrade — `no_backup/` survives updates, and stale extracted libs there can mask linking failures that break fresh installs (this happened: see git history of `FFmpegEnvironment.kt`). **Uninstalling requires explicit user approval** — the user knows the device's installation state and whether the upgrade path (e.g. pending DB migrations) must be tested before wiping it.

**Build-variant note:** release builds do **not** minify (`android.enableMinifyInReleaseBuilds` is unset → R8 off), so the `preview`/`maestro` lineage and `release` behave identically for native loading. Even if R8 were enabled it couldn't affect the exec'd-binary link path (native/filesystem, not JVM), and the module classes stay reachable via `IvyPackage`. The closure check runs on the release APK regardless.


## Environment

If the current working directory is `/workspace`, you are running inside a container. In that case, you can install software, run scripts, etc with freedom and permissions will be automatically granted.

**CRITICAL — `/workspace` is a bind mount of the developer's Mac checkout.** Android build artifacts embed absolute paths (`sdk.dir` in `local.properties`, module paths in `android/build/generated/autolinking/autolinking.json`, CMake caches under `node_modules/*/android/.cxx`), so a Gradle build run inside the container **breaks the next build on the Mac**, and vice versa (the symptom is "No matching variant … No variants exist" for every RN library at once, or a bad-`sdk.dir` warning).

Rules for Android builds in the container:

- **NEVER run Gradle in `/workspace` directly.** Use the isolation script, which mirrors the repo to a container-local clone (`/home/claude/ivy-build`) and builds there — incremental across sessions, zero pollution of the mount:

  ```bash
  scripts/container-build.sh :app:assembleDebug -PreactNativeArchitectures=arm64-v8a
  ```

  It rsyncs the full working tree (including uncommitted and untracked files, excluding node_modules and build outputs). Pass any Gradle tasks/flags as arguments.
- The whole `android/` tree is untracked (generated by `expo prebuild --clean`), so nothing under it can be committed. Never edit it by hand either — change `modules/ivy` or the `plugins/` config plugins instead, then regenerate.
- **Recovery only** — if `/workspace` was polluted anyway (a Gradle run in the mount, from either side; symptom above), fix it with `npm run clean` (sweeps `modules/ivy/android/build` and `node_modules/*/android/{build,.cxx}`, then regenerates `android/` from scratch via `expo prebuild --clean`). The next build on the affected machine is a slow full rebuild — that's why the isolation script is the rule, not cleaning.

# Next Steps

You have read the introduction to Ivy. If you were told you'll be working on specific topics, and there's guides for those topics, read them now. Learn. When done, inform the user you've read them.

