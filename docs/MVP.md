# Audio Player MVP

## Overview

Mobile audio player application built with React Native and Expo, supporting both iOS and Android platforms.

## Core Features

### 1. File Loading
- Load audio files from device storage using native document picker
- Support all Expo AV audio formats: MP3, M4A, MP4, WAV, AAC

### 2. Playback Controls
- Play/Pause
- Skip backward: 30 seconds
- Skip forward: 25 seconds
- Progress bar showing current position and total duration

### 3. Clips (Bookmarks)
- Create clips/bookmarks at any point during playback
- Add optional text notes to clips
- Browse all clips for current file
- Jump to clip positions
- Clips persisted per-file in SQLite database
- Resume playback from last position

## Architecture

### Three-Tier Design

**Services Layer** (`src/services/`)
- `AudioService.ts` - Wraps expo-av, manages Sound instance, playback state, position tracking
- `DatabaseService.ts` - Wraps expo-sqlite, handles all SQL operations
- `FileService.ts` - Wraps expo-document-picker & expo-file-system, manages file selection and metadata
- Services receive listeners on creation to report their activity back to the upper layer

**Store Layer** (`src/store/`)
- Zustand store with 3 fields initially:
    - `playback` for the player state, with `position` and `isPlaying`
    - `file` for the currently playing file metadata, backed by a file row (see db below)
    - `clips` map of current file's associated clips by ID, each item backed by a clip row (see db below)
- Actions that call services and update store
- Synchronous, optimistically updated state for UI performed on actions
- Listeners passed to services update the store state asynchronously with the final state

**UI Layer** (`src/screens/`, `src/components/`)
- **Screens:** `PlayerScreen`, `ClipsListScreen`
- **Components:** `PlaybackControls`, `ProgressBar`, `ClipItem`, `AddClipButton`
- Only reads from store, dispatches actions
- No business logic

**Dependencies:** UI → Store → Services → Native APIs

## Database Schema

### clips
User-created bookmarks and clips.

```sql
CREATE TABLE clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_uri TEXT NOT NULL,
  start INTEGER NOT NULL,      -- milliseconds
  duration INTEGER NOT NULL,   -- milliseconds (0 for point bookmarks)
  note TEXT,
  created_at INTEGER NOT NULL, -- unix timestamp
  updated_at INTEGER NOT NULL  -- unix timestamp
);

CREATE INDEX idx_clips_file_uri ON clips(file_uri);
```

### sessions
Playback history sessions (future feature).

```sql
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_uri TEXT NOT NULL,
  start INTEGER NOT NULL,      -- where session started (milliseconds)
  duration INTEGER NOT NULL,   -- how long they listened (milliseconds)
  created_at INTEGER NOT NULL, -- unix timestamp
  updated_at INTEGER NOT NULL  -- unix timestamp
);

CREATE INDEX idx_sessions_file_uri ON sessions(file_uri);
```

### files
File metadata with resume position.

```sql
CREATE TABLE files (
  uri TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  duration INTEGER,                 -- milliseconds, cached after first load
  position INTEGER NOT NULL DEFAULT 0, -- resume position (milliseconds)
  opened_at INTEGER                 -- unix timestamp
);
```

## Technology Stack

- **Framework:** React Native with Expo
- **State Management:** Zustand
- **Audio:** expo-av
- **Database:** expo-sqlite
- **File Picker:** expo-document-picker
- **File System:** expo-file-system

## Testing Strategy

Each layer independently testable:
- **Services:** Unit tests with mocked native modules
- **Store:** Unit tests with mocked services
- **UI:** Component tests with mocked store

## Future Considerations

The schema supports future features:
- Range clips (duration > 0)
- Playback history tracking via sessions table
- Migration to normalized schema if needed (not a hard change)
