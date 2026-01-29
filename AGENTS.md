# AI Agent Reference for Ivy

**Quick onboarding guide for AI agents.** Read this first when starting a new session.


## What is Ivy?

Ivy is a local-first audiobook/podcast player written in React Native. It can:

- Import audio files into its library
- Play audio files in the library
- Extract, play and share clips
- Remember listening sessions
- Auto-sync data and clips to Google Drive


## Topics

These are in-depth guides to aspects of the application. CRITICAL: before you start working on one of the following topics, read the corresponding guide to learn about it.

### Books and Library

File import, archiving, deletion, and restoration. See **[docs/BOOKS.md](docs/BOOKS.md)** for the full guide.

**Quick summary:** Files are copied to app-owned storage on import. Each book is fingerprinted (file size + first 4KB) for duplicate detection. Adding a file that matches an archived/deleted book restores it with preserved position. Books use soft-delete (`hidden` flag), never hard-delete.

**Key rules for working with books:**
- `book.uri` can be null — always check before using for playback (null = archived or deleted)
- Use `book.id` (UUID) as the stable identifier, not `uri` (which changes on restore)
- Archive/delete are optimistic with rollback — update store first, then DB
- Every book mutation must queue for sync (`syncQueue.queueChange`)

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
- Every clip mutation must queue for sync (`syncQueue.queueChange`)
- `note` and `transcription` are separate fields — don't conflate them

### Transcription

On-device automatic clip transcription using Whisper. See **[docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md)** for the full guide.

**Quick summary:** Clips are queued for transcription on creation → processed sequentially by a background queue → first 10s of audio extracted and fed to on-device Whisper → result saved to `clips.transcription` column. Controlled by `settings.transcription_enabled`.


### Sessions

Automatic listening activity tracking. See **[docs/SESSIONS.md](docs/SESSIONS.md)** for the full guide.

**Quick summary:** Main player playback creates sessions (time ranges per book) → `ended_at` updated every 5s while playing → finalized on pause (sessions < 1s are deleted). 5-minute resume window prevents fragmentation. Local-only, not synced.

### Sync and Backup

Offline-first multi-device sync via Google Drive. See **[docs/SYNC.md](docs/SYNC.md)** for the full guide.

**Quick summary:** Store actions queue changes to SQLite → sync drains queue and does manifest-based incremental push/pull → conflicts resolved by pure merge functions → store notified of remote changes via events.


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
- Native Kotlin modules for audio slicing

## File Structure

```
/src
  ├── actions/                    # Action factories (one file per action)
  │   ├── constants.ts            # Shared constants (durations, paths)
  │   ├── play.ts, pause.ts, ... # Playback actions
  │   ├── add_clip.ts, ...       # Clip actions
  │   ├── load_file.ts, ...      # Library actions
  │   └── ...                     # ~28 action files total
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
  │   │   └── picker.ts           # Document picker
  │   ├── transcription/
  │   │   ├── queue.ts            # Background transcription queue
  │   │   └── whisper.ts          # On-device speech-to-text (whisper.rn)
  │   ├── backup/
  │   │   ├── auth.ts             # Google OAuth (@react-native-google-signin)
  │   │   ├── drive.ts            # Google Drive REST API wrapper
  │   │   ├── queue.ts            # Offline change queue (persists pending sync ops)
  │   │   ├── sync.ts             # Sync orchestrator (state → plan → execute)
  │   │   ├── planner.ts          # Pure sync planning (what ops are needed)
  │   │   ├── merge.ts            # Pure conflict resolution (book/clip merge)
  │   │   ├── types.ts            # Shared backup types
  │   │   └── __tests__/          # Unit tests for planner and merge
  │   └── system/
  │       └── sharing.ts          # Share clips via native share sheet
  ├── screens/
  │   ├── LibraryScreen.tsx       # Book list (active + archived sections) with archive action
  │   ├── PlayerScreen.tsx        # Main player
  │   ├── ClipsListScreen.tsx     # Clip management
  │   ├── SessionsScreen.tsx      # Listening history
  │   └── SettingsScreen.tsx      # App settings (sync toggle, transcription toggle)
  ├── components/
  │   ├── ClipViewer.tsx          # Clip playback (own position state, timeline, transcription)
  │   ├── ClipEditor.tsx          # Clip editing (own position state, selection timeline, note)
  │   ├── LoadingModal.tsx        # "Adding..." / "Loading..." modal
  │   ├── timeline/               # GPU-accelerated timeline component
  │   │   ├── Timeline.tsx        # Unified timeline (playback + selection)
  │   │   ├── useTimelinePhysics.ts # Scroll/momentum/selection hook
  │   │   ├── constants.ts        # Dimensions, physics, animation timing
  │   │   ├── utils.ts            # timeToX, xToTime, segment heights
  │   │   └── index.ts            # Barrel exports
  │   └── shared/
  │       ├── ScreenArea.tsx      # Safe area wrapper (react-native-safe-area-context)
  │       ├── Header.tsx          # Reusable header (title, subtitle, noBorder)
  │       ├── InputHeader.tsx     # Search header (text input, close button)
  │       ├── EmptyState.tsx      # Empty state display
  │       ├── IconButton.tsx      # Circular icon button
  │       ├── ActionMenu.tsx      # Overflow menu (3-dot)
  │       ├── Dialog.tsx          # Simple dialog/modal component
  │       └── ErrorBoundary.tsx   # React error boundary
  ├── utils/
  │   └── index.ts                # Shared utilities (formatTime, formatDate)
  └── theme.ts

/app
  ├── _layout.tsx                 # Root (includes LoadingModal)
  ├── +not-found.tsx              # Catch-all redirect (handles notification clicks)
  ├── settings.tsx                # Settings screen route
  ├── sessions.tsx                # Listening history route
  └── (tabs)/
      ├── _layout.tsx             # Tab nav (disables tabs when no file)
      ├── index.tsx               # Library
      ├── player.tsx              # Player
      └── clips.tsx               # Clips

/index.js                         # App entry point (registers RNTP playback service)

/android/app/src/main/java/com/salezica/ivy/
  ├── AudioSlicerModule.kt        # Native module for audio slicing
  ├── AudioSlicerPackage.kt       # Native module package registration
  ├── AudioMetadataModule.kt      # Native module for metadata extraction
  └── AudioMetadataPackage.kt     # Native module package registration

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
title TEXT
artist TEXT
artwork TEXT                   -- base64 data URI
file_size INTEGER              -- File size in bytes (indexed for fast lookup)
fingerprint BLOB               -- First 4KB of file (for exact matching)
hidden INTEGER NOT NULL DEFAULT 0  -- Soft-deleted (1 = removed from library)
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
created_at INTEGER
updated_at INTEGER
```

