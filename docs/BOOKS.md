# The Books System

A guide for Ivy's library, file loading, archiving, and deletion.

## Table of Contents

1. [The Big Picture](#the-big-picture)
2. [Core Concepts](#core-concepts)
3. [Architecture Overview](#architecture-overview)
4. [Adding a Book](#adding-a-book)
5. [Adding a Book from URL](#adding-a-book-from-url)
6. [File Fingerprinting](#file-fingerprinting)
7. [The Three Loading Cases](#the-three-loading-cases)
8. [Book States](#book-states)
9. [Archiving](#archiving)
10. [Deletion](#deletion)
11. [Restoration](#restoration)
12. [The Library Screen](#the-library-screen)
13. [Edge Cases and Robustness](#edge-cases-and-robustness)
14. [File Map](#file-map)

---

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

When the user picks a file (or one is provided by URI), `loadFile()` runs a multi-step pipeline:

### Step 1: Copy to app storage

```
library.status = 'adding'  (UI shows "Adding to library..." modal)
```

The file is copied from its external URI to `{DocumentDirectory}/audio/{name}_{timestamp}.{ext}`. If the source is already a local `file://` path, it's moved instead of copied to save space.

The filename is sanitized — characters that break Android's `MediaMetadataRetriever` (colons, brackets, etc.) are removed. A timestamp suffix prevents collisions.

### Step 2: Read metadata

The native `AudioMetadataService` extracts ID3 tags from the file:

- **title** — track title (may be null)
- **artist** — artist/author name (may be null)
- **artwork** — album art as base64 data URI (may be null)
- **duration** — file length in milliseconds

Metadata extraction is non-critical — if it fails, the book is still added with null metadata and zero duration.

### Step 3: Read fingerprint

`FileStorageService.readFileFingerprint()` reads:

- **fileSize** — exact file size in bytes
- **fingerprint** — first 4,096 bytes of the file as a `Uint8Array`

### Step 4: Check for existing book

The fingerprint is looked up in the database:

```sql
SELECT * FROM files WHERE file_size = ? AND fingerprint = ?
```

This produces one of three outcomes, each handled differently. See [The Three Loading Cases](#the-three-loading-cases).

### Step 5: Refresh

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

1. **Download** — `FileDownloaderService` calls the native `FileDownloaderModule` (which wraps `youtubedl-android`). The file is downloaded to `{CachesDirectory}/downloads/` as m4a with embedded thumbnail and metadata (`--embed-thumbnail --embed-metadata`). Progress events (0–99%) update `library.addProgress`.

2. **Fingerprint** — `FileStorageService.readFileFingerprint()` reads the downloaded file, same as for local files.

3. **Duplicate check** — Same three-case logic as `loadFile()`: active duplicate → touch + report; archived/deleted match → restore; no match → new book.

4. **Move to app storage** — The downloaded file is moved (not copied) from the cache dir to `{DocumentDirectory}/audio/`.

5. **Metadata extraction** — `AudioMetadataService` reads the embedded metadata (title, artist, artwork, duration) from the file.

### Cancellation

`cancelLoadFile()` handles both file copy and URL download cancellation. It calls `downloader.cancelDownload()` which destroys the active yt-dlp process.

### Native module: FileDownloaderModule

The Kotlin module wraps `youtubedl-android` (yt-dlp + FFmpeg bundled as native libraries). Key details:

- **Lazy initialization** — yt-dlp and FFmpeg are initialized on first use via `ensureInitialized()`, using a `CountDownLatch` so concurrent calls block until init completes.
- **Legacy packaging required** — `expo.useLegacyPackaging=true` in `gradle.properties` is required because yt-dlp's native `.so` files must be extracted to disk (not kept compressed in the APK).
- **Progress** — Emits `FileDownloaderProgress` events with `{ opId, percent }` via `NativeEventEmitter`.

### Settings

The store tracks downloader state in `downloader: { version, status }`. The settings screen displays the current yt-dlp version with an "Update" link. The `fetchDownloaderState` action fetches the version on screen focus; `updateDownloader` runs the update (guarded: only when `status === 'idle'`). Updates target the STABLE channel.

### UI flow

Library menu → "Download URL" → Dialog with text input → "Download" button → `loadFromUrl(url)` → LibraryLoadingDialog shows progress → book appears in library.

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

### What it enables

- **Duplicate detection:** Adding the same file twice reuses the existing book record
- **Restore from archive:** Adding a file that matches an archived book restores it
- **Restore from deletion:** Adding a file that matches a deleted (hidden) book restores it

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

Archiving frees disk space while keeping the book visible:

1. **Optimistic update:** Set `book.uri = null` in the store
2. **Database update:** `UPDATE files SET uri = NULL WHERE id = ?`
3. **Queue for sync:** `syncQueue.queueChange('book', bookId, 'upsert')`
4. **Delete file:** Fire-and-forget, non-blocking

If step 2 fails, step 1 is rolled back (uri restored to its previous value). Step 4 never blocks or fails the operation.

**After archiving:**
- The book appears in the "Archived" section of the library
- Clips continue to work using their own audio files
- Clip editing is disabled (no source to re-slice from)
- The book cannot be played (no audio file)
- Re-adding the same file triggers a restore

---

## Deletion

Deletion hides the book from the library entirely:

1. **Optimistic update:** Remove from `state.books`
2. **Database update:** `UPDATE files SET uri = NULL, hidden = 1 WHERE id = ?`
3. **Queue for sync:** `syncQueue.queueChange('book', bookId, 'upsert')`
4. **Delete file:** Fire-and-forget, non-blocking

If step 2 fails, the entire book object is restored to the store.

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

Restoration is automatic — it happens as a side effect of adding a file that matches a known fingerprint.

There's no explicit "restore" button. The flow is:

1. User adds a file (from picker or URI)
2. `loadFile()` reads the fingerprint
3. Fingerprint matches an archived or deleted book → Case A
4. `db.restoreBook()` updates the record:
   - Sets `uri` to the new file path
   - Clears `hidden` flag (makes it visible again)
   - **Preserves metadata** — existing title, artist, artwork win over ID3 tags (protects user edits); falls back to ID3 values when existing fields are null
   - **Preserves position** (the user's saved playback position)
5. Queue for sync

The restored book appears in the main library list with its previous position intact.

---

## The Library Screen

### Layout

The library displays books in two sections:

1. **Active books** — books with audio files, sorted by `updated_at` descending (most recently used first)
2. **Archived books** — books without audio files (header: "Archived"), same sort order

### Search

A search bar filters across title, filename, and artist. Matching is case-insensitive substring search, applied client-side.

### Book interactions

**Tap an active book:**
- Calls `play({ fileUri: book.uri, position: book.position, ownerId: MAIN_PLAYER_OWNER_ID })`
- Navigates to the player tab
- Playback starts from the saved position

**Tap an archived book:**
- Shows an alert: "This book has been archived"
- No playback

**Context menu (active books only):**
- **Edit details** — opens metadata editor dialog (title, artist), then `updateBook(bookId, updates)`
- **Archive** — confirmation dialog, then `archiveBook(bookId)`
- **Remove from library** — confirmation dialog, then `deleteBook(bookId)`

Archived books don't show a context menu.

### Auto-sync

The library screen triggers auto-sync when the app returns to foreground:
- Must be at least 5 minutes since the last sync attempt
- Calls `autoSync()` which only runs if sync is enabled and the user is authenticated

### Data loading

Books are fetched on every screen focus via `useFocusEffect` → `fetchBooks()`. This ensures the list reflects changes from other screens (e.g., a book loaded from settings, or clips screen triggering a reload).

---

## Edge Cases and Robustness

### Orphaned file cleanup

The `loadFile()` finally block handles every failure mode:

| Failure point | Temp file | Renamed file |
|---------------|-----------|-------------|
| Copy fails | Doesn't exist | N/A |
| Metadata read fails | Deleted | N/A |
| Fingerprint read fails | Deleted | N/A |
| DB write fails | Deleted | Deleted (orphan) |
| Success | Deleted (post-rename) | Kept |

The orphan check: if a renamed file exists but `db.getBookByUri()` returns null, the file is deleted.

### Metadata extraction failure

If the native metadata module fails (unsupported format, corrupt headers), the book is still added with `title: null`, `artist: null`, `artwork: null`, `duration: 0`. The filename is used as the display name. Duration will show as 0 until the audio player loads the file and reports the real duration.

### Position preservation on restore

`db.restoreBook()` explicitly does **not** update the position field. This means a restored book resumes from exactly where the user left off before archiving or deleting.

### File move optimization

When the source URI is already a local path (starts with `file://` or `/`), `FileStorageService` moves the file instead of copying it. This avoids doubling disk usage for large audiobook files.

### Duplicate detection timing

Fingerprint checking happens **after** the file is copied to app storage. This means even if the file is a duplicate, a temporary copy exists briefly. The cleanup in the `finally` block handles this — the temp file is always deleted.

### Non-blocking file deletion

Both archive and delete perform file deletion asynchronously with `.catch(() => {})`. This means:
- The UI responds immediately
- The database is the source of truth, not the filesystem
- If deletion fails (permissions, disk error), the book state is still correct

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
