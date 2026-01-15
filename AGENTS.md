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

### 4. **Player Status Enum**
`'adding'` → `'loading'` → `'paused'` ⇄ `'playing'`
- `adding`: Copying file to app storage
- `loading`: Loading audio player
- `paused`/`playing`: Playback states

Polling callback preserves transitional states (`adding`/`loading`) - only updates to `paused`/`playing` when not in transition.

## Project Overview

**React Native Expo app** for podcast/audiobook playback with:
- Library management (file history with resume positions + metadata)
- Clips/bookmarks with notes and automatic transcription
- GPU-accelerated timeline UI (Skia Canvas)
- Auto-play, resume from last position
- On-device speech-to-text via Whisper (privacy-first)
- Metadata extraction (title, artist, artwork) via native Android module
- Clip sharing via native share sheet

**Tech Stack:**
- React Native 0.81.5 + Expo 54
- Zustand for state
- Expo Router (file-based tabs)
- expo-audio (100ms polling)
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
  │   │   ├── player.ts           # expo-audio wrapper (10s timeout)
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
  │   ├── LibraryScreen.tsx       # History + 🔧 Reset button
  │   ├── PlayerScreen.tsx        # Main player
  │   └── ClipsListScreen.tsx     # Clip management
  ├── components/
  │   ├── timeline/               # GPU-accelerated timeline components
  │   │   ├── constants.ts        # Dimensions, physics, animation timing
  │   │   ├── utils.ts            # timeToX, xToTime, segment heights
  │   │   ├── useScrollPhysics.ts # Scroll/momentum hook (shared)
  │   │   ├── PlaybackTimeline.tsx # Center-fixed playhead, played/unplayed bars
  │   │   ├── SelectionTimeline.tsx # Timeline with draggable selection handles
  │   │   └── index.ts            # Barrel exports
  │   ├── LoadingModal.tsx        # "Adding..." / "Loading..." modal
  │   └── shared/
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
  └── (tabs)/
      ├── _layout.tsx             # Tab nav (disables tabs when no file)
      ├── index.tsx               # Library
      ├── player.tsx              # Player
      └── clips.tsx               # Clips

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

**files table:**
```sql
uri TEXT PRIMARY KEY           -- Local file:// path (used for playback)
original_uri TEXT              -- External content:// URI (reference only)
name TEXT
duration INTEGER               -- milliseconds
position INTEGER               -- milliseconds (resume position)
opened_at INTEGER              -- timestamp
```

**clips table:**
```sql
id INTEGER PRIMARY KEY
file_uri TEXT                  -- References files.uri (local path)
start INTEGER                  -- milliseconds
duration INTEGER               -- milliseconds
note TEXT
transcription TEXT             -- Auto-generated from audio (Whisper)
created_at INTEGER
updated_at INTEGER
```

## Store State Structure

```typescript
player: {
  status: 'adding' | 'loading' | 'paused' | 'playing'
  position: number              // milliseconds
  duration: number              // milliseconds
  file: AudioFile | null        // Includes uri + original_uri
}
clips: Record<number, Clip>
files: Record<string, AudioFile>  // Keyed by local URI

// Key actions
loadFile, loadFileWithUri, play, pause, seek, skipForward/Backward
addClip, deleteClip, jumpToClip, shareClip
updateClip(id, { note?, start?, duration? })  // Edit clip bounds and note
updateClipTranscription         // Called by TranscriptionService
__DEV_resetApp                  // Dev tool (clears all data)
```

## File Loading Flow (Critical)

1. **User picks file** → `pickedFile.uri` (external content: URI)
2. **Check if already copied:**
   - Lookup `dbService.getFile(pickedFile.uri)` - won't find it (searching by external URI)
   - Need to track by local URI instead, so we always copy on first load
3. **Copy to app storage:**
   - `status = 'adding'` → Modal shows "Adding to library..."
   - `fileStorageService.copyToAppStorage()` → returns local `file://` URI
4. **Load audio:**
   - `status = 'loading'` → Modal shows "Loading audio file..."
   - `audioService.load(localUri)` → 10s timeout if fails
