# The Clips System

A guide for Ivy's clip (bookmark) system.

## The Big Picture

A clip is a bookmark into an audiobook — a short audio segment with an optional note and an automatic transcription. Clips let the user mark interesting passages and come back to them later.

Each clip captures:
- **Where** in the source book it starts, and how long it is
- **Its own audio file** — a slice of the source, stored permanently
- **A note** — user-written, optional
- **A transcription** — auto-generated from the first 3 minutes (see [docs/TRANSCRIPTION.md](TRANSCRIPTION.md))

Clips live independently of their source book. Even if the user archives the book (freeing storage), clips remain playable from their own audio files.

---

## Core Concepts

### 1. Every clip has its own audio file

When a clip is created, the relevant segment is extracted from the source book and saved as a standalone audio file at `{DocumentDirectory}/clips/{clipId}.m4a`. All clips are output as `.m4a` regardless of source format — the native slicer (`AudioSlicerModule`) shells out to the bundled FFmpeg (`libffmpeg.so`) to transcode the segment to AAC in an MPEG-4 container (`-map 0:a:0 -c:a aac`). This file is the clip's permanent audio — it doesn't depend on the source book existing.

On creation, the JS side passes a filename prefix (no extension) to the native slicer, which appends `.m4a` and returns the actual path; the return value is what gets persisted. The bounds-edit path hardcodes the `.m4a` destination instead — consistent, since the FFmpeg slicer always outputs `.m4a`. **`{id}.m4a` is an invariant**: the slicer has been all-m4a since before the first release, and sync relies on it (no extension is carried anywhere).

**FFmpeg packaging.** Clips are transcoded by an exec'd, vendored `libffmpeg.so` (arm64-v8a, no external dependency). `FFmpegEnvironment.ensureReady()` unpacks the bundle, builds the `LD_LIBRARY_PATH`, and pays the cold-link cost with a throwaway `-version` exec — exposed as `AudioSlicer.warmUp()` and called fire-and-forget at startup so the first slice isn't slow. Packaging, the vendored-soname closure, and the `doctor` check live in CLAUDE.md ("Native Packaging Changes") and [2026-08-04-vendor-ffmpeg.md](2026-08-04-vendor-ffmpeg.md).

Clip rows and audio also arrive via **sync**: a clip pulled from another device downloads its audio to `clips/{id}.m4a`, and later audio-only changes are refreshed in place via the audio content version. See [SYNC.md](SYNC.md). Sync-arrived clips are not queued for transcription immediately — they're picked up at the next transcription service start ([TRANSCRIPTION.md](TRANSCRIPTION.md)).

### 2. Clips reference their source, but don't require it

Each clip stores a `source_id` pointing to the book it came from. When the source book is available, clips can play from the full book audio (showing surrounding context on the timeline), be edited to expand or shrink their bounds, and offer "go to source" navigation.

When the source book is archived or deleted, clips fall back to their own audio file. Editing is disabled, but playback, notes, transcription, and sharing all continue to work.

### 3. Playback ownership

Both ClipViewer and ClipEditor are playback components — they control the audio player via a unique `ownerId`, preventing conflicts with the main player or other clip viewers. ClipViewer generates its own (`clip-viewer-{id}`); ClipEditor takes it as a prop — deliberately, so the caller can claim ownership *for* it (ClipsListScreen passes `clip-editor-{id}`, PlayerScreen passes `clip-editor-draft`). On dismissal they release playback: pause, then return ownership to the main player with the book and position it had before the clip took over. See the playback ownership system in [PLAYBACK.md](PLAYBACK.md).

---

## Architecture Overview

Layers, top to bottom:

- **ClipsListScreen** — lists all clips, search, context menus (View/Edit/Delete/Share)
- **ClipViewer** (read-only; plays from source or own file) → opens **ClipEditor** (bounds + note; requires source)
- **Store actions** — `addClip`, `updateClip`, `deleteClip`, `shareClip`, `seekClip`
- **Services the actions coordinate** — Database (SQLite), Slicer (native), Sync queue, Transcription queue

The clips system doesn't have a dedicated service — it's built from store actions that coordinate the database, audio slicer, sync queue, and transcription queue. This is appropriate: clips don't need background processing or event streams of their own.

---

## Creating a Clip

