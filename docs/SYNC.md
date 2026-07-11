# The Sync System

A guide for Ivy's Google Drive sync.

## The Big Picture

Ivy is an audiobook app that runs on multiple devices. The sync system keeps book metadata (positions, titles, archive state), clips (bookmarks with audio snippets), and sessions (listening history) consistent across devices, using Google Drive as the shared backend.

**What gets synced:**
- Book metadata — positions, titles, artists, artwork, playback speed
- Clips — metadata as JSON, audio as M4A (legacy clips may use MP3)
- Sessions — listening history (time ranges per book)

**What does NOT get synced:**
- Full audiobook files (too large; users re-add from source)
- Book archive/delete state (`hidden` and `uri` are per-device — see [Books Are Per-Device](#books-are-per-device))

The system is **offline-first**: changes are queued locally and pushed to Drive whenever a sync happens next.

---

## Core Concepts

### 1. The Outbox: "Remember what changed"

Every sync-worthy mutation — pausing at a new position, creating a clip, editing a note — drops a record into a local SQLite outbox: "entity X needs to be pushed." The outbox deduplicates by entity, so rapid updates to the same book produce only one pending item. Each outbox entry records `updated_at_when_queued` — the entity's timestamp when queued — for stale upload detection.

### 2. The Drive Change Feed: "What changed remotely?"

Instead of listing all remote files on every sync, Ivy uses Drive's `changes.list` API with a saved page token. Each sync reads only the changes since the last token, making cost proportional to recent changes rather than total library size.

### 3. Per-Entity Reconciliation: "Decide on sight"

There is no global planning phase. When the sync engine encounters a changed entity (local or remote), it immediately compares versions via LWW and acts. This removes the need to assemble a complete world snapshot before making decisions.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         Zustand Store                            │
│  (actions call db.queueChange on every mutation)                 │
└──────────┬──────────────────────────────────────┬────────────────┘
           │ queues changes                       │ subscribes to events
           ▼                                      │
┌─────────────────────┐                           │
│   Outbox            │                           │
│   (sync_queue table)│                           │
└──────────┬──────────┘                           │
           │ drained in push phase                │
           ▼                                      │
┌──────────────────────────────────────────┐      │
│          BackupSyncService               │      │
│                                          │      │
│  1. Pull: Drive changes → LWW reconcile  │      │
│  2. Push: drain outbox → upload          │      │
│  3. Notify (emit events)                 │──────┘
└──────────────────────────────────────────┘
```

**Three source files, each with a clear role:**

| File | Role | Has side effects? |
|------|------|:-:|
| `auth.ts` | Google OAuth (sign in, get tokens) | Yes |
| `drive.ts` | Google Drive REST API (upload, download, list, changes, delete) | Yes |
| `sync.ts` | Sync engine (pull, push, LWW reconcile) | Yes |

---

## Version Metadata

Every synced entity carries two version fields:

- `updated_at: number` — timestamp of last modification (primary version marker)
- `updated_by: string | null` — device ID that produced the current state (tie-breaker only)

These are stamped automatically by database write methods. The `deviceId` is generated once per device and cached in `sync_metadata`.

### Version Comparison

| Case | Condition | Action |
|------|-----------|--------|
| Same version | Same `updated_at` and `updated_by` | Do nothing (update manifest) |
| Remote ahead | Remote `updated_at` > local, or tie-broken by `updated_by` | Apply remote locally |
| Local ahead | Everything else | Keep local, ensure outbox entry |

**Tie-breaking:** When `updated_at` matches, the lexicographically larger `updated_by` wins. This is arbitrary but deterministic — all devices make the same choice. There is always a winner; no merge step is needed.

---

## The Sync Flow

### Step 1: Pull — Process Remote Changes

1. Read `last_page_token` from `sync_checkpoint`.
2. If no token exists (first sync or recovery), get a `startPageToken`, perform a **full reconcile** (list all remote files), save the token, and return.
3. Call `changes.list` with the saved token.
4. Group changed files by Ivy entity (parse filenames).
5. For each changed entity, **reconcile**: download remote JSON, compare with local via LWW, download or skip.
6. Advance the page token only if every change reconciled successfully. If any entity fails, the token stays put and the whole batch is re-delivered next sync — re-processing already-reconciled entities is safe because same versions short-circuit.

If Drive returns an invalid token (410), the engine clears the checkpoint and falls back to full reconcile.

### Step 2: Push — Drain Local Outbox

1. Read all pending outbox items (under max attempts).
2. For each item:
   - Read the local entity.
   - Look up the manifest for an existing remote file ID.
   - **Update in place** if a remote file exists, or **create new** if not.
   - After upload, re-check the entity's `updated_at` against the outbox's `updated_at_when_queued`.
   - If the entity was modified during upload (stale), re-queue instead of clearing.
   - Otherwise, clear the outbox entry and update the manifest.
   - `delete` operations don't upload — they rewrite the remote JSON as a tombstone (see [Clip and Session Deletion: Tombstones](#clip-and-session-deletion-tombstones)).

### Step 3: Notify

If any entities were modified by incoming remote changes, the sync service emits a `data` event with changed IDs. The store re-fetches affected data.

### Step 4: Record Sync Time

`lastSyncTime` is written to the database. Auto-sync uses this to enforce cooldowns.

---

## Upload Strategy: Update In-Place

When uploading, the sync engine uses Drive's update API (`PATCH /upload/drive/v3/files/{fileId}`) to modify existing files. This preserves file IDs across versions, requires one request instead of list+delete+create, and produces cleaner change feed events.

Create-new is only used for the first upload of an entity (no known remote file ID).

---

## Conflict Resolution: Pure Last-Writer-Wins

All conflicts are resolved by **whole-entity LWW**: the version with the higher `(updated_at, updated_by)` wins entirely. There are no per-field merge rules — the last write replaces the whole entity.

This is intentional. Per-field merge rules (like "max position" or "hidden wins") encode assumptions about user intent that are often wrong. For example, if a user deliberately rewinds to re-listen, a "max position" merge would undo their choice. LWW is the only strategy users can reason about without understanding merge semantics: **what you did last is what you see**.

Consequences:
- Position can go backward if an older device syncs after the user rewinds on another
- Session time ranges don't widen — the latest version wins

These tradeoffs favor predictability over cleverness.

---

## Books Are Per-Device

Book *presence* is a per-device concern: audio never syncs, and neither does archive/delete state. The remote JSON collection is the shared cloud library; each device decides locally which of those books it holds audio for and which it has hidden.

Concretely:

- `hidden` is a **local-only field**. It is excluded from `BookBackup`, and applying a remote book never touches the local value (`restoreBookFromBackup` inserts new books as visible and omits `hidden` from its conflict-update list). Old remote JSONs may still contain a `hidden` field — readers ignore it.
- **Archive and delete don't queue sync changes and don't bump `updated_at`/`updated_by`.** The no-bump part is load-bearing: the local-ahead branches in reconciliation re-queue an upsert whenever local `updated_at` exceeds remote, so a bump would ship the change anyway — and could revert another device's newer edit (an archive at 12:00 would beat a title edit at 11:55).
- Deleting or archiving a book affects **only the device you do it on**. A locally deleted book is restored (hidden cleared, position preserved) by re-adding the same file.
- Clip and session deletion, by contrast, is global and propagates to all devices via tombstones (see [Clip and Session Deletion: Tombstones](#clip-and-session-deletion-tombstones)).

**Consequence (accepted):** a new device bootstraps *every* book ever added to the cloud library, including ones deleted locally elsewhere — they arrive as audio-less entries in the Archived section. If this becomes noise, a future explicit "remove from cloud" action can tombstone the book JSON.

**Cross-version caveat (beta):** upgrade all devices before the first post-upgrade delete. New-code uploads omit `hidden`, but *old-code* `restoreBookFromBackup` still applies `remote.hidden ?? false` in its conflict update — so any upsert from an upgraded device un-deletes hidden books on a not-yet-upgraded device.

---

## Clip and Session Deletion: Tombstones

Deleting a clip or session propagates to every device. The mechanism is a **tombstone**: instead of deleting the entity's Drive file, the deleting device rewrites the JSON in place as the **full last-known payload plus `deleted: true`**, stamped with the deletion time and the deleting device:

```json
{ "id": "…", "source_id": "…", "start": 10000, "note": "…", "deleted": true, "updated_at": 1760000000000, "updated_by": "device-…" }
```

The tombstone competes under ordinary LWW like any other version. The file — and its change-feed identity — never disappears, so deletions flow through the same reconcile path as edits.

### Why full payload, not a minimal stub?

Full-payload tombstones cost a few KB and buy graceful degradation everywhere a stub would crash:

- **Old-code devices** apply them as a harmless live edit — no parse crash on missing fields, no frozen page token. The clip merely lingers on stale devices until they upgrade.
- **Bootstraps and full reconciles** parse every JSON uniformly and branch on `deleted` alone.
- The filename stays valid, so `queueLocalOnlyEntities` still sees the entity id remotely and never re-uploads (resurrects) a deleted entity.

### Deletion flow (push side)

1. The delete action removes the local row immediately (optimistic) and queues `operation: 'delete'`. The outbox row's `updated_at_when_queued` records the deletion time — that timestamp becomes the tombstone's `updated_at`.
2. At push time the local row is gone, so the pusher **reads the current remote JSON** — that read doubles as the tombstone's payload source *and* the stale-tombstone guard (below).
3. The remote JSON is rewritten in place with `deleted: true`. For clips, the separate **audio file is hard-deleted** (reclaim space) and the manifest's `remote_audio_file_id` is nulled — the id is dead. The manifest row itself survives: the JSON file still exists and future writes must target it.
4. If no manifest entry exists (the entity was never uploaded), there is nothing to tombstone — the queue item is dropped silently.

### Stale-tombstone guard

Before overwriting the remote, the pusher checks what it just read. Three cases drop the queue item without writing:

| Remote state | Action |
|--------------|--------|
| `updated_at` newer than the deletion | The edit won LWW — drop the delete; the edit arrives via the normal pull path |
| Already a tombstone | Deletion already happened elsewhere — done |
| Read returns 404 (user purged Drive) | Nothing to tombstone — drop the queue item **and** the manifest entry |

### Applying tombstones (pull side)

Reconciliation parses the JSON and branches on `deleted` **before** any audio download or restore call — in the incremental feed and in full reconcile alike (a tombstoned clip is a JSON with no audio file, which a live clip would treat as incomplete).

- **Tombstone wins LWW** → delete the local row, delete the local clip audio file, null the manifest's dead `remote_audio_file_id`, notify the store (the entity id lands in the `data` event).
- **Local edit is newer** → the edit wins and re-uploads: this is an **un-delete**, acceptable LWW semantics. The receiver still nulls the manifest's audio id, so the re-upload creates a *fresh* audio file instead of updating the hard-deleted one, and other devices (including the deleter) pick the clip back up through the feed.
- **No local row** — already deleted locally, never seen, or a device's own tombstone echoing back through the change feed — is a graceful no-op.

### Retention

Tombstones are kept **forever**. They are a few KB each; if libraries ever accumulate enough of them to matter, compaction (dropping tombstones older than N months) can be added later.

**Cross-version caveat (beta):** tombstones are a one-way data-format door. Old code applies them as live edits (harmless), but the audio hard-delete makes old-code clip downloads fail for those entities, and reverting a device to pre-tombstone code re-exposes it to that. Upgrade all devices before the first post-upgrade delete.

---

## Google Drive Storage

### Folder Structure

```
My Drive/
  Ivy/                          ← Root folder (created on first sync)
    books/                      ← One JSON file per book
      book_abc123-def456.json
    clips/                      ← JSON + audio pair per clip
      clip_def456-789xyz.json
      clip_def456-789xyz.m4a
    sessions/                   ← One JSON file per session
      session_aabb1122-ccdd.json
```

### File Naming Convention

Files are named `{type}_{uuid}.{ext}`:
- `book_<id>.json` — book metadata
- `clip_<id>.json` — clip metadata
- `clip_<id>.m4a` — clip audio (legacy clips may use `.mp3`)
- `session_<id>.json` — session metadata

### JSON Payloads

All JSON payloads include `updated_at` and `updated_by` for version comparison. Legacy payloads missing `updated_by` are handled gracefully (treated as `null`).

### Clip Upload Safety

Clips involve two files (JSON + audio). Audio uploads are size-capped at 50MB. If a clip's audio file exceeds this, the upload fails with an error rather than risking OOM. If the audio upload fails after a new JSON file was created, the JSON is deleted (rolled back) to prevent orphans. Update-in-place JSON uploads don't need rollback since the old content remains valid.

---

## Authentication

Authentication uses `@react-native-google-signin/google-signin` with the `drive.file` scope (access only to files created by the app).

### Two Sync Entry Points

| Entry point | When | Auth behavior |
|-------------|------|---------------|
| `syncNow()` | User taps "Sync now" | **Interactive**: prompts sign-in if needed |
| `autoSync()` | App returns to foreground | **Silent**: skips entirely if not authenticated |

---

## Integration with the Store

### 1. Queuing Changes (store → outbox)

Store actions that modify synced entities call `db.queueChange()`. A shim object `syncQueue` in the store delegates to this method so action deps remain clean. Position updates are throttled (every 30 seconds).

### 2. Status Updates (sync service → store)

The sync service emits `status` events containing `{ isSyncing, pendingCount, error }`. The store subscribes and updates its `sync` state.

### 3. Data Notifications (sync service → store)

After downloading remote entities, the sync service emits a `data` event with changed entity IDs. The store re-fetches affected data from the database.

---

## Concurrency

### Same-Device

A local mutex (`isSyncing` flag) ensures only one sync runs at a time. The outbox's `updated_at_when_queued` field handles the case where an entity is modified while its upload is in flight — the upload becomes stale and the outbox entry is refreshed instead of cleared.

### Cross-Device

No distributed locks. Convergence comes from:
- Version metadata on entities (`updated_at`, `updated_by`)
- Deterministic LWW comparison with tie-breaking
- Eventual replay of remote changes via the Drive change feed

---

## Recovery

### Full Reconcile Triggers

- First sync (no saved page token)
- Drive returns an invalid/expired page token (410)
- Manual repair (clear checkpoint, re-sync)

A full reconcile lists all remote folders, downloads and compares every entity, queues local-only entities for upload, and saves a fresh page token.

---

## File Map

```
src/services/backup/
  types.ts        → BookBackup, ClipBackup, SessionBackup, SyncResult, SyncStatus
  auth.ts         → GoogleAuthService (OAuth sign-in, token management)
  drive.ts        → GoogleDriveService (REST wrapper + changes API + update-in-place)
  sync.ts         → BackupSyncService (pull, push, LWW reconcile, full reconcile)

  __tests__/
    sync.test.ts           → Tests for concurrency, reconciliation, push phase, fingerprinting
    drive.test.ts          → Tests for Drive folder creation
    harness.ts             → Scenario harness: FakeDrive + real DatabaseService on real SQLite
    sync_scenarios.test.ts → End-to-end sync scenarios (round trips, failures, per-device books)

src/actions/
  sync_now.ts             → Manual sync action
  auto_sync.ts            → Background sync action (checks settings)
  fetch_sync_state.ts     → Refresh pending count and last sync time

src/store/index.ts        → Wires sync events to store state
```
