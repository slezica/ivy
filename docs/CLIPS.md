# The Clips System

A teaching guide for Ivy's clip (bookmark) system. Start here — no code reading required.

## Table of Contents

1. [The Big Picture](#the-big-picture)
2. [Core Concepts](#core-concepts)
3. [Architecture Overview](#architecture-overview)
4. [Creating a Clip](#creating-a-clip)
5. [Clip Independence](#clip-independence)
6. [Viewing and Playing Clips](#viewing-and-playing-clips)
7. [Editing Clips](#editing-clips)
8. [Deleting and Sharing](#deleting-and-sharing)
9. [The Clips List](#the-clips-list)
10. [Integration Points](#integration-points)
11. [Edge Cases and Robustness](#edge-cases-and-robustness)
12. [File Map](#file-map)

---

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

When a clip is created, the relevant segment is extracted from the source book and saved as a standalone audio file at `{DocumentDirectory}/clips/{clipId}.{ext}`. The format matches the source (`.mp3` for MP3 books, `.m4a` for AAC/M4A books). This file is the clip's permanent audio — it doesn't depend on the source book existing.

### 2. Clips reference their source, but don't require it

Each clip stores a `source_id` pointing to the book it came from. When the source book is available, clips can play from the full book audio (showing surrounding context on the timeline), be edited to expand or shrink their bounds, and offer "go to source" navigation.

When the source book is archived or deleted, clips fall back to their own audio file. Editing is disabled, but playback, notes, transcription, and sharing all continue to work.

### 3. Playback ownership

Both ClipViewer and ClipEditor are playback components — they control the audio player. Each generates a unique `ownerId` and claims ownership when it plays. This prevents conflicts with the main player or other clip viewers. See the playback ownership system in [AGENTS.md](../AGENTS.md).

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

When the user taps "Add Clip" in the player, `addClip(bookId, position)` runs:

### Step 1: Validate

The book must exist in the store and have a URI (can't clip from an archived book).

### Step 2: Calculate duration

The default clip duration is **20 seconds** (`DEFAULT_CLIP_DURATION_MS`). If less than 20 seconds remain in the book, the clip is shortened to fit:

```
clipDuration = min(20_000, book.duration - position)
```

### Step 3: Slice audio

The native `AudioSlicerService` extracts the segment from the book's audio file:

```
source: book.uri
range:  [position .. position + clipDuration]
output: {DocumentDirectory}/clips/{clipId}.{ext}
```

The slicer is a Kotlin native module. It preserves the source format — no re-encoding:

- **MP3 sources** → raw byte copy → `.mp3` output
- **AAC/M4A sources** → MediaMuxer remux → `.m4a` output

The JS side requests `.mp3` as the filename, but the native module silently corrects the extension to `.m4a` for non-MP3 sources. The JS code uses the native return value (the actual path), so the correct extension is what gets stored in the database. This means **clip files are not always MP3** — they match their source format.

### Step 4: Save to database

A new clip record is created:

```
id:         generated UUID
source_id:  bookId
uri:        file path to the extracted MP3
start:      position (milliseconds into the source)
duration:   clipDuration (milliseconds)
note:       "" (empty, user can edit later)
```

### Step 5: Queue for sync and transcription

- `syncQueue.queueChange('clip', clipId, 'upsert')` — ensures the clip reaches other devices
- `transcription.queueClip(clipId)` — queues automatic transcription of the first 10 seconds

### Step 6: Reload

`fetchClips()` reloads all clips from the database. This is necessary because the database JOIN enriches clips with source file metadata (`ClipWithFile`), and the freshly created clip needs this enrichment.

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
- **Be shared** — the clip's own MP3 is sent via the share sheet

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

### Code pattern

Every component that works with clips checks source availability:

```
hasSourceFile = clip.file_uri !== null
playbackUri   = hasSourceFile ? clip.file_uri : clip.uri
duration      = hasSourceFile ? clip.file_duration : clip.duration
startPosition = hasSourceFile ? clip.start : 0
```

---

## Viewing and Playing Clips

ClipViewer is a read-only modal for examining and playing a clip.

### Playback source selection

ClipViewer picks between two playback modes based on source availability:

**With source:** Plays the full book audio. The timeline shows the entire book duration with the clip range highlighted. Playback starts at `clip.start`. The user can seek anywhere in the book.

**Without source:** Plays the clip's own MP3. The timeline shows only the clip duration. Playback starts at position 0.

### Ownership

ClipViewer generates a stable `ownerId` per clip instance: `clip-viewer-{clipId}`. It checks ownership before syncing from global playback state:

```
isOwner  = playback.ownerId === ownerId
isPlaying = isOwner && playback.status === 'playing'
```

When the user presses play, ClipViewer calls `play()` with its `ownerId`, claiming control of the audio player. When not the owner (e.g., the main player took over), it keeps its local position state so nothing jumps unexpectedly.

### Display

The viewer shows:
- **Header** — source file title and clip time range
- **Timeline** — with clip bounds highlighted as a selection
- **Play/pause button**
- **Transcription** — if available, displayed in italic quotes
- **Note** — if the user wrote one
- **Edit button** — opens ClipEditor (hidden if source is archived)

---

## Editing Clips

ClipEditor is a modal for changing a clip's bounds and note. It requires the source book's audio file — if the source is archived, the edit button is hidden entirely.

### What can be edited

- **Bounds** — the start position and duration, via draggable selection handles on the timeline
- **Note** — free-text, multiline

### What happens on save

`updateClip(clipId, { start, duration, note })` runs:

1. **Detect bounds change** — compares new start/duration against current values
2. **If bounds changed:**
   - Validate source file exists (throw if archived)
   - Re-slice the source audio with new bounds
   - Replace the clip's MP3 file with the new slice
   - Clean up the old file
   - Clear the transcription (now stale) and re-queue for transcription
3. **Update database** — write new values plus `updated_at = now`
4. **Queue for sync** — so other devices get the update
5. **Update store** — in-memory state reflects changes immediately

Note-only edits skip the re-slice and transcription steps entirely.

### Timeline interaction

The editor's timeline shows the full source book duration. Two draggable handles mark the clip's start and end. The user can:
- Drag handles to resize the clip
- Tap the timeline to seek playback
- Press play to hear the current selection

---

## Deleting and Sharing

### Delete

`deleteClip(clipId)`:

1. Delete the clip's MP3 file from disk
2. Delete the database record
3. Queue a `'delete'` operation for sync
4. Remove from the store

Deletion is confirmed via a native alert dialog before executing.

### Share

`shareClip(clipId)`:

1. Look up the clip in the store
2. Call `SharingService.shareClipFile(clip.uri, title)` where title falls back from `clip.note` to `clip.file_name`
3. The sharing service verifies the file exists, detects MIME type (MP3 or M4A), and opens the native share sheet

Sharing uses the clip's own audio file directly — no temporary file is needed.

---

## The Clips List

`ClipsListScreen` shows all clips across all books, sorted newest first.

### Search

A search bar filters clips by matching against:
- Source file title
- Source file name
- Transcription text
- Note text

Matching is case-insensitive substring search, applied client-side over the in-memory clips.

### Data loading

Clips are fetched on every screen focus via `useFocusEffect` → `fetchClips()`. This ensures the list is fresh when navigating from the player (where a new clip might have just been created).

### Context menu

Each clip has a three-dot menu with actions that adapt to source availability:

| Action | When available | What it does |
|--------|---------------|--------------|
| Edit | Source file exists | Opens ClipEditor |
| Go to source | Source file exists | Loads source in main player at clip start |
| Share | Always | Opens native share sheet |
| Delete | Always | Confirmation dialog → hard delete |

### Transcription indicator

If a clip is currently being transcribed (`transcription.pending[clipId]`), the list item shows "Transcribing..." instead of the transcription text.

---

## Integration Points

### Sync

Every clip mutation queues a sync operation:
- `addClip` → `queueChange('clip', clipId, 'upsert')`
- `updateClip` → `queueChange('clip', clipId, 'upsert')`
- `deleteClip` → `queueChange('clip', clipId, 'delete')`

When remote changes arrive (via sync `data` event), `fetchClips()` reloads everything. See [docs/SYNC.md](SYNC.md).

### Transcription

Clips are automatically queued for transcription on creation and when bounds change. The transcription system processes the first 10 seconds of the clip's own audio file. See [docs/TRANSCRIPTION.md](TRANSCRIPTION.md).

### Playback

ClipViewer and ClipEditor both participate in the playback ownership system. They generate unique owner IDs and claim the audio player when the user presses play. The main player and any clip component can coexist — only the one that last called `play()` is the owner.

---

## Edge Cases and Robustness

### Clip from near the end of a book

If the user creates a clip at position 59:50 in a 60:00 book, the clip duration is capped to 10 seconds (remaining time) instead of the default 20.

### Source archived after clip creation

The clip continues to work — it has its own MP3. The UI adapts by hiding edit and "go to source" options. Metadata (title, artist, filename) is preserved in the database from the JOIN with the `files` table, which retains soft-deleted book records.

### Bounds edit with archived source

`updateClip` throws `"Cannot edit clip bounds: source file has been removed"`. The UI prevents this by hiding the edit button, but the action has its own guard.

### Clip file cleanup

When a clip is deleted, `slicer.cleanup()` deletes its MP3 file. If the file is already missing (e.g., manually deleted), cleanup handles it silently.

When bounds are edited, the native slicer writes the new slice to the same path, overwriting the old file in place. (The actual extension depends on the source format — `.mp3` or `.m4a`.)

### Database reload after creation

`addClip` calls `fetchClips()` after database insertion rather than manually constructing a `ClipWithFile`. This ensures the clip has correct source file metadata from the JOIN, avoiding stale or missing data.

### Search across all fields

Search checks title, filename, transcription, and note. This means a user can find a clip by remembering what was said (transcription), what they wrote about it (note), or which book it's from (title/filename).

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
