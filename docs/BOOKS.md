# The Books System

A guide for Ivy's library, file loading, archiving, and deletion.

## The Big Picture

A **Book** is Ivy's domain entity for an audiobook or podcast file. The library is a collection of books — each with a saved position, metadata (title, artist, artwork), and an audio file stored in app-owned storage.

Books go through a lifecycle: they're added to the library, played, and eventually archived or deleted. The system is designed so that:

- **Adding the same file twice** doesn't create duplicates — it's detected via fingerprinting
- **Archiving** frees disk space while keeping the book visible and its clips intact
- **Deleting** hides the book from the UI entirely, but the record stays in the database
- **Re-adding** the same file restores an archived or deleted book, preserving its position and clips

---

## Core Concepts

### 1. App-owned storage

External URIs (from file pickers, Google Drive, etc.) become invalid after app restart on Android. To avoid this, every imported file is **copied to app-owned storage** at `{DocumentDirectory}/audio/`. The database stores only local `file://` paths. This is the foundation of reliable playback.

The original file is normally left untouched. With the **"Delete original after import"** setting enabled (`settings.delete_original_after_import`, off by default), a successful new import or restore also deletes the picked source document via `DocumentsContract.deleteDocument` (`copier.deleteSource`). This is best-effort: providers that don't support deleting picked documents refuse, and the import still succeeds. Deletion is verified natively (a provider reporting success while the source still opens counts as a failure), and a failed delete shows a "Could not delete original file" toast. Active duplicates and failed imports never delete the original.

### 2. File fingerprinting

Each book stores its `file_size` (bytes) and `fingerprint` (first 4KB of the file as a BLOB). This pair uniquely identifies the audio content. When a file is added, the system checks for an existing book with the same fingerprint before creating a new one. If the source provider doesn't report a size (returns `-1`), the lookup falls back to fingerprint-only matching, and the real size is backfilled from the bytes actually copied — `-1` is never persisted.

### 3. Soft-delete, not hard-delete

Books are never removed from the database by user actions. Archiving sets `uri = null`. Deletion sets `uri = null` and `hidden = true`. (The one exception is internal to sync: cross-device identity merges hard-delete a retired duplicate row — see [SYNC.md](SYNC.md).) The record persists so that:

- Clips can still reference their source book's metadata
- Sessions (listening history) still display correctly
- Re-adding the same file triggers a restore via fingerprint match

### 4. Optimistic updates with rollback

Archive and delete actions update the Zustand store immediately (optimistic), then persist to the database. If the database write fails, the store is rolled back to its previous state. File deletion is fire-and-forget — it happens asynchronously and doesn't affect the success of the operation.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                      LibraryScreen                            │
│  Active books · Archived section · Search · Add/Archive/Delete│
└──────────┬───────────────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────────────────────────┐
│                       Store Actions                           │
│  loadFile · loadFileWithPicker · loadFileWithUri              │
│  cancelLoadFile                                               │
│  fetchBooks · archiveBook · deleteBook                        │
└───┬──────────┬──────────┬──────────┬────────────────────────┘
    │          │          │          │
    ▼          ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐
│  File  │ │Metadata│ │Database│ │  Sync  │
│Storage │ │Service │ │Service │ │ Queue  │
└────────┘ └────────┘ └────────┘ └────────┘
  copy,      title,     upsert,    queue
  rename,    artist,    archive,   changes
  delete,    artwork,   hide,
  fingerprint duration   restore
