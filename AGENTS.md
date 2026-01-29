# AI Agent Reference - Ivy

**Quick onboarding guide for AI agents.** Read this first when starting a new session.

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

Event handler preserves transitional state (`loading`) - only updates to `paused`/`playing` when not in transition.

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

### 7. **Books, Archiving, and Deletion** 🔥 IMPORTANT
The domain entity is called `Book` (not AudioFile). A Book represents an audiobook/podcast in the library.

**File Fingerprint:** Each book stores `file_size` + `fingerprint` (first 4KB as BLOB). This enables:
- **Duplicate detection:** Adding the same file twice reuses the existing book record
- **Automatic restore:** Adding a file that matches an archived/deleted book restores it with preserved position and clips

**Book States:**
| State | `uri` | `hidden` | Visible in UI |
|-------|-------|----------|---------------|
| Active | path | false | Main library list |
| Archived | null | false | "Archived" section |
| Deleted | null | true | Nowhere |

**Archiving:** Users can archive books to free storage while keeping them visible:
- `book.uri === null && !book.hidden` means the book is archived
- Archiving deletes the underlying audio file but keeps the database record visible
- Clips continue to work (they have their own audio files)
- Archived books appear in a separate "Archived" section in LibraryScreen

**Deletion (soft-delete):** Users can remove books from their library entirely:
- `book.uri === null && book.hidden` means the book is deleted
- Deletion deletes the audio file AND hides the book from all UI
- Book record remains in database (for potential restore via fingerprint)
- Clips of deleted books still appear in clips list (they're independent)

**Archive action flow:**
1. Optimistic store update (set `uri: null`)
2. Database update (with rollback on failure)
3. Async file deletion (fire-and-forget)

**Delete action flow:**
1. Optimistic store update (remove from `books` map)
2. Database update: set `uri: null`, `hidden: true` (with rollback on failure)
3. Async file deletion (fire-and-forget)

**Restore flow (automatic on file add):**
1. File copied to app storage
2. Fingerprint read (file size + first 4KB)
3. If fingerprint matches archived/deleted book → restore: update `uri`, set `hidden: false`, replace metadata, preserve position
4. If fingerprint matches active book → delete duplicate file, touch `updated_at`
5. If no match → create new book record

```typescript
// Check book state
const isArchived = book.uri === null && !book.hidden
const isDeleted = book.uri === null && book.hidden

// Archive a book (keeps visible in Archived section)
await archiveBook(bookId)

// Delete a book (removes from library entirely)
await deleteBook(bookId)

// Restore happens automatically when same file is added again
```

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

**Context-based playback API:**
- `play(context?: { fileUri, position, ownerId })` - Loads file if different, claims ownership
- `seek(context: { fileUri, position })` - Only seeks if fileUri matches loaded file
- `pause()` - Pauses, preserves ownership

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

## Unit Testing (Jest)

Run with `npm test` (or `npm test:watch` for watch mode).

Tests are colocated in `__tests__/` directories next to the code they test. Action tests use shared helpers from `actions/__tests__/helpers.ts` for mock state, services, and immer-compatible `set`.

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

On-device automatic clip transcription using Whisper. See **[docs/TRANSCRIPTION.md](docs/TRANSCRIPTION.md)** for the full guide.

**Quick summary:** Clips are queued for transcription on creation → processed sequentially by a background queue → first 10s of audio extracted and fed to on-device Whisper → result saved to `clips.transcription` column. Controlled by `settings.transcription_enabled`.

**Key rules for working with transcription:**
- `note` and `transcription` are separate fields (user-written vs auto-generated)
- `queueClip()` is a no-op if the service isn't started — clips are picked up on re-enable
- If clip bounds change, clear `transcription` and re-queue

## Listening History (Sessions)

Automatic tracking of listening activity. Sessions record when and how long a user listened to each book.

**How it works:**
1. When playback starts on main player → session created (or existing session resumed if within 5 minutes)
2. Every 5 seconds while playing → `ended_at` timestamp updated (throttled)
3. When playback pauses/stops → session finalized with accurate `ended_at`
4. Sessions < 1 second are deleted (prevents accidental tap-play-pause clutter)

**5-Minute Window:** If playback resumes on the same book within 5 minutes of the last session ending, the existing session is extended rather than creating a new one. This prevents fragmented sessions from brief pauses.

**Main Player Only:** Sessions are only tracked when `playback.ownerId === MAIN_PLAYER_OWNER_ID`. Clip playback (ClipViewer, ClipEditor) doesn't create sessions.

**UI Access:** PlayerScreen header → clock icon → SessionsScreen ("History")

**SessionWithBook type:**
```typescript
interface SessionWithBook extends Session {
  book_name: string
  book_title: string | null
  book_artist: string | null
  book_artwork: string | null
}
```

**Key Points:**
- Sessions loaded on focus via `fetchSessions()` (like clips)
- Sessions are local-only (not synced to Drive)
- INNER JOIN with files table means deleted books' sessions still appear (book record exists with `hidden: true`)

## Google Drive Sync 🔥 IMPORTANT

Offline-first multi-device sync via Google Drive. See **[docs/SYNC.md](docs/SYNC.md)** for the full guide.

**Quick summary:** Store actions queue changes to SQLite → sync drains queue and does manifest-based incremental push/pull → conflicts resolved by pure merge functions → store notified of remote changes via events.

**Key rules for working with sync:**
- Queue changes via `syncQueue.queueChange()` when modifying synced entities
- Use manifest comparison for change detection (not just timestamp comparison)
- Don't delete manifest entries manually (sync service manages them)
- Don't modify books/clips without queueing for sync (changes will be lost on other devices)

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
- `playback` state is hardware-only (uri, duration, position, status, ownerId) — look up `Book` metadata from the `books` map
- Don't trigger React re-renders during TimelineBar animation (use refs)

## Quick Reference

**Start dev server:** `npm start`
**Run tests:** `npm test`
**Run e2e tests:** `maestro test maestro/`

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

