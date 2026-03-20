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

### 2. File fingerprinting

Each book stores its `file_size` (bytes) and `fingerprint` (first 4KB of the file as a BLOB). This pair uniquely identifies the audio content. When a file is added, the system checks for an existing book with the same fingerprint before creating a new one.

### 3. Soft-delete, not hard-delete

Books are never removed from the database. Archiving sets `uri = null`. Deletion sets `uri = null` and `hidden = true`. The record persists so that:

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
│  loadFromUrl · cancelLoadFile                                 │
│  fetchBooks · archiveBook · deleteBook                        │
└───┬──────────┬──────────┬──────────┬──────────┬─────────────┘
    │          │          │          │          │
    ▼          ▼          ▼          ▼          ▼
┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌──────────┐
│  File  │ │Metadata│ │Database│ │  Sync  │ │   File   │
│Storage │ │Service │ │Service │ │ Queue  │ │Downloader│
└────────┘ └────────┘ └────────┘ └────────┘ └──────────┘
  copy,      title,     upsert,    queue      download
  rename,    artist,    archive,   changes    via yt-dlp
  delete,    artwork,   hide,                 (YouTube,
  fingerprint duration   restore               etc.)
```

No dedicated "library service" — the actions coordinate the storage, metadata, and database services directly.

---

## Adding a Book

When the user picks a file (or one is provided by URI), `loadFile()` runs a pipeline: copy to app storage, extract metadata, read fingerprint, then check for duplicates.

**Filename gotcha:** The filename is sanitized to remove characters that break Android's `MediaMetadataRetriever` (colons, brackets, etc.). A timestamp suffix prevents collisions.

### Check for existing book

The fingerprint is looked up in the database:

```sql
SELECT * FROM files WHERE file_size = ? AND fingerprint = ?
```

This produces one of three outcomes, each handled differently. See [The Three Loading Cases](#the-three-loading-cases).

### Refresh

After the database is updated, `fetchBooks()` and `fetchClips()` reload all data from the database. The library status returns to `'idle'`.

### Cleanup

A `finally` block ensures no orphaned files remain:

- The temporary file (pre-rename) is always deleted
- If a renamed file exists but has no corresponding database record (DB write failed), it's also deleted
- Cleanup failures are swallowed — they never affect the operation's outcome

---

## Adding a Book from URL

The "Download URL" option in the library menu lets users add books from YouTube and other yt-dlp-supported sites. This is handled by `loadFromUrl()`, which follows a different pipeline than `loadFile()` but converges on the same fingerprint → three cases → DB logic.

### How it works

Downloads via `FileDownloaderService` → native `FileDownloaderModule` (wraps `youtubedl-android`). File is downloaded to `{CachesDirectory}/downloads/` as m4a with embedded metadata, then goes through the same fingerprint → three cases → DB logic as `loadFile()`, and finally moved to app storage.

### Native module gotchas

- **Lazy initialization** — yt-dlp and FFmpeg are initialized on first use via `ensureInitialized()`, using a `CountDownLatch` so concurrent calls block until init completes.
- **Legacy packaging required** — `expo.useLegacyPackaging=true` in `gradle.properties` is required because yt-dlp's native `.so` files must be extracted to disk (not kept compressed in the APK).

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

---

## The Three Loading Cases

After fingerprinting, `loadFile()` branches into one of three cases:

### Case A: Restore archived or deleted book

**Condition:** Fingerprint matches an existing book with `uri === null` (either archived or deleted — the code doesn't distinguish)

The existing book record is restored:

1. Rename the temp file to use the existing book's ID as filename
2. Call `db.restoreBook()` — sets the new URI, updates metadata, sets `hidden = 0`, preserves the saved position
3. Queue for sync

The user gets their book back exactly where they left off, with all clips intact. This works the same whether the book was archived or fully deleted.

### Case B: Active duplicate

**Condition:** Fingerprint matches an existing book with `uri !== null`

The file already exists in the library. No new record is created:

1. Call `db.touchBook()` — updates `updated_at` timestamp (moves it to top of list)
2. Queue for sync
3. The temp file is cleaned up in the `finally` block

### Case C: New book

**Condition:** No fingerprint match

A new book is created:

1. Generate a UUID
2. Rename the temp file to use the UUID as filename
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
- Sessions still reference the book metadata (via INNER JOIN)
- Re-adding the same file triggers a restore

### Why upsert, not delete for sync?

Both archive and delete queue an `'upsert'` sync operation, not a `'delete'`. This is because books use soft-delete — the record still exists with `hidden: true`. Other devices need to learn about the hidden flag via sync. On the remote side, the `hidden-wins` merge strategy ensures deletion propagates correctly.

---

## Restoration

Restoration is automatic — it happens when adding a file that matches a known fingerprint (Case A in the Three Loading Cases). There's no explicit "restore" button.

Key preservation rules in `db.restoreBook()`:

- **Metadata** — existing title, artist, artwork win over ID3 tags (protects user edits); falls back to ID3 values only when existing fields are null
- **Position** — the user's saved playback position is preserved

---

## Notes

### File move optimization

When the source URI is already a local path (starts with `file://` or `/`), `FileStorageService` moves the file instead of copying it. This avoids doubling disk usage for large audiobook files.

---

## File Map

```
src/actions/
  load_file.ts           → Core loading pipeline (copy, metadata, fingerprint, upsert)
  load_file_with_uri.ts  → Thin wrapper: uri + name → loadFile
  load_file_with_picker.ts → Launch picker → loadFile
  load_from_url.ts       → URL download pipeline (yt-dlp → fingerprint → upsert)
  cancel_load_file.ts    → Cancel active copy or download
  fetch_downloader_state.ts → Fetch yt-dlp version into store
  update_downloader.ts   → Update yt-dlp, refresh version
  fetch_books.ts         → Load all non-hidden books into store
  archive_book.ts        → Set uri=null, delete file
  update_book.ts         → Update title/artist, queue sync
  delete_book.ts         → Set uri=null + hidden=true, delete file
  constants.ts           → CLIPS_DIR, skip durations (no book-specific constants)

src/components/
  MetadataEditor.tsx     → Dialog content for editing book title/artist (shows artwork read-only)
  LibraryLoadingDialog.tsx → Progress dialog for adding books (copy or download)

src/services/storage/
  database.ts            → Book CRUD, fingerprint lookup, archive/hide/restore
  files.ts               → FileStorageService (copy, rename, delete, fingerprint read)
  copier.ts              → FileCopierService (native file copy with progress + cancel)
  downloader.ts          → FileDownloaderService (URL download via yt-dlp native module)
  picker.ts              → FilePickerService (expo-document-picker wrapper)

src/services/audio/
  metadata.ts            → AudioMetadataService (native ID3 tag extraction)

src/screens/
  LibraryScreen.tsx      → Book list with active/archived sections, search, menus, URL dialog
  SettingsScreen.tsx     → yt-dlp version display + update

src/store/
  index.ts               → Wires book actions, position sync, auto-sync trigger
  types.ts               → Book type, library status in AppState

android/.../
  AudioMetadataModule.kt    → Native metadata extraction (MediaMetadataRetriever)
  FileCopierModule.kt       → Native file copy with progress, fingerprint, cancellation
  FileDownloaderModule.kt   → Native yt-dlp wrapper (download, cancel, update, version)
```
