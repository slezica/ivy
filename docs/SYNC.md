# The Sync System

A guide for Ivy's Google Drive sync.

## Table of Contents

1. [The Big Picture](#the-big-picture)
2. [Core Concepts](#core-concepts)
3. [Architecture Overview](#architecture-overview)
4. [The Offline Queue](#the-offline-queue)
5. [The Sync Manifest](#the-sync-manifest)
6. [The Sync Flow](#the-sync-flow)
7. [The Planner](#the-planner)
8. [Conflict Resolution](#conflict-resolution)
9. [Google Drive Storage](#google-drive-storage)
10. [Authentication](#authentication)
11. [Integration with the Store](#integration-with-the-store)
12. [Edge Cases and Robustness](#edge-cases-and-robustness)
13. [File Map](#file-map)

---

## The Big Picture

Ivy is an audiobook app that runs on multiple devices. The sync system's job is to keep book metadata (positions, titles, archive state) and clips (bookmarks with audio snippets) consistent across all of them, using Google Drive as the shared backend.

**What gets synced:**
- Book metadata — positions, titles, artists, artwork, archive/delete state
- Clips — metadata as JSON, audio as MP3

**What does NOT get synced:**
- Full audiobook files (too large; users re-add from source)
- Listening sessions (local-only analytics)

The system is **offline-first**: the user can make changes with no network at all. Those changes are queued locally and pushed to Drive whenever a sync happens next.

---

## Core Concepts

Before diving into architecture, here are the three ideas that make the whole system work:

### 1. The Queue: "Remember what changed"

Every time the user does something sync-worthy — pauses at a new position, creates a clip, edits a note — the app doesn't try to upload immediately. Instead, it drops a record into a local SQLite queue: "book X was modified" or "clip Y was deleted." This queue survives app restarts.

### 2. The Manifest: "Remember what we last synced"

After a successful sync, the app records a **manifest entry** for each entity: "the last time we synced book X, the local timestamp was T₁ and the remote timestamp was T₂." On the next sync, comparing current timestamps against the manifest reveals exactly what changed — locally, remotely, or both.

### 3. The Plan: "Decide before acting"

Sync never improvises. It first gathers all state (local DB, remote Drive, manifests), then a **pure function** analyzes that state and produces a plan: "upload these, download those, merge these conflicts." Only then does execution begin. This separation makes the decision logic easy to test and reason about.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         Zustand Store                            │
│  (actions call syncQueue.queueChange on every mutation)          │
└──────────┬──────────────────────────────────────┬────────────────┘
           │ queues changes                       │ subscribes to events
           ▼                                      │
┌─────────────────────┐                           │
│   Offline Queue     │                           │
│   (sync_queue table)│                           │
└──────────┬──────────┘                           │
           │ drained first                        │
           ▼                                      │
┌──────────────────────────────────────────┐      │
│          BackupSyncService               │      │
│                                          │      │
│  1. Process queue (push offline changes) │      │
│  2. Gather state (local + remote + manifest)    │
│  3. Plan  (pure function → SyncPlan)     │      │
│  4. Execute (uploads, downloads, merges) │      │
│  5. Notify (emit events)                 │──────┘
└────┬─────────────┬───────────────────────┘
     │             │
     ▼             ▼
┌─────────┐  ┌──────────────┐
│ Planner │  │ Merge        │
│ (pure)  │  │ (pure)       │
└─────────┘  └──────────────┘
     │             │
     │  no I/O     │  no I/O
     │             │
     ▼             ▼
   SyncPlan    MergeResult
```

**Six source files, each with a clear role:**

| File | Role | Has side effects? |
|------|------|:-:|
| `auth.ts` | Google OAuth (sign in, get tokens) | Yes |
| `drive.ts` | Google Drive REST API (upload, download, list, delete) | Yes |
| `queue.ts` | Offline change queue (persist, process, retry) | Yes |
| `sync.ts` | Orchestrator (the "main loop" of sync) | Yes |
| `planner.ts` | Decides what operations are needed | **No** |
| `merge.ts` | Resolves conflicts between local and remote | **No** |

The pure/impure split is intentional. The planner and merge modules are the "brains" — they contain all the interesting logic but touch no network or database. This makes them fully unit-testable with simple in-memory data.

---

## The Offline Queue

When the user changes something that should eventually sync, the relevant store action calls:

```
syncQueue.queueChange('book', bookId, 'upsert')
```

or for deletions:

```
syncQueue.queueChange('clip', clipId, 'delete')
```

### How the queue works

The queue is a SQLite table (`sync_queue`) with a **unique constraint on (entity_type, entity_id)**. This means if the user updates a book's position three times before syncing, only one queue entry exists — the latest one. There's no buildup of redundant work.

Each entry tracks:
- **entity_type** and **entity_id** — what changed
- **operation** — `'upsert'` or `'delete'`
- **attempts** — how many times sync tried and failed (max 3)
- **last_error** — the most recent failure message

### Processing

At the start of every sync, the queue is drained first. Each item is processed by looking up the current entity in the local database and uploading it. If the entity was deleted locally, the corresponding remote files are found and removed.

Failed items get their `attempts` count incremented. After 3 failures, items are considered "dead" and skipped on future syncs (they can be manually retried via `retryFailed()`).

Successfully processed items are removed from the queue.

---

## The Sync Manifest

The manifest is the sync system's memory. It answers: **"What did the world look like the last time we synced this entity?"**

Stored in the `sync_manifest` SQLite table, each entry records:

| Field | Meaning |
|-------|---------|
| `entity_type` | `'book'` or `'clip'` |
| `entity_id` | The entity's UUID |
| `local_updated_at` | The entity's local `updated_at` at the time of last sync |
| `remote_updated_at` | The remote `modifiedTime` at the time of last sync |
| `remote_file_id` | The Drive file ID for the JSON backup |
| `remote_mp3_file_id` | The Drive file ID for the MP3 (clips only) |

### Change detection

The manifest enables **incremental sync** — we only transfer what actually changed:

- **Local change?** → `entity.updated_at > manifest.local_updated_at`
- **Remote change?** → `drive_file.modifiedTime > manifest.remote_updated_at`
- **Both changed?** → That's a conflict (see [Conflict Resolution](#conflict-resolution))
- **No manifest at all?** → Entity is new to this side; upload or download it

After each successful upload or download, the manifest is updated to reflect the new "last synced" state.

### Cleanup

At the end of a sync, the system scans for **orphaned manifests** — entries where the entity no longer exists locally *and* no longer exists remotely. These are deleted to prevent the manifest table from growing indefinitely.

---

## The Sync Flow

Here's what happens when the user taps "Sync now" or auto-sync fires:

### Step 1: Process the offline queue

Any changes that were queued while offline are pushed first. Each successful queue upload also updates the sync manifest for that entity. This is important: when the planner runs in Step 3, it compares timestamps against the manifest, so entities that were just pushed via the queue will appear "up to date" and won't be redundantly uploaded again.

### Step 2: Gather state

Three things are collected sequentially:
1. **Local state** — all books and clips from the SQLite database (synchronous reads)
2. **Remote state** — all files listed from Drive's `books/` and `clips/` folders, each downloaded and parsed one by one
3. **Manifests** — all entries from the `sync_manifest` table, indexed as `"book:id"` or `"clip:id"`

For remote clips, files are grouped by ID: each clip has a `.json` and a `.mp3` file. Both must be present for the clip to be considered valid.

### Step 3: Plan

The gathered state is passed to `planSync()`, a **pure function** that returns a `SyncPlan`:

```
SyncPlan {
  books: { uploads, downloads, merges }
  clips: { uploads, downloads, merges, deletes }
}
```

No network calls happen here — just analysis. This is covered in detail in [The Planner](#the-planner).

### Step 4: Execute

The plan is executed in order:
1. **Merges** first (resolve conflicts, upload merged result)
2. **Uploads** (push local changes to Drive)
3. **Downloads** (pull remote changes to local DB)
4. **Deletes** (remove remotely-deleted clips from Drive)

Each operation updates the manifest after success.

### Step 5: Notify

If any books or clips were modified by incoming remote changes (downloads or merges), the sync service emits a `data` event with the IDs of changed entities. The store listens for this and re-fetches the affected data.

### Step 6: Record sync time

`lastSyncTime` is written to the database. Auto-sync uses this to enforce a 5-minute cooldown.

---

## The Planner

`planner.ts` is the decision engine. It takes the full sync state and outputs a plan with no side effects.

### The algorithm

For each entity type (books, clips), the planner runs two passes:

**PUSH pass — iterate over local entities:**

```
for each local entity:
  manifest = look up manifest for this entity

  if no manifest → UPLOAD (entity is new locally)
  if local.updated_at > manifest.local_updated_at:
    if remote also changed → MERGE (conflict)
    else → UPLOAD (only local changed)
  else → do nothing (unchanged locally)
```

**PULL pass — iterate over remote entities:**

```
for each remote entity:
  manifest = look up manifest for this entity

  if no manifest → DOWNLOAD (entity is new remotely)
  if remote.modifiedAt > manifest.remote_updated_at:
    if local NOT changed → DOWNLOAD (only remote changed)
    else → skip (already scheduled as MERGE in push pass)
```

**DELETE pass (clips only) — iterate over remote clips:**

```
for each remote clip:
  if manifest exists AND no local clip → DELETE from remote
```

This means: "We knew about this clip (manifest exists), but it's gone locally, so the user deleted it."

Remote clips with **no manifest and no local match** are treated as new (downloaded, not deleted). This distinction is critical — without it, a clip created on Device B would be deleted on first sync with Device A.

### Why books aren't deleted remotely

Books use a soft-delete model (`hidden` flag). An archived or deleted book still has a database record, so from the planner's perspective it still "exists locally" and gets uploaded with `hidden: true`. The remote copy is never deleted — it's just marked as hidden.

---

## Conflict Resolution

A conflict occurs when the same entity was modified on two devices between syncs. The planner detects this; the **merge module** resolves it.

### Book merge strategy

| Field | Strategy | Rationale |
|-------|----------|-----------|
| `position` | **Max value wins** | The user progressed further on one device |
| `hidden` | **Hidden wins** | If deleted on either device, stay deleted |
| `title`, `artist`, `artwork` | **Last-write-wins** | Based on `updated_at` timestamps |

Example: Device A is at position 30:00, Device B at position 45:00. After merge, position is 45:00 regardless of which was modified more recently.

### Clip merge strategy

| Field | Strategy | Rationale |
|-------|----------|-----------|
| `note` | **Concatenate with conflict marker** | Preserves both users' writing |
| `start`, `duration` | **Last-write-wins** | Based on `updated_at` |
| `transcription` | **Prefer non-null** | If either side has a transcription, keep it |

When clip notes conflict, the merged result looks like:

```
My original note

--- Conflict (Jan 28, 2026) ---
Edit from other device
```

### After merging

The merged entity is:
1. Written to the local database
2. Uploaded to Drive (so all devices converge)
3. Recorded in the sync result as a conflict (for logging/debugging)

Both `updated_at` and the manifest are refreshed to `Date.now()` so the merged state becomes the new baseline.

---

## Google Drive Storage

### Folder structure

```
My Drive/
  Ivy/                          ← Root folder (created on first sync)
    books/                      ← One JSON file per book
      book_abc123-def456.json
      book_789xyz-012abc.json
    clips/                      ← JSON + MP3 pair per clip
      clip_def456-789xyz.json
      clip_def456-789xyz.mp3
```

### File naming convention

Files are named `{type}_{uuid}.{ext}`:
- `book_<id>.json` — book metadata
- `clip_<id>.json` — clip metadata
- `clip_<id>.mp3` — clip audio

The filename regex is: `/^(book|clip)_([a-f0-9-]+)\.(json|mp3)$/`

### Upload strategy

All uploads use Drive API's **resumable upload protocol**, which is a two-step process:
1. POST metadata to get an upload URI
2. PUT content to that URI

Note: while the protocol *supports* resuming interrupted uploads, Ivy does not implement retry/resume logic — if the PUT fails, the upload simply errors. The two-step approach is used because Drive requires it for setting file metadata (parent folder) at upload time.

### Clip upload safety

Clips involve two files (JSON + MP3). If the JSON uploads successfully but the MP3 fails, the JSON file is **rolled back** (deleted) with up to 3 retry attempts. This prevents orphaned JSON files on Drive that would confuse future syncs.

MP3 uploads are also size-capped at **50MB** to prevent out-of-memory errors on the device.

### Replace-on-upload

Drive doesn't support in-place file updates in Ivy's usage. Instead, uploads follow a **delete-then-create** pattern: before uploading a new version, the service lists the folder's files, finds the existing one by name, deletes it, and uploads a fresh copy. This means every upload produces a new Drive file ID, which is recorded in the manifest.

### Concurrent folder creation

When the app first syncs, it needs to create the `Ivy/`, `books/`, and `clips/` folders. If multiple operations fire concurrently, they could create duplicate folders. The Drive service prevents this with an in-flight promise cache — if a folder creation is already in progress, subsequent requests wait for the same promise instead of starting their own.

---

## Authentication

Authentication uses `@react-native-google-signin/google-signin` with the `drive.file` scope (access only to files created by the app).

### Two sync entry points, two auth behaviors

| Entry point | When | Auth behavior |
|-------------|------|---------------|
| `syncNow()` | User taps "Sync now" | **Interactive**: prompts sign-in if needed |
| `autoSync()` | App returns to foreground | **Silent**: skips entirely if not authenticated |

This distinction matters: auto-sync should never pop up a login dialog when the user is just opening the app. If the token is expired or revoked, auto-sync quietly does nothing.

### Token management

The native Google Sign-In library handles token refresh internally. The auth service just calls `getTokens()` and gets a fresh access token. If the session is truly expired (requires re-authentication), `getAccessToken()` returns `null`.

### Race condition prevention

Both `syncNow()` and `autoSync()` set `this.isSyncing = true` **before any async work** and check it as a guard at the top. This prevents concurrent syncs if the user taps the button twice or auto-sync fires while a manual sync is running.

One subtlety: `autoSync()` has an early-exit path — if `getAccessToken()` returns `null` (not authenticated), it resets `isSyncing = false` directly and returns without emitting a status event. This avoids showing sync UI flicker for a sync that never actually started.

---

## Integration with the Store

The sync system connects to Ivy's Zustand store at three points:

### 1. Queuing changes (store → queue)

Store actions that modify synced entities call `syncQueue.queueChange()`. For example, when the user's playback position updates, the store action queues a book upsert. Position updates are throttled (every 30 seconds) to avoid excessive queue writes.

### 2. Status updates (sync service → store)

The sync service emits `status` events containing `{ isSyncing, pendingCount, error }`. The store subscribes and updates its `sync` state, which the UI reads to show progress indicators and error messages.

### 3. Data notifications (sync service → store)

After downloading or merging entities, the sync service emits a `data` event with the IDs of changed books and clips. The store re-fetches the affected data from the database, keeping the in-memory state fresh.

### Store actions

Three thin actions expose sync to the UI:

- **`syncNow()`** — calls `sync.syncNow()` (fire-and-forget, status flows via events)
- **`autoSync()`** — only calls `sync.autoSync()` if `settings.sync_enabled`
- **`refreshSyncStatus()`** — reads `pendingCount` and `lastSyncTime` into the store

---

## Edge Cases and Robustness

### Delete vs. modify across devices

If Device A deletes a clip while Device B modifies it (with a later timestamp):
1. Device A syncs: removes the clip from Drive
2. Device B syncs: re-uploads the modified clip (no remote file found, treated as new upload)
3. Device A syncs again: downloads the "resurrected" clip

**Result:** Modification wins. There are no tombstones — deletion is simply the absence of the entity. This is a deliberate simplicity tradeoff.

### Books are never deleted from Drive

Because books use soft-delete (`hidden` flag), they always exist in the database and always get synced. A "deleted" book is just a book with `hidden: true` and `uri: null`. This means Device B will always learn about the deletion via the hidden flag during merge, using the **hidden-wins** strategy.

### Offline resilience

Changes queue to SQLite immediately. The queue survives:
- App restarts
- Network outages
- Sign-out / sign-in cycles

Even if sync fails repeatedly, queued items are retried (up to 3 attempts). After that, they're parked until manually retried.

### Backward compatibility

The `hidden` field in `BookBackup` defaults to `false` when missing (`remote.hidden ?? false`). This allows syncing with backup files created before the archive/delete feature existed.

### Stale data protection

The manifest cleanup step re-fetches local entities from the database instead of reusing the snapshot from the start of sync. This prevents a subtle bug: if a sync download creates a new local entity, the original snapshot wouldn't include it, and the cleanup might incorrectly delete its brand-new manifest.

---

## File Map

Quick reference for navigating the implementation:

```
src/services/backup/
  types.ts        → BookBackup, ClipBackup, SyncResult, SyncStatus, etc.
  auth.ts         → GoogleAuthService (OAuth sign-in, token management)
  drive.ts        → GoogleDriveService (REST wrapper for Drive API v3)
  queue.ts        → SyncQueueService (offline change queue with retry)
  planner.ts      → planSync() — pure function, returns SyncPlan
  merge.ts        → mergeBook(), mergeClip() — pure functions, resolve conflicts
  sync.ts         → BackupSyncService — the orchestrator

  __tests__/
    planner.test.ts → Tests for sync planning decisions
    merge.test.ts   → Tests for conflict resolution logic
    sync.test.ts    → Tests for concurrency and auth behavior

src/actions/
  sync_now.ts             → Manual sync action
  auto_sync.ts            → Background sync action (checks settings)
  refresh_sync_status.ts  → Refresh pending count and last sync time

src/store/index.ts        → Wires sync events to store state
```