**sessions table** (listening history):
```sql
id TEXT PRIMARY KEY            -- UUID
book_id TEXT NOT NULL          -- References files.id
started_at INTEGER NOT NULL    -- Timestamp when session began
ended_at INTEGER NOT NULL      -- Timestamp when session ended (updated during playback)
```

**sync_manifest table** (tracks last-synced state per entity):
```sql
entity_type TEXT NOT NULL      -- 'book' | 'clip'
entity_id TEXT NOT NULL
local_updated_at INTEGER       -- Local timestamp at last sync
remote_updated_at INTEGER      -- Remote timestamp at last sync
remote_file_id TEXT            -- Drive file ID (JSON)
remote_audio_file_id TEXT      -- Drive file ID (audio, clips only)
synced_at INTEGER NOT NULL
PRIMARY KEY (entity_type, entity_id)
```

**sync_queue table** (offline operation queue):
```sql
id TEXT PRIMARY KEY
entity_type TEXT NOT NULL      -- 'book' | 'clip'
entity_id TEXT NOT NULL
operation TEXT NOT NULL        -- 'upsert' | 'delete'
queued_at INTEGER NOT NULL
attempts INTEGER DEFAULT 0     -- Retry count (max 3)
last_error TEXT
UNIQUE(entity_type, entity_id) -- One pending op per entity
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
library: { status: 'loading' | 'idle' | 'adding' }
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
  status: 'idle' | 'downloading' | 'processing'
  pending: Record<string, true>   // Clips currently queued/processing
}
sync: {
  isSyncing: boolean            // Sync in progress
  pendingCount: number          // Items waiting to sync
  lastSyncTime: number | null   // Timestamp of last successful sync
  error: string | null          // Last sync error (null if successful)
}
settings: { sync_enabled: boolean, transcription_enabled: boolean }
sessions: Record<string, SessionWithBook>  // Listening history (keyed by id)
currentSessionBookId: string | null

// Actions
fetchBooks, loadFile, loadFileWithUri, loadFileWithPicker, archiveBook, deleteBook
play, pause, seek, seekClip, skipForward, skipBackward, syncPlaybackState
fetchClips, addClip, updateClip, deleteClip, shareClip
startTranscription, stopTranscription
syncNow, autoSync, refreshSyncStatus
updateSettings
fetchSessions, trackSession
__DEV_resetApp
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


## Utilities

`src/utils/index.ts` exports:
- `generateId()` - Generates a UUID for new database entities (uses `expo-crypto`)
- `MAIN_PLAYER_OWNER_ID` - Well-known owner ID for the main player tab (`'main'`)
- `formatTime(ms)` - Converts milliseconds to `MM:SS` or `H:MM:SS` format
- `formatDate(timestamp)` - Formats timestamp as relative ("Today", "Yesterday", "X days ago") or locale date
- `throttle(fn, ms)` - Creates a throttled function that executes at most once per interval


## Native Modules

Located in `android/app/src/main/java/com/salezica/ivy/`:

**AudioSlicer**:
- Kotlin native module for extracting audio segments
- Wrapped by `services/audio/slicer.ts` (used for sharing and transcription)
- Interface: `sliceAudio(inputPath, startMs, endMs, outputPath) → Promise<string>`

**AudioMetadata**:
- Kotlin native module for extracting ID3 metadata (title, artist, artwork, duration)
- Wrapped by `services/audio/metadata.ts`
- Interface: `extractMetadata(filePath) → Promise<{ title, artist, artwork, duration }>`


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


## Key Patterns

- All I/O goes through services — never call track-player, SQLite, or FileSystem from components
- Services are stateless; all state lives in the Zustand store
- All times are milliseconds internally
- `book.uri` can be null (archived/deleted) — always check before using for playback


## Quick Reference

**Start dev server:** `npm start`
**Run tests:** `npm test`
**Run tests with console logs**: `npm test:verbose`
**Run e2e tests:** `maestro test maestro/`


# Next Steps

You have read the introduction to Ivy. If you were told you'll be working on specific topics, and there's guides for those topics, read them now. Learn. When done, inform the user you've read them.

