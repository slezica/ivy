# AI Agent Reference - Audio Player React Native

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
- Library management (file history with resume positions)
- Clips/bookmarks with notes
- GPU-accelerated timeline UI (Skia Canvas)
- Auto-play, resume from last position

**Tech Stack:**
- React Native 0.81.5 + Expo 54
- Zustand for state
- Expo Router (file-based tabs)
- expo-audio (100ms polling)
- SQLite (expo-sqlite)
- Skia for timeline rendering
- New FileSystem API: `Paths.document`, `Directory`, `File` classes

## File Structure

```
/src
  ├── store/index.ts              # Zustand store - all state
  ├── services/
  │   ├── AudioService.ts         # expo-audio wrapper (10s timeout)
  │   ├── DatabaseService.ts      # SQLite operations
  │   ├── FileService.ts          # Document picker
  │   └── FileStorageService.ts   # File copying (NEW API)
  ├── screens/
  │   ├── LibraryScreen.tsx       # History + 🔧 Reset button
  │   ├── PlayerScreen.tsx        # Main player
  │   └── ClipsListScreen.tsx     # Clip management
  ├── components/
  │   ├── TimelineBar.tsx         # GPU timeline (most complex)
  │   └── LoadingModal.tsx        # "Adding..." / "Loading..." modal
  └── theme.ts

/app
  ├── _layout.tsx                 # Root (includes LoadingModal)
  └── (tabs)/
      ├── _layout.tsx             # Tab nav (disables tabs when no file)
      ├── index.tsx               # Library
      ├── player.tsx              # Player
      └── clips.tsx               # Clips
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
loadFile, play, pause, seek, skipForward/Backward
addClip, updateClip, deleteClip, jumpToClip
__DEV_resetApp                  // Dev tool (clears all data)
```

## File Loading Flow (Critical)

1. **User picks file** → `pickedFile.uri` (external content: URI)
2. **Check if already copied:**
   - Lookup `dbService.getFile(pickedFile.uri)` - won't find it (searching by external URI)
   - Need to track by local URI instead, so we always copy on first load
3. **Copy to app storage:**
   - `status = 'adding'` → Modal shows "Adding to library..."
   - `FileStorageService.copyToAppStorage()` → returns local `file://` URI
4. **Load audio:**
   - `status = 'loading'` → Modal shows "Loading audio file..."
   - `AudioService.load(localUri)` → 10s timeout if fails
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

### Reset App Data
Library screen has **🔧 Reset** button (top-right):
- Clears database (files, clips, sessions)
- Unloads audio player
- Resets store state
- **Note:** Doesn't delete copied files from storage (orphaned)

Access via: `store.__DEV_resetApp()`

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

## TimelineBar Details

**Most complex component** - GPU-accelerated Skia Canvas:
- Renders only visible segments (not all 14,400+ bars for long files)
- Center-fixed playhead, content scrolls
- Ref-based physics (not useState) for 60fps
- Picture API: records drawing commands once, replays efficiently
- Gestures: drag to scrub, flick with momentum, tap to seek
- Split-colored bars when playhead crosses segment boundary

## Adding Features

### New Playback Control
1. Add action to `src/store/index.ts`
2. Call `AudioService` method
3. Update `player.status` if needed
4. Add UI in `PlayerScreen.tsx`

### New Database Field
1. Update interface in `DatabaseService.ts`
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
**Reset app data:** Tap 🔧 button in Library tab
**Time format:** Always milliseconds internally
**File playback:** Always use `audioFile.uri` (local path)
**Status transitions:** `adding → loading → paused ⇄ playing`

## Recent Architecture

- File storage with app-owned copies (v2 - current)
- Player status enum extended with `'adding'` state
- LoadingModal with dual messages
- Dev reset button in Library
- New FileSystem API (Paths, Directory, File)
- Database schema: `uri` (local) + `original_uri` (external)