5. **Save to database:**
   - `uri = localUri` (local file:// path)
   - `original_uri = pickedFile.uri` (external content: URI)
6. **Auto-play:**
   - `status = 'playing'`
   - Navigate to player tab

**On reload from library:**
- Lookup file by `uri` (local path)
- If local file exists → load directly (no copying)
- If local file missing → re-copy from original_uri (if still valid)

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

## Timeline Components

GPU-accelerated Skia Canvas components in `src/components/timeline/`:

### Shared Architecture
- Renders only visible segments (not all 14,400+ bars for long files)
- Ref-based physics (not useState) for 60fps animation
- Picture API: records drawing commands once, replays efficiently
- Gestures: drag to scrub, flick with momentum, tap to seek
- `showTime` prop: `'top'` | `'bottom'` | `'hidden'`

### PlaybackTimeline
Used in PlayerScreen for audio scrubbing:
- Center-fixed playhead, content scrolls behind it
- Bars colored gray (played) or primary (unplayed)
- Split-colored bars when playhead crosses segment boundary
- Auto-syncs scroll position to playback position when idle

### SelectionTimeline
Used in clip edit modal for adjusting clip bounds:
- Movable playhead (follows playback position, can scroll out of view)
- Two selection handles with draggable yellow circles at bottom
- Bars colored primary (default) or yellow (within selection)
- Handles enforce 1 second minimum gap, cannot cross each other
- No auto-sync to playback position (user scrolls freely)

```typescript
// SelectionTimeline props
interface SelectionTimelineProps {
  duration: number                    // Total file duration
  position: number                    // Current playback position
  selectionStart: number              // Selection start time (ms)
  selectionEnd: number                // Selection end time (ms)
  onSelectionChange: (start, end) => void
  onSeek?: (position) => void
  showTime?: 'top' | 'bottom' | 'hidden'
}
```

## Shared Components

`src/components/shared/` contains reusable UI components:

- **ScreenArea** - Wraps screens with safe area insets (uses `react-native-safe-area-context`, NOT deprecated RN `SafeAreaView`)
- **Header** - Standard screen header with `title`, `subtitle`, optional `children`, and `noBorder` prop
- **EmptyState** - Centered empty state display with `title` and `subtitle`
- **ActionMenu** - Bottom sheet action menu (3-dot overflow pattern) with `ActionMenuItem[]`

## Utilities

`src/utils/index.ts` exports:
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

## Transcription Architecture

On-device automatic clip transcription using Whisper:

**Flow:**
1. Clip created → `transcriptionService.queueClip(clipId)`
2. `audioSlicerService` extracts first 5s of clip audio to temp file
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
- Transcription displayed in ClipsListScreen below the time
- `note` and `transcription` are separate fields (user notes vs auto-generated)

## Adding Features

### New Playback Control
1. Add action to `src/store/index.ts`
2. Call `AudioPlayerService` method (from `services/audio/player.ts`)
3. Update `player.status` if needed
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
- Use services for all I/O (never call expo-audio, SQLite, FileSystem directly from components)
- Import services from `services/` barrel export (e.g., `import { databaseService } from '../services'`)
- Use dependency injection for services that depend on other services
- Store all times in milliseconds internally
- Set `status = 'adding'` when copying files, `'loading'` when loading player
- Use local file:// URIs for all audio playback
- Keep services stateless (state lives in store)

❌ **Don't:**
- Use external content: URIs for audio playback
- Trigger React re-renders during TimelineBar animation (use refs)
- Modify `status` from polling callback when in transitional state
- Call `upsertFile` without both URIs (local and original)

## Quick Reference

**Start dev server:** `npm start`
**Run e2e tests:** `maestro test maestro/`
**Load test file:** Tap "Sample" button in Library
**Reset app data:** Tap "Reset" button in Library
**Time format:** Always milliseconds internally
**File playback:** Always use `audioFile.uri` (local path)
**Status transitions:** `adding → loading → paused ⇄ playing`

## Recent Architecture

- Services reorganized into domain modules (`audio/`, `storage/`, `transcription/`, `system/`)
- Dependency injection for services with cross-module dependencies
- File storage with app-owned copies (v2 - current)
- Player status enum extended with `'adding'` state
- LoadingModal with dual messages
- Dev reset button in Library
- New FileSystem API (Paths, Directory, File)
- Database schema: `uri` (local) + `original_uri` (external)
- Shared components extracted (ScreenArea, Header, EmptyState, ActionMenu, IconButton)
- Automatic clip transcription via on-device Whisper
- Native AudioSlicer module for audio segment extraction
- Clip sharing via native share sheet
- Timeline components refactored into `timeline/` module with shared code
- SelectionTimeline for clip length editing with draggable handles
- Clip edit modal with playback preview