```

No dedicated "library service" — the actions coordinate the storage, metadata, and database services directly.

---

## Adding a Book

When the user picks a file (or one is provided by URI), `loadFile()` runs a pipeline: open the source and read its size + fingerprint (`copier.beginCopy` — nothing written to disk yet), check for duplicates, then commit the copy directly to its final path in app storage, extract metadata and chapters, and write the database record.

**Filename gotcha:** Destination files are named `audio/{bookId}{ext}` — the book's UUID plus the original file's extension, run through `sanitizeFilename` to strip characters that break Android's `MediaMetadataRetriever` (colons, brackets, etc.). The UUID makes collisions impossible; the original filename survives only in the database (`name` column).

### Check for existing book

The fingerprint is looked up in the database:

```sql
SELECT * FROM files WHERE file_size = ? AND fingerprint = ?
```

This produces one of three outcomes, each handled differently. See [The Three Loading Cases](#the-three-loading-cases).

### Refresh

After the database is updated, `fetchBooks()` and `fetchClips()` reload all data from the database. The library status returns to `'idle'`.

### Cleanup

Files are copied directly to their final path (`audio/{bookId}{ext}`) — there is no temp file or rename step. Several layers ensure no orphaned files remain:

- The native copier deletes the destination file itself when the copy fails or is cancelled
- If metadata extraction or the DB write fails after the copy, `loadFile`'s catch deletes the copied file — but only if no database record references it
- Any leftovers that slip through are reclaimed by `cleanupOrphanedFiles`, which runs at the start of the next `loadFile` and deletes files with no matching database record — but only files last modified more than 60 minutes ago, so in-flight writes (background sync downloads, clip slices) are never swept mid-operation
- Cleanup failures are swallowed — they never affect the operation's outcome

---

## File Fingerprinting

Fingerprinting answers: "Have we seen this audio file before?"

### How it works

Two values are stored per book:

| Field | Value | Purpose |
|-------|-------|---------|
| `file_size` | Exact byte count | Fast first filter (indexed column) |
| `fingerprint` | First 4,096 bytes | Content-based identity |

The database query uses `file_size` first (indexed, fast integer comparison), then `fingerprint` (BLOB comparison, only on candidates with matching size).

### Why first 4KB?

Audio files of the same content but from different sources typically share identical headers and initial audio frames. 4KB is enough to capture the file format headers and the beginning of the audio data, providing extremely low collision probability while being fast to read.

### Fingerprints also drive cross-device identity

The fingerprint answers "same audio?" in two places:

- **Re-add restore (local):** adding a file whose fingerprint matches an archived/deleted book restores that book (Case A above).
- **Identity merge (sync):** when sync downloads a remote book whose fingerprint matches a local book with a *different* id (the same audio was imported independently on two devices), the two identities are merged — every device converges on the lexicographically smaller id, and clips/sessions are re-keyed to it. See [SYNC.md](SYNC.md) for the mechanism.

---

## The Three Loading Cases

After fingerprinting, `loadFile()` branches into one of three cases:

### Case A: Restore archived or deleted book

**Condition:** Fingerprint matches an existing book with `uri === null` (either archived or deleted — the code doesn't distinguish)

The existing book record is restored:

1. Commit the copy directly to `audio/{existingBook.id}{ext}`
2. Call `db.restoreBook()` — sets the new URI, updates metadata, sets `hidden = 0`, preserves the saved position
3. Queue for sync

The user gets their book back exactly where they left off, with all clips intact. This works the same whether the book was archived or fully deleted.

### Case B: Active duplicate

**Condition:** Fingerprint matches an existing book with `uri !== null`

The file already exists in the library. No new record is created:

1. Cancel the in-flight copy (`copier.cancelCopy`) — nothing was committed to app storage
2. Call `db.touchBook()` — updates `updated_at` timestamp (moves it to top of list)
3. Queue for sync

### Case C: New book

**Condition:** No fingerprint match

A new book is created:

1. Generate a UUID
2. Commit the copy to `audio/{uuid}{ext}`
3. Call `db.upsertBook()` with all metadata, position 0, and the fingerprint
4. Queue for sync

---

## Book States

A book exists in one of three states, determined by two fields:

| State | `uri` | `hidden` | In library UI | Clips work | Can restore |
|-------|-------|----------|---------------|------------|-------------|
| **Active** | `file://...` | `false` | Yes (main list) | Full (edit, play from source) | N/A |
| **Archived** | `null` | `false` | Yes (archived section) | Partial (own audio only) | Re-add same file |
| **Deleted** | `null` | `true` | No | Partial (own audio only) | Re-add same file |

