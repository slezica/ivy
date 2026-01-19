# AI Agent Reference - Ivy

**Quick onboarding guide for AI agents.** Read this first when starting a new session.

## Critical Architecture Decisions

### 1. **File Storage Strategy** 🔥 MOST IMPORTANT
External content: URIs (like Google Drive) become invalid after app restart. **Solution:**
- **All files are copied to app-owned storage** on first load
- Database stores: `uri` (local file:// path for playback)
- `FileStorageService` manages copying to `Paths.document/audio/`
- Audio playback **only uses local file:// URIs**

### 2. **Time Units**
Everything internal is **milliseconds**. Convert to MM:SS only at display boundaries.

### 3. **State Management**
Single Zustand store is the source of truth. Services are stateless. Store uses **immer middleware** for immutable updates via direct mutations. Store is split into slices:
- `store/types.ts` - Central type definitions (read top-down to understand shape)
- `store/library.ts` - Book management and file loading
- `store/playback.ts` - Audio playback state and controls
- `store/clips.ts` - Clip CRUD operations
- `store/sync.ts` - Cloud sync state and actions
- `store/settings.ts` - App settings
- `store/index.ts` - Service wiring and slice composition

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

### 4. **Library Status Enum**
`'loading'` → `'idle'` ⇄ `'adding'`
- `loading`: Initial state, fetching files from database
- `idle`: Library ready
- `adding`: Copying a new file to app storage

### 5. **Playback Status Enum**
`'idle'` → `'loading'` → `'paused'` ⇄ `'playing'`
- `idle`: No track loaded (initial state)
- `loading`: Loading audio player
- `paused`/`playing`: Playback states

Event callback preserves transitional state (`loading`) - only updates to `paused`/`playing` when not in transition.

### 6. **Playback Ownership** 🔥 IMPORTANT
Multiple UI components can control playback (PlayerScreen, ClipViewer, ClipEditor). To prevent conflicts:
- `playback.ownerId` tracks which component last took control
- Components pass `ownerId` when calling `play()` to claim ownership
- Ownership persists until another component calls `play()` with different `ownerId`
- Components check `playback.ownerId === myId` to know if they're in control

**Main Player ID:** `MAIN_PLAYER_OWNER_ID = 'main'` (exported from `utils/index.ts`)
- Well-known ID for the main player tab
- `loadFile()` uses this ID so PlayerScreen adopts newly loaded books
- Any component can target the main player by using this ID

```typescript
// Main player checks for its well-known ID
const isOwner = playback.ownerId === MAIN_PLAYER_OWNER_ID

// Other components generate stable IDs
const ownerId = useRef('clip-editor-123').current
const isOwner = playback.ownerId === ownerId

// Check ownership
const isPlaying = isOwner && playback.status === 'playing'

// Claim ownership when playing
await play({ fileUri, position, ownerId })
```

**Local state pattern:** Each player maintains its own local state:
- `ownPosition`: the position this player remembers (all players)
- `ownBook`: the book this player is showing (PlayerScreen only - clips know their source)
- When owner: sync `ownPosition` from `playback.position` via effect
- When not owner: keep local position (allows seeking without affecting playback)
- On play: claim ownership with `ownPosition`
- On seek: always update `ownPosition`, only call `seek()` if owner

### 7. **Books and Archiving** 🔥 IMPORTANT
The domain entity is called `Book` (not AudioFile). A Book represents an audiobook/podcast in the library.

**File Fingerprint:** Each book stores `file_size` + `fingerprint` (first 4KB as BLOB). This enables:
- **Duplicate detection:** Adding the same file twice reuses the existing book record
- **Automatic restore:** Adding a file that matches an archived book restores it with preserved position and clips

**Archiving:** Users can archive books to free storage while preserving clips:
- `book.uri === null` means the book is archived
- Archiving deletes the underlying audio file but keeps the database record
- Clips continue to work (they have their own audio files)
- Archived books appear in a separate "Archived" section in LibraryScreen

**Archive action flow:**
1. Optimistic store update (set `uri: null`)
2. Database update (with rollback on failure)
3. Async file deletion (fire-and-forget)

**Restore flow (automatic on file add):**
1. File copied to app storage
2. Fingerprint read (file size + first 4KB)
3. If fingerprint matches archived book → restore: update `uri`, replace metadata, preserve position
4. If fingerprint matches active book → delete duplicate file, touch `updated_at`
5. If no match → create new book record

```typescript
// Check if book is archived
const isArchived = book.uri === null

// Archive a book
await archiveBook(bookId)

// Restore happens automatically when same file is added again
```

## Project Overview

**React Native Expo app** for podcast/audiobook playback with:
- Library management (file history with resume positions + metadata)
- Clips/bookmarks with notes and automatic transcription
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
  ├── store/
  │   ├── index.ts                # Service wiring & slice composition
  │   ├── types.ts                # Central type definitions (AppState, slices)
  │   ├── library.ts              # Library slice (books, file loading)
  │   ├── playback.ts             # Playback slice (audio controls)
  │   ├── clips.ts                # Clips slice (clip CRUD)
  │   ├── sync.ts                 # Sync slice (cloud backup)
  │   └── settings.ts             # Settings slice
  ├── services/
  │   ├── index.ts                # Barrel exports
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
  │   │   ├── auth.ts             # Google OAuth (expo-auth-session)
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
  │   └── SettingsScreen.tsx      # App settings (sync toggle, etc.)
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
  │       ├── Modal.tsx           # Reusable modal (overlay tap to close)
  │       ├── ScreenArea.tsx      # Safe area wrapper (react-native-safe-area-context)
  │       ├── Header.tsx          # Reusable header (title, subtitle, noBorder)
  │       ├── EmptyState.tsx      # Empty state display
  │       ├── IconButton.tsx      # Circular icon button
  │       └── ActionMenu.tsx      # Overflow menu (3-dot)
  ├── utils/
  │   └── index.ts                # Shared utilities (formatTime, formatDate)
  └── theme.ts

/app
  ├── _layout.tsx                 # Root (includes LoadingModal)
  ├── +not-found.tsx              # Catch-all redirect (handles notification clicks)
  ├── settings.tsx                # Settings screen route
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
uri TEXT                       -- Local file:// path (NULL if archived)
name TEXT
duration INTEGER               -- milliseconds
position INTEGER               -- milliseconds (resume position)
updated_at INTEGER             -- timestamp (last modification)
title TEXT
artist TEXT
artwork TEXT                   -- base64 data URI
file_size INTEGER              -- File size in bytes (indexed for fast lookup)
fingerprint BLOB               -- First 4KB of file (for exact matching)
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

**sync_manifest table** (tracks last-synced state per entity):
```sql
entity_type TEXT NOT NULL      -- 'book' | 'clip'
entity_id TEXT NOT NULL
local_updated_at INTEGER       -- Local timestamp at last sync
remote_updated_at INTEGER      -- Remote timestamp at last sync
remote_file_id TEXT            -- Drive file ID (JSON)
remote_mp3_file_id TEXT        -- Drive file ID (MP3, clips only)
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
```

## Store State Structure

Store is composed of slices. See `store/types.ts` for authoritative type definitions.

```typescript
// LibrarySlice
library: { status: 'loading' | 'idle' | 'adding' }
books: Record<string, Book>
fetchBooks, loadFile, loadFileWithUri, loadFileWithPicker, archiveBook

// PlaybackSlice
playback: {
  status: 'idle' | 'loading' | 'paused' | 'playing'
  position: number              // milliseconds
  uri: string | null            // URI currently loaded in player (hardware state)
  duration: number              // Duration of loaded audio (hardware state)
  ownerId: string | null        // ID of component controlling playback
}
play, pause, seek, seekClip, skipForward, skipBackward, syncPlaybackState

// ClipSlice
clips: Record<string, ClipWithFile>
fetchClips, addClip, updateClip, deleteClip, shareClip

// SyncSlice
sync: {
  isSyncing: boolean            // Sync in progress
  pendingCount: number          // Items waiting to sync
  lastSyncTime: number | null   // Timestamp of last successful sync
  error: string | null          // Last sync error (null if successful)
}
syncNow, autoSync, refreshSyncStatus

// SettingsSlice
settings: { sync_enabled: boolean }
updateSettings

// Context-based playback API
play(context?: { fileUri, position, ownerId? })  // Loads file if different, claims ownership
seek(context: { fileUri, position })             // Only seeks if fileUri matches loaded file
pause()                                          // Pauses, preserves ownership
```

**PlaybackState is hardware-only:** The `playback` object reflects what's loaded in the player, not domain state. Components look up `Book` metadata from the `books` map using the URI when needed.

## File Loading Flow (Critical)

1. **User picks file** → `pickedFile.uri` (external content: URI)
2. **Copy to app storage:**
   - `library.status = 'adding'` → Modal shows "Adding to library..."
   - `fileStorageService.copyToAppStorage()` → returns local `file://` URI
3. **Read metadata:**
   - `metadataService.readMetadata(localUri)` → title, artist, artwork, duration
4. **Read fingerprint:**
   - `fileStorageService.readFileFingerprint(localUri)` → fileSize, fingerprint
5. **Save to database:**
   - Check for existing book by fingerprint (restore archived or dedupe)
   - `dbService.upsertBook()` returns the `Book` with generated `id`
   - `uri = localUri` (local file:// path)
6. **Done** - Book added to library, no auto-play

**On tap from library:**
- Book loaded into player via `play({ fileUri, position, ownerId })`
- Playback starts from saved position

**On reload from library:**
- Book selected by `id` from store (indexed by id)
- If `book.uri` exists on disk → load directly
- If `book.uri` is null → book is archived, show alert

## Development Tools

Library screen header has a triple-dot menu (top-right) with:
- **Settings** - Opens settings screen (always visible)
- **Load Sample** - Loads bundled test file (dev only)
- **Reset App** - Clears all data (dev only)

### Sample (dev only)
- Loads bundled test audio file (`assets/test/test-audio.mp3`)
- Useful for quick testing without file picker
- Adds to library without auto-play

### Reset (dev only)
- Clears database (files, clips, sessions, settings)
- Unloads audio player
- Resets store state
- **Note:** Doesn't delete copied files from storage (orphaned)
- Access via: `store.__DEV_resetApp()`

## E2E Testing (Maestro)

Automated UI tests using [Maestro](https://maestro.mobile.dev/). Tests are in `maestro/` directory.

**Run all tests:**
```bash
maestro test maestro/
```

**Run single test:**
```bash
maestro test maestro/smoke-test.yaml
```

**Available flows:**
- `smoke-test.yaml` - Verifies empty states (Library, Clips screens)
- `load-and-play.yaml` - File loading, playback controls, library persistence
- `clip-crud.yaml` - Clip creation, note editing, deletion
- `timeline-gestures.yaml` - Timeline tap-to-seek, swipe-to-scrub, flick momentum

**Ad-hoc testing:** During development, you can write quick one-off Maestro flows to test specific interactions without committing them. Useful for debugging or verifying fixes.

**Test file:** A bundled test audio file (`assets/test/test-audio.mp3`) is available. The Sample button loads it without needing the file picker.

## Unit Testing (Jest)

Run with `npm test` (or `npm test:watch` for watch mode).

Tests are colocated in `__tests__/` directories next to the code they test.

**Current coverage:**
- `services/backup/__tests__/` - Sync planning (`planner.test.ts`) and conflict resolution (`merge.test.ts`)

## Common Issues & Solutions

### TypeScript Errors
- **Expo FileSystem API changed in v54:**
  - ❌ OLD: `FileSystem.documentDirectory`, `getInfoAsync`, `copyAsync`
  - ✅ NEW: `Paths.document`, `Directory`, `File` classes
  - Import: `import { Paths, Directory, File } from 'expo-file-system'`

### File Won't Load
1. Check console logs in `loadFile()` function
2. Verify local file exists: `fileStorageService.fileExists()`
3. Check if AudioService timeout (10s) - means player can't load file
4. Try reset button and re-add file

### Content URI Issues
- External URIs (Google Drive, etc.) **will fail** after app restart
- This is expected - files must be re-copied from local storage
- Only local `file://` URIs should be used for playback


## Shared Components

`src/components/shared/` contains reusable UI components:

- **ScreenArea** - Wraps screens with safe area insets (uses `react-native-safe-area-context`, NOT deprecated RN `SafeAreaView`)
- **Header** - Standard screen header with `title`, `subtitle`, optional `children`, and `noBorder` prop
- **EmptyState** - Centered empty state display with `title` and `subtitle`
- **ActionMenu** - Bottom sheet action menu (3-dot overflow pattern) with `ActionMenuItem[]`

## Utilities

`src/utils/index.ts` exports:
- `generateId()` - Generates a UUID for new database entities (uses `crypto.randomUUID()`)
- `MAIN_PLAYER_OWNER_ID` - Well-known owner ID for the main player tab (`'main'`)
- `formatTime(ms)` - Converts milliseconds to `MM:SS` or `H:MM:SS` format
- `formatDate(timestamp)` - Formats timestamp as `MMM D, YYYY`

**Note:** `react-native-get-random-values` polyfill is imported in `index.js` to enable `crypto.randomUUID()`.

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

## Clip File Storage

Clips have their own persistent audio files, stored separately from source files:

**Storage Location:** `DocumentDirectoryPath/clips/{uuid}.mp3`

**Lifecycle:**
- **Create**: Audio sliced from source file, saved to clips directory using clip's UUID as filename
- **Update**: If bounds change, new slice replaces old file (same UUID filename, requires source file)
- **Delete**: Clip audio file deleted
- **Share**: Uses existing clip file directly (no temp file needed)

**File Naming:** Clip's UUID (e.g., `a1b2c3d4-e5f6-7890-abcd-ef1234567890.mp3`)

### Clip Independence from Source 🔥 IMPORTANT

Clips can exist independently of their source book. The source book's `uri` becomes `null` when archived.

**ClipWithFile interface:**
```typescript
interface ClipWithFile extends Clip {
  file_uri: string | null    // Source book URI (null if archived)
  file_name: string          // Preserved from when clip was created
  file_title: string | null
  file_artist: string | null
  file_duration: number
}
```

**When source book exists (`file_uri !== null`):**
- ClipViewer plays from source book at `clip.start` position
- ClipEditor can expand/contract clip bounds, re-slices from source
- "Go to source" and "Edit" menu options available
- Timeline shows full source book duration

**When source book is archived (`file_uri === null`):**
- ClipViewer plays from clip's own audio file (`clip.uri`) at position 0
- ClipEditor is disabled (Edit button hidden)
- "Go to source" and "Edit" menu options hidden
- Timeline shows clip duration only
- Clip metadata (file_name, file_title, etc.) preserved from when clip was created

**Code pattern for handling source availability:**
```typescript
// Determine playback source
const hasSourceFile = clip.file_uri !== null
const playbackUri = hasSourceFile ? clip.file_uri! : clip.uri
const playbackDuration = hasSourceFile ? clip.file_duration : clip.duration
const initialPosition = hasSourceFile ? clip.start : 0
```

## Transcription Architecture

On-device automatic clip transcription using Whisper:

**Flow:**
1. Clip created → `transcriptionService.queueClip(clipId)`
2. `audioSlicerService` extracts first 10s from clip's audio file (`clip.uri`)
3. `whisperService` transcribes the audio (using whisper.rn with ggml-tiny model)
4. Result stored in `clips.transcription` column
5. Callback notifies store to update UI

**Services** (`services/transcription/`):
- `whisper.ts` - Downloads/caches Whisper model, runs transcription
- `queue.ts` - Background queue that processes clips sequentially (uses slicer)

**Key Points:**
- Model auto-downloads on first use (~75MB ggml-tiny.bin from HuggingFace)
- Processing is sequential (one clip at a time) to avoid overload
- Failed transcriptions retry on next app start (transcription stays null)
- Transcription displayed in ClipViewer below the time
- `note` and `transcription` are separate fields (user notes vs auto-generated)

## Google Drive Sync 🔥 IMPORTANT

Multi-device sync system using Google Drive as cloud backend. Works offline-first: changes queue locally and sync when connectivity returns.

**What gets synced:**
- Book metadata (positions, timestamps) as JSON files
- Clip metadata + audio as JSON + MP3 pairs

**What doesn't get synced:**
- Full audiobook files (too large, user can re-add from source)

**File structure in Drive:**
```
Ivy/
  books/
    book_abc123-def456.json
  clips/
    clip_def456-789xyz.json
    clip_def456-789xyz.mp3
```

Files named: `{type}_{uuid}.{ext}`. One file per entity (overwritten on update).

### Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Zustand Store │────▶│  Offline Queue   │────▶│  Google Drive   │
│  (books, clips) │     │  (sync_queue)    │     │  (Ivy/ folder)  │
└────────┬────────┘     └──────────────────┘     └────────┬────────┘
         │                                                │
         │              ┌──────────────────┐              │
         └─────────────▶│   Sync Manifest  │◀─────────────┘
                        │ (sync_manifest)  │
                        └──────────────────┘
```

**Services** (`services/backup/`):
- `auth.ts` - Google OAuth via `@react-native-google-signin/google-signin`
- `drive.ts` - Drive REST API wrapper (resumable uploads, list, download, delete)
- `queue.ts` - Offline queue (persists changes for later sync)
- `sync.ts` - Incremental sync with manifest-based change detection and conflict resolution

### Offline Queue

Store actions automatically queue changes for sync:
- `updateBookPosition` → queues book upsert
- `archiveBook` → queues book upsert
- `addClip`, `updateClip` → queues clip upsert
- `deleteClip` → queues clip delete

Queue persists to SQLite, survives app restarts. Processed on next sync with retry logic (max 3 attempts).

### Sync Manifest

Tracks last-synced state per entity to enable incremental sync:
- `local_updated_at` - What was the entity's timestamp when we last synced?
- `remote_updated_at` - What was the remote timestamp when we last synced?

Change detection: `entity.updated_at > manifest.local_updated_at` means changed locally since sync.

### Sync Flow

1. **Process queue** - Push all queued local changes first
2. **Push phase** - Upload any remaining local changes, handle conflicts
3. **Pull phase** - Download remote changes not present locally
4. **Notify store** - Callback triggers `fetchBooks()`/`fetchClips()` to refresh UI

### Conflict Resolution

Conflicts occur when same entity modified on two devices before syncing:

**Books:**
| Field | Strategy |
|-------|----------|
| `position` | **Max value wins** (user progressed further) |
| `title`, `artist`, `artwork` | Last-write-wins |

**Clips:**
| Field | Strategy |
|-------|----------|
| `note` | **Concatenate with conflict marker** |
| `start`, `duration` | Last-write-wins |
| `transcription` | Prefer non-null |

Note conflict example:
```
My original note

--- Conflict (Jan 18, 2026) ---
Edit from other device
```

### Auto-Sync

App auto-syncs when returning to foreground (if `settings.sync_enabled`):
- Must have sync enabled in settings
- Must be authenticated (no sign-in prompt for auto-sync)
- At least 5 minutes since last sync
- Silent unless conflicts/errors occur

### Sync Service API

The sync service receives callbacks via constructor:

```typescript
// Service setup (in store initialization)
const sync = new BackupSyncService(db, drive, auth, queue, {
  onStatusChange: onSyncStatusChange,
  onDataChange: onSyncDataChange,
})

// Listener functions (hoisted, defined at end of store scope)
function onSyncStatusChange(status) {
  set((state) => { state.sync = { ...status, lastSyncTime: ... } })
}

function onSyncDataChange(notification) {
  if (notification.booksChanged.length > 0) get().fetchBooks()
  if (notification.clipsChanged.length > 0) get().fetchClips()
}
```

The store exposes thin wrappers that components call:
- `syncNow()` - Fire-and-forget, status updates via `sync` state
- `autoSync()` - Only runs if `settings.sync_enabled`
- `refreshSyncStatus()` - Updates `sync.pendingCount`

### Edge Case: Delete vs Modify

If Device A deletes a clip while Device B modifies it (later timestamp), then both sync:
- Device A's delete removes clip from Drive
- Device B's modification re-uploads clip
- Device A downloads the "resurrected" clip

**Result:** Modification wins (last-write-wins semantics). No tombstones implemented.

### Google Cloud Setup

1. Create project in Google Cloud Console
2. Enable **Google Drive API** (APIs & Services → Library)
3. Create **Android** OAuth client:
   - Package name: `com.salezica.ivy`
   - SHA-1: from `cd android && ./gradlew signingReport`
4. Create **Web application** OAuth client:
   - No redirect URIs needed
   - Copy client ID to `auth.ts` (`WEB_CLIENT_ID`)

**Key Points:**
- Native library handles token refresh automatically
- Public Drive folder (visible to user in their Drive)
- Sync UI in Settings screen (toggle + "Sync now" link + status)
- Both Android + Web OAuth clients required

**Documentation:** See `docs/sync_system.md` for full educational walkthrough.

## Adding Features

### New Playback Control
1. Add action to `src/store/playback.ts` slice
2. Call `AudioPlayerService` method (from `services/audio/player.ts`)
3. Update `playback.status` if needed
4. Add UI in `PlayerScreen.tsx`

### New Database Field
1. Update interface in `services/storage/database.ts`
2. Add migration with `ALTER TABLE` (wrapped in try/catch)
3. Update `upsertFile` or relevant methods
4. Update TypeScript types

### New Screen
1. Create in `src/screens/`
2. Add route in `app/(tabs)/`
3. Update tab bar in `app/(tabs)/_layout.tsx`

## Key Patterns to Follow

✅ **Do:**
- Use services for all I/O (never call react-native-track-player, SQLite, FileSystem directly from components)
- Import services from `services/` barrel export (e.g., `import { databaseService } from '../services'`)
- Use dependency injection for services that depend on other services
- Store all times in milliseconds internally
- Set `library.status = 'adding'` when copying files, `playback.status = 'loading'` when loading player
- Use local file:// URIs for all audio playback
- Keep services stateless (state lives in store)
- Pass `{ fileUri, position, ownerId }` when calling `play()` from UI components
- Maintain local position state in playback components
- Check `playback.ownerId === myId` before syncing from global playback state
- Check `clip.file_uri !== null` before enabling edit/jump-to-source features
- Use `clip.file_uri` (source) when available, fall back to `clip.uri` (clip's own file) when not
- Use `book.id` (UUID) as the stable identifier for books (not `uri` which can be null)
- Use `generateId()` from utils when creating new database entities
- Look up `Book` metadata from `books` map using URI when needed (audio state only has uri/duration)
- Queue changes via `offlineQueueService.queueChange()` when modifying synced entities
- Use manifest comparison for sync change detection (not just timestamp comparison)
- Use service callbacks for sync status (store doesn't orchestrate auth)

❌ **Don't:**
- Use external content: URIs for audio playback
- Trigger React re-renders during TimelineBar animation (use refs)
- Modify `status` from polling callback when in transitional state
- Call `upsertBook` without a local URI
- Call `play()` or `seek()` without file context from UI components
- Assume global `playback.position` is relevant to your component (check ownership first)
- Assume `Book.uri` is non-null (check before using for playback - null means archived)
- Attempt to re-slice clips when source book is archived (`file_uri === null`)
- Read book metadata from `playback` state (it only has hardware state: uri, duration)
- Modify books/clips without queueing for sync (changes will be lost on other devices)
- Delete manifest entries manually (sync service manages them)

## Quick Reference

**Start dev server:** `npm start`
**Run e2e tests:** `maestro test maestro/`
**Load test file:** Library menu → Load Sample (dev only)
**Reset app data:** Library menu → Reset App (dev only)
**Settings:** Library menu → Settings
**Sync to Drive:** Settings → Sync now (or enable auto-sync toggle)
**Time format:** Always milliseconds internally
**ID format:** UUIDs (string) for all entities - use `generateId()` from utils
**Book playback:** Use `book.uri` (local path) - check for null first (null = archived)
**Book identifier:** Use `book.id` (UUID, stable), not `uri` (can be null)
**Clip source check:** `clip.file_uri !== null` means source book available
**Archive check:** `book.uri === null` means book is archived
**Library status:** `loading → idle ⇄ adding`
**Playback status:** `idle → loading → paused ⇄ playing`
**Playback state:** Hardware-only (uri, duration, position, status, ownerId) - no Book metadata
**Sync docs:** `docs/sync_system.md` - full educational walkthrough of sync architecture

## Custom ESLint Rules

Project-specific rules in `eslint/` directory, used as `ivy/<rule-name>`:

- **jsx-align-ternary-single** - In JSX ternaries, `?` and `:` must be on aligned new lines
- **jsx-align-ternary-chain** - Chained ternaries must have consistent alignment
- **jsx-newline-around-multiline** - Blank line required between sibling JSX elements when either spans multiple lines

## System Media Controls

Uses `react-native-track-player` v5 for system-level playback integration:

**Features:**
- Media notification with play/pause, skip forward/backward
- Lock screen controls
- Bluetooth/headphone controls
- Background playback

**Architecture:**
- `player.ts` - Wraps TrackPlayer API, converts ms↔seconds, manages setup
- `integration.ts` - Playback service handling remote events (runs in separate context)
- `index.js` - Registers playback service at app startup (must be before expo-router)

**Key Points:**
- TrackPlayer uses **seconds**, app uses **milliseconds** - player.ts handles conversion
- `load()` accepts metadata (title, artist, artwork) for notification display
- Events are handled via `TrackPlayer.addEventListener()` in integration.ts
- Notification click opens `ivy://notification.click` → caught by `+not-found.tsx` → redirects to player
- v5 API: use `TrackPlayer.getProgress()` instead of separate `getPosition()`/`getDuration()`