The clip button on the player opens the **draft clip editor** — the same ClipEditor used for editing, seeded with a selection of `[position, position + 250ms]` (`DEFAULT_CLIP_DURATION_MS`, capped at the book's end) and an empty note — the tiny default assumes the user marks the start and grows the selection from there. The user adjusts bounds and note, then Save creates the clip; Cancel creates nothing.

Playback transitions seamlessly in both directions: PlayerScreen claims ownership *for* the editor (ownerId `clip-editor-draft`) before mounting it, and reclaims for the main player before unmounting it — same file, same position, same playing/paused state. The editor plays at 1x (the clip-owner rule; deliberate — you hear what a shared clip's recipient will hear), and the book's speed is restored on return. The hand-back position is the editor's playhead, so scrubbing in the editor moves the book position ("unified players"). See [2026-07-25-player-clip-editor.md](2026-07-25-player-clip-editor.md).

The creation pipeline is in `add_clip.ts`: validate, resolve duration (explicit from the editor, `DEFAULT_CLIP_DURATION_MS` otherwise, always capped to remaining audio), slice audio, save to database with the note, queue sync, reload (`fetchClips`), then queue transcription — the reload deliberately precedes the transcription queueing, so the `queued` event sets `transcription.pending` for a clip already in the store.

---

## Clip Independence

This is one of the most important design decisions in the clip system. A clip's relationship to its source book has two states:

### Source available (`file_uri !== null && file_duration !== null`)

The source book's audio file is on disk *and* its duration is known (both can be null independently — see the LEFT JOIN below). The clip can:
- **Play from source** — the timeline shows the full book, with the clip's range highlighted
- **Edit bounds** — the user can expand or shrink the clip, re-slicing from the source
- **Go to source** — hand playback to the main player, playing the source book from the clip's start (`seekClip`), and navigate to it

### Source unavailable

The source book has been archived or deleted. The clip can still:
- **Play from its own file** — the timeline shows only the clip's duration
- **Display notes and transcription** — these are stored in the clip record
- **Be shared** — the clip's own audio file is sent via the share sheet

But it **cannot**:
- Edit bounds (no source to re-slice from)
- "Go to source" (no book to navigate to)

In both states, ClipViewer **auto-pauses once** when the playhead reaches the clip's end — the user can resume past it, and seeking back inside the range re-arms the auto-pause.

### The `ClipWithFile` type

The database returns clips enriched with source file metadata via a **LEFT JOIN**:

```typescript
interface ClipWithFile extends Clip {
  file_uri: string | null    // Source book's URI (null if archived/deleted or book row missing)
  file_name: string | null
  file_title: string | null
  file_artist: string | null
  file_duration: number | null
}
```

Book metadata is preserved in the `files` table even after archiving or deletion (soft-delete), so the clip usually knows what book it came from even if the audio is gone. But the LEFT JOIN means the book **row** can also be missing entirely — a clip synced before its book arrived, a book id retired by an identity merge, or an archived (audio-less) row removed by a book tombstone — in which case *all* `file_*` fields are null, not just `file_uri`. Never assume `file_name` or `file_duration` are present.

For display, clips also carry their own **snapshot** of the book's identity: `source_title` (book title, falling back to file name) and `source_artist`, captured at creation, synced in the clip payload, and backfilled once by migration. UI falls back `file_title || file_name || source_title` — the live join wins (reflects later metadata edits), the snapshot only covers orphans. `source_artist` is captured and synced but not currently displayed anywhere. Legacy backups lack the fields, so pulls never null out a local snapshot (`COALESCE` in `restoreClipFromBackup`).

Search in ClipsListScreen matches `file_title`, `file_name`, `transcription`, and `note` — notably *not* `source_title`, so orphaned clips can't be found by book name.

---

## Editing Clips

Editing requires the source book's audio file — if the source is archived, editing is disabled. When bounds change (`update_clip.ts`):

- The source is re-sliced and the old audio file replaced via backup-swap (`slicer.move`: the old file is kept as `.bak` until the move succeeds, so a failed re-slice never loses the clip's only audio)
- The transcription is cleared and the clip re-queued
- Note-only edits skip both entirely

**Linked bounds ("bounds follow playhead").** The editor has a link toggle (lower right; its state is a remembered preference — `settings.clip_editor_linked`, default on). While linked, the playhead is solid and pushes are outward-only: any playhead movement — scrub, fling, tap-to-seek, or playback itself — pushes the start anchor backward or the end anchor forward when it collides with them; reverse movements release the anchor, and shrinking the selection is handle work. The core workflow: scrub to the start point, hit play, pause where the clip should end. Toggle the link off for free playhead movement. Design and rationale in [2026-07-24-linked-clip-bounds.md](2026-07-24-linked-clip-bounds.md); the push mechanic lives in the timeline physics engine (`timeline/engine.ts`, `linked` mode).

**Detached playhead.** Grabbing a selection handle while audio plays freezes the timeline scroll but not the playhead: it detaches from the center and keeps moving across the frozen bars (off-screen if playback outruns the viewport). Pushes are driven by playhead motion, so a detached playhead still pushes the *other* anchor when linked — never the one under the finger. On release, the scroll glides the playhead back to center (drift-fold decay, ~1s); the catch-up moves only the scroll, so it never re-pushes anchors. Handles are grabbable along their full height (line + pin column), not just the pin circle. See [2026-08-08-detached-playhead.md](2026-08-08-detached-playhead.md).

---

## Sharing a Clip

`shareClip` sends the clip's audio via the native share sheet. Clip files are named by UUID, which recipients would see as the filename — so the file is shared through a **friendly-named copy**: `Clip from <book title> <uuid8>.m4a` (title from `file_title`, falling back to the `source_title` snapshot; sanitized and capped). The uuid fragment keeps names unique across clips and stable per clip, so re-sharing overwrites the same copy.

Copies live in `<cache>/share/`. There is no post-share deletion — recipients (e.g. a backgrounded Drive upload) may read the content URI after the sheet closes. Instead, copies **older than 24h are deleted at the next share**, and the OS purges the cache dir under storage pressure. If the copy fails for any reason, the original UUID-named file is shared instead — never worse than no copy.

---

## Deleting a Clip

`deleteClip` removes the clip's audio file, deletes the database row, and queues a sync `delete`. Unlike book deletion (which is per-device), clip deletion is **global**: it propagates to every device via a sync tombstone. See [SYNC.md](SYNC.md).

---

## Edge Cases

### Database reload after creation

`addClip` calls `fetchClips()` after database insertion rather than manually constructing a `ClipWithFile`. This ensures the clip has correct source file metadata from the JOIN, avoiding stale or missing data.

### Transcription results are persisted by the store

The store is the single writer for transcription results, and discards results made stale by a concurrent bounds edit — full rules in [TRANSCRIPTION.md](TRANSCRIPTION.md) ("Persistence: the store is the single writer").

### Orphaned audio cleanup

`cleanup_orphaned_files` sweeps `clips/` (and `audio/`) for files with no matching database row, with a 1-hour grace period protecting in-flight slices — the safety net behind the `.bak` swap above.

---

## File Map

```
src/actions/
  add_clip.ts         → Creates clip: validates, slices, saves, queues
                        (optional { duration, note } from the draft editor)
  update_clip.ts      → Updates note/bounds, re-slices if needed
  delete_clip.ts      → Deletes file, record, queues sync
  share_clip.ts       → Shares clip audio via native sheet (friendly filename)
  fetch_clips.ts      → Loads all clips with source file metadata
  seek_clip.ts        → Plays source book from clip start as main player
  cleanup_orphaned_files.ts → Sweeps audio/ + clips/ for row-less files (1h grace)
  constants.ts        → DEFAULT_CLIP_DURATION_MS (250ms), CLIPS_DIR

src/services/
  audio/slicer.ts     → Native audio extraction (Kotlin module wrapper)
  system/sharing.ts   → Native share sheet wrapper (share-cache copy + cleanup)
  storage/database.ts → Clip CRUD, ClipWithFile JOIN queries

src/components/
  ClipViewer.tsx      → Read-only clip modal (playback, transcription, note;
                        tap section to expand, long-press to copy to clipboard)
  ClipEditor.tsx      → Edit bounds and note (requires source file); mode-free
                        normalized props — ClipsListScreen maps an existing
                        clip, PlayerScreen maps a new-clip draft

src/screens/
  ClipsListScreen.tsx → Full clip list with search, context menus

src/store/
  index.ts            → Wires clip actions, transcription events
  types.ts            → ClipWithFile in AppState, action types
```

**Testing:** `src/actions/__tests__/{add,update,delete,share,seek}_clip.test.ts`, `cleanup_orphaned_files.test.ts`; maestro flows `add-clip.yaml`, `clip-crud.yaml`, `clip-dismiss-release.yaml`.
