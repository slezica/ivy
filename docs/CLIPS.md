# The Clips System

A guide for Ivy's clip (bookmark) system.

## The Big Picture

A clip is a bookmark into an audiobook — a short audio segment with an optional note and an automatic transcription. Clips let the user mark interesting passages and come back to them later.

Each clip captures:
- **Where** in the source book it starts, and how long it is
- **Its own audio file** — a slice of the source, stored permanently
- **A note** — user-written, optional
- **A transcription** — auto-generated from the first 10 seconds (see [docs/TRANSCRIPTION.md](TRANSCRIPTION.md))

Clips live independently of their source book. Even if the user archives the book (freeing storage), clips remain playable from their own audio files.

---

## Core Concepts

### 1. Every clip has its own audio file

When a clip is created, the relevant segment is extracted from the source book and saved as a standalone audio file at `{DocumentDirectory}/clips/{clipId}.m4a`. All clips are output as `.m4a` regardless of source format — the native slicer remuxes all audio into an MPEG-4 container via MediaMuxer. This file is the clip's permanent audio — it doesn't depend on the source book existing.

The JS side passes a filename prefix (no extension) to the native slicer, which appends `.m4a` and returns the actual path. The JS code stores the native return value in the database, so the correct extension is always what gets persisted.

### 2. Clips reference their source, but don't require it

Each clip stores a `source_id` pointing to the book it came from. When the source book is available, clips can play from the full book audio (showing surrounding context on the timeline), be edited to expand or shrink their bounds, and offer "go to source" navigation.

When the source book is archived or deleted, clips fall back to their own audio file. Editing is disabled, but playback, notes, transcription, and sharing all continue to work.

### 3. Playback ownership

Both ClipViewer and ClipEditor are playback components — they control the audio player. Each generates a unique `ownerId` and claims ownership when it plays. This prevents conflicts with the main player or other clip viewers. See the playback ownership system in [PLAYBACK.md](PLAYBACK.md).

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                      ClipsListScreen                          │
│  Lists all clips · Search · View/Edit/Delete/Share            │
└───────┬──────────────────────────────────────────────────────┘
        │ opens
        ▼
┌──────────────────┐    ┌──────────────────┐
│   ClipViewer     │───▶│   ClipEditor     │
│   (read-only)    │    │   (edit bounds   │
│                  │    │    and note)      │
│ Plays from source│    │                  │
│ or own file      │    │ Requires source  │
└──────────────────┘    └──────────────────┘
        │                       │
        │ play/pause/seek       │ save updates
        ▼                       ▼
┌──────────────────────────────────────────────────────────────┐
│                       Store Actions                           │
│  addClip · updateClip · deleteClip · shareClip · seekClip     │
└───────┬──────────┬──────────┬──────────┬─────────────────────┘
        │          │          │          │
        ▼          ▼          ▼          ▼
   ┌────────┐ ┌────────┐ ┌────────┐ ┌────────────┐
   │Database│ │ Slicer │ │  Sync  │ │Transcription│
   │(SQLite)│ │(native)│ │ Queue  │ │   Queue     │
   └────────┘ └────────┘ └────────┘ └─────────────┘
```

The clips system doesn't have a dedicated service — it's built from store actions that coordinate the database, audio slicer, sync queue, and transcription queue. This is appropriate: clips don't need background processing or event streams of their own.

---

## Creating a Clip

The full creation pipeline is in `add_clip.ts`: validate, calculate duration, slice audio, save to database, queue sync and transcription, reload.

---

## Clip Independence

This is one of the most important design decisions in the clip system. A clip's relationship to its source book has two states:

### Source available (`clip.file_uri !== null`)

The source book's audio file is on disk. The clip can:
- **Play from source** — the timeline shows the full book, with the clip's range highlighted
- **Edit bounds** — the user can expand or shrink the clip, re-slicing from the source
- **Go to source** — navigate to the main player at the clip's start position

### Source unavailable (`clip.file_uri === null`)

The source book has been archived or deleted. The clip can still:
- **Play from its own file** — the timeline shows only the clip's duration
- **Display notes and transcription** — these are stored in the clip record
- **Be shared** — the clip's own audio file is sent via the share sheet

But it **cannot**:
- Edit bounds (no source to re-slice from)
- "Go to source" (no book to navigate to)

### The `ClipWithFile` type

The database returns clips enriched with source file metadata via a JOIN:

```typescript
interface ClipWithFile extends Clip {
  file_uri: string | null    // Source book's URI (null if archived)
  file_name: string          // Book filename (preserved even when archived)
  file_title: string | null  // Book title metadata
  file_artist: string | null // Book artist metadata
  file_duration: number      // Source book's full duration
}
```

This metadata is preserved in the `files` table even after archiving (soft-delete), so the clip always knows what book it came from, even if the audio is gone.

---

## Editing Clips

Editing requires the source book's audio file — if the source is archived, editing is disabled. The key non-obvious behavior: when bounds change, the source is re-sliced, the old audio file is replaced, and transcription is cleared and re-queued. Note-only edits skip re-slicing and transcription entirely. See `update_clip.ts` for the full flow.

---

## Edge Cases

### Database reload after creation

`addClip` calls `fetchClips()` after database insertion rather than manually constructing a `ClipWithFile`. This ensures the clip has correct source file metadata from the JOIN, avoiding stale or missing data.

---

## File Map

```
src/actions/
  add_clip.ts         → Creates clip: validates, slices, saves, queues
  update_clip.ts      → Updates note/bounds, re-slices if needed
  delete_clip.ts      → Deletes file, record, queues sync
  share_clip.ts       → Shares clip audio via native sheet
  fetch_clips.ts      → Loads all clips with source file metadata
  seek_clip.ts        → Navigates main player to clip's position in source
  constants.ts        → DEFAULT_CLIP_DURATION_MS (20s), CLIPS_DIR

src/services/
  audio/slicer.ts     → Native audio extraction (Kotlin module wrapper)
  system/sharing.ts   → Native share sheet wrapper
  storage/database.ts → Clip CRUD, ClipWithFile JOIN queries

src/components/
  ClipViewer.tsx      → Read-only clip modal (playback, transcription, note)
  ClipEditor.tsx      → Edit bounds and note (requires source file)

src/screens/
  ClipsListScreen.tsx → Full clip list with search, context menus

src/store/
  index.ts            → Wires clip actions, transcription events
  types.ts            → ClipWithFile in AppState, action types
```
