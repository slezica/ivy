# AI Agent Reference - Ivy

**Quick onboarding guide for AI agents.** Read this first when starting a new session.

## Critical Architecture Decisions

### 1. **File Storage Strategy** 🔥 MOST IMPORTANT
External content: URIs (like Google Drive) become invalid after app restart. **Solution:**
- **All files are copied to app-owned storage** on first load
- Database stores: `uri` (local file:// path for playback) + `original_uri` (external source)
- `FileStorageService` manages copying to `Paths.document/audio/`
- Audio playback **only uses local file:// URIs**

### 2. **Time Units**
Everything internal is **milliseconds**. Convert to MM:SS only at display boundaries.

### 3. **State Management**
Single Zustand store (`src/store/index.ts`) is the source of truth. Services are stateless.

### 4. **Library Status Enum**
`'loading'` → `'idle'` ⇄ `'adding'`
- `loading`: Initial state, fetching files from database
- `idle`: Library ready
- `adding`: Copying a new file to app storage

### 5. **Audio Status Enum**
`'idle'` → `'loading'` → `'paused'` ⇄ `'playing'`
- `idle`: No track loaded (initial state)
- `loading`: Loading audio player
- `paused`/`playing`: Playback states

Event callback preserves transitional state (`loading`) - only updates to `paused`/`playing` when not in transition.

### 6. **Playback Ownership** 🔥 IMPORTANT
Multiple UI components can control playback (PlayerScreen, ClipViewer, ClipEditor). To prevent conflicts:
- `audio.ownerId` tracks which component last took control
- Components pass `ownerId` when calling `play()` to claim ownership
- Ownership persists until another component calls `play()` with different `ownerId`
- Components check `audio.ownerId === myId` to know if they're in control

**Main Player ID:** `MAIN_PLAYER_OWNER_ID = 'main'` (exported from `utils/index.ts`)
- Well-known ID for the main player tab
- `loadFile()` uses this ID so PlayerScreen adopts newly loaded books
- Any component can target the main player by using this ID

```typescript
// Main player checks for its well-known ID
const isOwner = audio.ownerId === MAIN_PLAYER_OWNER_ID

// Other components generate stable IDs
const ownerId = useRef('clip-editor-123').current
const isOwner = audio.ownerId === ownerId

// Check ownership
const isPlaying = isOwner && audio.status === 'playing'

// Claim ownership when playing
await play({ fileUri, position, ownerId })
```

**Local state pattern:** Each player maintains its own local state:
- `ownPosition`: the position this player remembers (all players)
- `ownBook`: the book this player is showing (PlayerScreen only - clips know their source)
- When owner: sync `ownPosition` from `audio.position` via effect
- When not owner: keep local position (allows seeking without affecting playback)
- On play: claim ownership with `ownPosition`
- On seek: always update `ownPosition`, only call `seek()` if owner

### 7. **Books and Archiving** 🔥 IMPORTANT
The domain entity is called `Book` (not AudioFile). A Book represents an audiobook/podcast in the library.

**File Identity Hash:** Each book has a `hash` field (unique index) computed from file size + first 4KB. This enables:
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
2. Hash computed from local file
3. If hash matches archived book → restore: update `uri`, replace metadata, preserve position
4. If hash matches active book → delete duplicate file, touch `opened_at`
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
- Zustand for state
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
  ├── store/index.ts              # Zustand store - all state
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
  │   └── system/
  │       └── sharing.ts          # Share clips via native share sheet
  ├── screens/
  │   ├── LibraryScreen.tsx       # Book list (active + archived sections) with archive action
  │   ├── PlayerScreen.tsx        # Main player
  │   └── ClipsListScreen.tsx     # Clip management
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
id INTEGER PRIMARY KEY         -- Auto-increment, stable identifier
uri TEXT                       -- Local file:// path (NULL if archived)
original_uri TEXT              -- External content:// URI (reference only)
name TEXT
duration INTEGER               -- milliseconds
position INTEGER               -- milliseconds (resume position)
opened_at INTEGER              -- timestamp
title TEXT
artist TEXT
artwork TEXT                   -- base64 data URI
hash TEXT UNIQUE               -- File identity hash (size + first 4KB, FNV-1a)
```

**clips table:**
```sql
id INTEGER PRIMARY KEY
source_id INTEGER              -- References files.id (parent book)
uri TEXT                       -- Clip's own audio file
start INTEGER                  -- milliseconds (position in source file)
duration INTEGER               -- milliseconds
note TEXT
transcription TEXT             -- Auto-generated from audio (Whisper)
created_at INTEGER
updated_at INTEGER
```

## Store State Structure

```typescript
library: {
  status: 'loading' | 'idle' | 'adding'
}
audio: {
  status: 'idle' | 'loading' | 'paused' | 'playing'
  position: number              // milliseconds
  uri: string | null            // URI currently loaded in player (hardware state)
  duration: number              // Duration of loaded audio (hardware state)
  ownerId: string | null        // ID of component controlling playback
}
clips: Record<number, ClipWithFile>  // Keyed by clip id
books: Record<number, Book>          // Keyed by book id

// Key actions
loadFile, loadFileWithUri, play, pause, seek, skipForward/Backward
fetchBooks, archiveBook
addClip(bookId, position), deleteClip, jumpToClip, shareClip
updateClip(id, { note?, start?, duration? })  // Edit clip bounds and note (requires source file)
updateClipTranscription         // Called by TranscriptionService
__DEV_resetApp                  // Dev tool (clears all data)

// Context-based playback API
play(context?: { fileUri, position, ownerId? })  // Loads file if different, claims ownership
seek(context: { fileUri, position })             // Only seeks if fileUri matches loaded file
pause()                                          // Pauses, preserves ownership
```

**AudioState is hardware-only:** The `audio` object reflects what's loaded in the player, not domain state. Components look up `Book` metadata from the `books` map using the URI when needed.

## File Loading Flow (Critical)

1. **User picks file** → `pickedFile.uri` (external content: URI)
2. **Check if already copied:**
   - Lookup `dbService.getBookByUri(pickedFile.uri)` - checks by local URI
   - If found and file exists on disk → use existing local copy
3. **Copy to app storage:**
   - `library.status = 'adding'` → Modal shows "Adding to library..."
   - `fileStorageService.copyToAppStorage()` → returns local `file://` URI
4. **Load audio:**
   - `status = 'loading'` → Modal shows "Loading audio file..."
   - `audioService.load(localUri)` → 10s timeout if fails
5. **Save to database:**
   - `dbService.upsertBook()` returns the `Book` with generated `id`
   - `uri = localUri` (local file:// path)
   - `original_uri = pickedFile.uri` (external content: URI)
6. **Auto-play:**
   - `status = 'playing'`
   - Navigate to player tab

**On reload from library:**
- Book selected by `id` from store (indexed by id)
- If `book.uri` exists on disk → load directly
- If `book.uri` is null → book is archived, show alert

## Development Tools

Library screen header has dev-only buttons (top-right):

### Sample Button
- Loads bundled test audio file (`assets/test/test-audio.mp3`)
- Useful for quick testing without file picker
- Navigates to Player tab after loading

### Reset Button
- Clears database (files, clips, sessions)
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
- Database `original_uri` is for reference only, don't use for playback

## Timeline Component

Unified GPU-accelerated Skia Canvas component in `src/components/timeline/`.

### Architecture
- **Props-based**: Not store-connected; caller provides `duration`, `position`, `onSeek`, colors
- **Stencil + paint layers**: Builds ONE path with all visible bars, draws it 2-3 times with clip regions
- **Ref-based physics**: 60fps animation without React re-render overhead
- **Visible culling**: Only renders bars currently on screen
- Gestures: drag to scrub, flick with momentum, tap to seek

### Rendering Approach

Instead of per-bar color logic, uses painter's algorithm with clip regions:
1. Build single Path containing all visible bar shapes (the "stencil")
2. Draw path with `leftColor`, clipped to left of playhead
3. Draw path with `rightColor`, clipped to right of playhead
4. Draw path with `selectionColor`, clipped to selection range (overwrites 1 & 2)

This gives O(bars) path ops + 3 draw calls, vs O(bars × segments) with per-bar rendering.

### Props

```typescript
interface TimelineProps {
  // Core (required)
  duration: number
  position: number
  onSeek: (position: number) => void

  // Bar colors (required)
  leftColor: string              // Bars/portions left of playhead
  rightColor: string             // Bars/portions right of playhead

  // Selection (optional - all four enable selection handles)
  selectionColor?: string
  selectionStart?: number
  selectionEnd?: number
  onSelectionChange?: (start: number, end: number) => void

  // Display
  showTime?: 'top' | 'bottom' | 'hidden'
}
```

### Usage Examples

```typescript
// Playback mode (PlayerScreen, ClipViewer)
<Timeline
  duration={ownFile.duration}  // or clip.file_duration
  position={ownPosition}
  onSeek={handleSeek}
  leftColor={Color.GRAY}       // played
  rightColor={Color.PRIMARY}   // unplayed
/>

// Selection mode (ClipEditor)
<Timeline
  duration={clip.file_duration}
  position={ownPosition}
  onSeek={handleSeek}
  leftColor={Color.PRIMARY}    // same = no playhead split
  rightColor={Color.PRIMARY}
  selectionColor={Color.SELECTION}
  selectionStart={selectionStart}
  selectionEnd={selectionEnd}
  onSelectionChange={handleSelectionChange}
/>
```

### Selection Handles
- Appear only when all four selection props provided
- Draggable circles at bottom of timeline
- Minimum 1 second gap enforced
- Handles cannot cross each other

## Shared Components

`src/components/shared/` contains reusable UI components:

- **ScreenArea** - Wraps screens with safe area insets (uses `react-native-safe-area-context`, NOT deprecated RN `SafeAreaView`)
- **Header** - Standard screen header with `title`, `subtitle`, optional `children`, and `noBorder` prop
- **EmptyState** - Centered empty state display with `title` and `subtitle`
- **ActionMenu** - Bottom sheet action menu (3-dot overflow pattern) with `ActionMenuItem[]`

## Utilities

`src/utils/index.ts` exports:
- `MAIN_PLAYER_OWNER_ID` - Well-known owner ID for the main player tab (`'main'`)
- `formatTime(ms)` - Converts milliseconds to `MM:SS` or `H:MM:SS` format
- `formatDate(timestamp)` - Formats timestamp as `MMM D, YYYY`

## Native Modules

Located in `android/app/src/main/java/com/salezica/ivy/`:

**AudioSlicer**:
- Kotlin native module for extracting audio segments
- Wrapped by `services/audio/slicer.ts` (used for sharing and transcription)
- Interface: `sliceAudio(inputPath, startMs, endMs, outputPath) → Promise<string>`

**AudioMetadata**:
- Kotlin native module for extracting ID3 metadata (title, artist, artwork)
- Wrapped by `services/audio/metadata.ts`
- Interface: `extractMetadata(filePath) → Promise<{ title, artist, artwork }>`

## Clip File Storage

Clips have their own persistent audio files, stored separately from source files:

**Storage Location:** `DocumentDirectoryPath/clips/{randomId}.mp3`

**Lifecycle:**
- **Create**: Audio sliced from source file, saved to clips directory
- **Update**: If bounds change, new slice created, old file deleted (requires source file)
- **Delete**: Clip audio file deleted
- **Share**: Uses existing clip file directly (no temp file needed)

**File Naming:** Random string via `(Math.random() + 1).toString(36).substring(2)`

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

## Adding Features

### New Playback Control
1. Add action to `src/store/index.ts`
2. Call `AudioPlayerService` method (from `services/audio/player.ts`)
3. Update `audio.status` if needed
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
- Set `library.status = 'adding'` when copying files, `audio.status = 'loading'` when loading player
- Use local file:// URIs for all audio playback
- Keep services stateless (state lives in store)
- Pass `{ fileUri, position, ownerId }` when calling `play()` from UI components
- Maintain local position state in playback components
- Check `audio.ownerId === myId` before syncing from global audio state
- Check `clip.file_uri !== null` before enabling edit/jump-to-source features
- Use `clip.file_uri` (source) when available, fall back to `clip.uri` (clip's own file) when not
- Use `book.id` as the stable identifier for books (not `uri` which can be null)
- Look up `Book` metadata from `books` map using URI when needed (audio state only has uri/duration)

❌ **Don't:**
- Use external content: URIs for audio playback
- Trigger React re-renders during TimelineBar animation (use refs)
- Modify `status` from polling callback when in transitional state
- Call `upsertBook` without both URIs (local and original)
- Call `play()` or `seek()` without file context from UI components
- Assume global `audio.position` is relevant to your component (check ownership first)
- Assume `Book.uri` is non-null (check before using for playback - null means archived)
- Attempt to re-slice clips when source book is archived (`file_uri === null`)
- Read book metadata from `audio` state (it only has hardware state: uri, duration)

## Quick Reference

**Start dev server:** `npm start`
**Run e2e tests:** `maestro test maestro/`
**Load test file:** Tap "Sample" button in Library
**Reset app data:** Tap "Reset" button in Library
**Time format:** Always milliseconds internally
**Book playback:** Use `book.uri` (local path) - check for null first (null = archived)
**Book identifier:** Use `book.id` (stable), not `uri` (can be null)
**Clip source check:** `clip.file_uri !== null` means source book available
**Archive check:** `book.uri === null` means book is archived
**Library status:** `loading → idle ⇄ adding`
**Audio status:** `idle → loading → paused ⇄ playing`
**Audio state:** Hardware-only (uri, duration, position, status, ownerId) - no Book metadata

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

## Recent Architecture

- Services reorganized into domain modules (`audio/`, `storage/`, `transcription/`, `system/`)
- Dependency injection for services with cross-module dependencies
- File storage with app-owned copies (v2 - current)
- Player status enum extended with `'adding'` state
- LoadingModal with dual messages
- Dev reset button in Library
- New FileSystem API (Paths, Directory, File)
- Shared components extracted (ScreenArea, Header, EmptyState, ActionMenu, IconButton, Modal)
- Automatic clip transcription via on-device Whisper
- Native AudioSlicer module for audio segment extraction
- Clip sharing via native share sheet
- **Context-based playback API**: `play()` and `seek()` require file/position context
- **Playback ownership**: `audio.ownerId` tracks which component controls playback
- Components maintain local position state, sync from global only when they own playback
- **react-native-track-player v5**: Replaced expo-audio for system media controls
- **Persistent clip files**: Clips have own audio files (`uri`), sliced on create/update
- **ClipViewer/ClipEditor**: Extracted components for viewing and editing clips
- **Unified Timeline component**: Replaced PlaybackTimeline + SelectionTimeline with single props-based Timeline
- **Stencil + paint layers rendering**: Timeline uses clip regions instead of per-bar segment logic
- **Book ID as primary key**: `files.id` (auto-increment) is now the stable identifier, `uri` is nullable
- **Clip source independence**: Clips reference `source_id` (book ID), work even if source book archived
- **ClipWithFile.file_uri**: Nullable field to check source availability; when null, clips play from own file
- **Store books indexed by id**: `books: Record<number, Book>` instead of by uri
- **Renamed AudioFile to Book**: Domain entity representing audiobooks/podcasts
- **AudioState is hardware-only**: `audio` has `uri` + `duration` (not full Book object)
- **Book archiving**: `archiveBook(id)` sets `uri = null`, deletes file, preserves clips
- **Library sections**: Active books and archived books shown in separate SectionList sections
- **Database methods**: `getBookByUri()`, `getBookById()`, `getBookByHash()`, `upsertBook()`, `archiveBook()`, `restoreBook()`, `touchBook()`, `createClip(bookId, ...)`
- **addClip takes explicit params**: `addClip(bookId, position)` instead of reading from audio state
- **File identity hash**: `files.hash` (unique index) enables duplicate detection and automatic restore of archived books