```typescript
const isActive   = book.uri !== null
const isArchived = book.uri === null && !book.hidden
const isDeleted  = book.uri === null && book.hidden
```

The `getAllBooks()` database query filters by `hidden = 0`, so deleted books don't appear in the store at all. Archived books appear because `hidden` is false — the UI separates them by checking `uri === null`.

---

## Archiving

Archiving frees disk space while keeping the book visible. Uses optimistic-update-with-rollback (see Core Concepts).

**After archiving:**
- The book appears in the "Archived" section of the library
- Clips continue to work using their own audio files
- Clip editing is disabled (no source to re-slice from)
- The book cannot be played (no audio file)
- Re-adding the same file triggers a restore

---

## Deletion

Deletion hides the book from the library entirely. Uses optimistic-update-with-rollback (see Core Concepts).

**After deletion:**
- The book disappears from the library UI
- The database record remains (with `hidden = true`)
- Clips still work (they're independent entities)
- Sessions still reference the book metadata (via LEFT JOIN — the soft-deleted row keeps it available)
- Re-adding the same file triggers a restore

### Deletion is local-only

Archive and delete are **per-device** operations — they never sync. `hidden` is a local-only field (excluded from the book backup payload), and neither operation bumps `updated_at`/`updated_by` or queues a sync change. Deleting a book on your phone doesn't touch your tablet; the book's JSON stays in the shared cloud library. See [SYNC.md](SYNC.md) for the rationale and consequences.

This is why not bumping `updated_at` matters: the sync engine re-queues an upsert whenever local `updated_at` exceeds remote (local-ahead), so an archive-time bump would ship the book's pre-archive fields anyway and could revert a newer edit from another device.

---

## Restoration

Restoration is automatic — it happens when adding a file that matches a known fingerprint (Case A in the Three Loading Cases). There's no explicit "restore" button.

Key preservation rules in `db.restoreBook()`:

- **Metadata** — existing title, artist, artwork win over ID3 tags (protects user edits); falls back to ID3 values only when existing fields are null
- **Position** — the user's saved playback position is preserved

---

## File Map

```
src/actions/
  load_file.ts           → Core loading pipeline (copy, metadata, fingerprint, upsert)
  load_file_with_uri.ts  → Thin wrapper: uri + name → loadFile
  load_file_with_picker.ts → Launch picker → loadFile
  cancel_load_file.ts    → Cancel the active copy
  fetch_books.ts         → Load all non-hidden books into store
  archive_book.ts        → Set uri=null, delete file
  update_book.ts         → Update title/artist, queue sync
  delete_book.ts         → Set uri=null + hidden=true, delete file
  cleanup_orphaned_files.ts → Delete app-storage files with no DB record
  constants.ts           → CLIPS_DIR, skip durations (no book-specific constants)

src/components/
  MetadataEditor.tsx     → Dialog content for editing book title/artist (shows artwork read-only)
  LibraryLoadingDialog.tsx → Progress dialog for adding books (copy)

src/services/storage/
  database.ts            → Book CRUD, fingerprint lookup, archive/hide/restore
  files.ts               → FileStorageService (delete, list, audio dir helpers)
  copier.ts              → FileCopierService (native file copy with progress + cancel)
  picker.ts              → FilePickerService (expo-document-picker wrapper)

src/services/audio/
  metadata.ts            → AudioMetadataService (native ID3 tag extraction)

src/screens/
  LibraryScreen.tsx      → Book list with active/archived sections, search, menus

src/store/
  index.ts               → Wires book actions, position sync, auto-sync trigger
  types.ts               → Book type, library status in AppState

android/.../
  AudioMetadataModule.kt    → Native metadata extraction (MediaMetadataRetriever)
  FileCopierModule.kt       → Native file copy with progress, fingerprint, cancellation
  ChapterReaderModule.kt    → Native chapter extraction via bundled FFmpeg (-f ffmetadata)
```
