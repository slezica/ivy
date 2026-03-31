# Sync Plan 1: Simplest Viable Incremental Protocol

## Goal

Replace Ivy's current full-state sync strategy with a simpler incremental protocol that:

- scales with recent change volume instead of total library size
- avoids full remote folder scans on every sync
- preserves deterministic conflict resolution
- stays small enough to implement and maintain without turning sync into its own research project

This plan intentionally does **not** introduce CRDTs, revision trees, or a large replicated remote index. It keeps the design centered on SQLite as the local source of truth, Google Drive as a slow but durable transport, and a small set of per-entity merge rules.

This plan also intentionally favors the smallest versioning surface that can work for Ivy. It uses `updated_at` as the primary per-entity version marker and keeps device identity only as a deterministic tie-breaker.

## Problem With Current Sync

Today sync works like this:

1. Process the local queue.
2. List all remote files in `books/`, `clips/`, and `sessions/`.
3. Download and parse all remote JSON metadata files.
4. Build a complete local + remote + manifest snapshot.
5. Run a planner.
6. Execute uploads, downloads, merges, and deletes.

This is conceptually clean, but it scales against the wrong variable. The cost of sync grows with the total number of remote objects, even if only one entity changed. It also repeats expensive Drive listing work inside queue processing and upload/delete execution.

The protocol in this document changes the scaling law:

- steady-state sync cost should be proportional to local pending changes plus remote changes since the last checkpoint
- not proportional to the total number of books, clips, and sessions in Drive

## Design Summary

The new protocol has four core pieces:

1. **Local entity rows**
   Books, clips, and sessions stay in SQLite and remain the authoritative local state.

2. **Outbox**
   Every local mutation appends or updates an outbox entry describing what needs to be pushed remotely.

3. **Drive changes checkpoint**
   Sync reads Drive's change feed from a saved page token instead of listing entire folders.

4. **Per-entity reconciliation**
   Sync compares local and remote versions entity-by-entity and applies deterministic merge rules immediately, without building a full global sync plan.

This is the smallest protocol that is both incremental and defensible.

## Non-Goals

This plan explicitly avoids:

- a full distributed lock across devices
- a rich replicated remote index or metadata journal
- generic CRDT infrastructure
- vector clocks or revision trees
- block-level sync for audio
- a pure whole-world planning phase

These may become appropriate later, but they are not required to make sync fast and correct enough for Ivy.

## Local Data Model Changes

Each synced entity should include:

- `updated_at: number`
- `updated_by: string` (device ID)

### Meaning

- `updated_at` is the primary version marker for sync comparison
- `updated_by` identifies the device that produced the current state

`updated_by` is not intended to establish causality. It is only a deterministic tie-breaker when timestamps alone are insufficient or ambiguous.

### New Sync Tables

Add or repurpose:

#### `sync_checkpoint`

- `id INTEGER PRIMARY KEY CHECK (id = 1)`
- `last_page_token TEXT`
- `last_full_reconcile_at INTEGER`

This stores the Drive changes cursor.

#### `sync_outbox`

- `id TEXT PRIMARY KEY`
- `entity_type TEXT NOT NULL`
- `entity_id TEXT NOT NULL`
- `operation TEXT NOT NULL`
- `updated_at_when_queued INTEGER NOT NULL`
- `queued_at INTEGER NOT NULL`
- `attempts INTEGER DEFAULT 0`
- `last_error TEXT`
- `UNIQUE(entity_type, entity_id)`

This replaces the current queue semantics with explicit stale-upload detection based on the entity timestamp that was current when the outbox entry was written.

#### Manifest Simplification

The current manifest can be reduced to transport metadata:

- `entity_type`
- `entity_id`
- `remote_file_id`
- `remote_audio_file_id`

It should no longer be treated as a complete snapshot of last-synced local and remote timestamps. The new protocol derives change discovery primarily from:

- local outbox state
- Drive changes since `last_page_token`
- direct comparison between local and remote entity payloads

## Remote Representation

Keep the current per-entity file layout:

- `book_<id>.json`
- `clip_<id>.json`
- `clip_<id>.m4a`
- `session_<id>.json`

Each JSON payload must include:

- `id`
- synced entity fields
- `updated_at`
- `updated_by`

## Drive Upload Strategy: Update In-Place

The current sync system uses a delete-then-create pattern for every upload, which means Drive file IDs change on every push. The new protocol should use Drive's update API (`PATCH /upload/drive/v3/files/{fileId}`) to modify files in place when a `remote_file_id` is already known.

Benefits:

- Stable file IDs across versions (manifest mappings don't churn)
- One request instead of list + delete + create
- Cleaner `changes.list` feed (one update event instead of a delete + create pair)

Create-new remains the path for entities with no known remote file ID (first upload). Update-in-place is the path for all subsequent pushes.

## Local Mutation Rules

Whenever a synced entity changes locally:

1. Update the SQLite row.
2. Set `updated_at = Date.now()`.
3. Set `device_id = deviceId`.
4. Upsert an outbox item for that entity.

The outbox item should store the entity's `updated_at_when_queued`.

That field matters for same-device concurrency: if an upload finishes for an older entity timestamp, but the local entity has already advanced, the upload must be treated as stale and the outbox entry must remain or be refreshed.

## Sync Loop

Only one sync run should execute at a time **per device**. This is a local mutex, not a distributed lock.

The sync loop is:

1. Acquire local sync mutex.
2. Read `last_page_token`.
3. Read Drive changes since that token.
4. Group changed Drive files by Ivy entity.
5. Reconcile remote-changed entities.
6. Process local outbox entities.
7. Persist the new page token.
8. Release local sync mutex.

This replaces the old full crawl + planner flow.

## Pull Phase: Drive Changes

The pull phase is driven by Drive's `changes.list` API.

### Validation Gate

Before implementation commits to this design, Ivy must verify in a focused spike that:

- `changes.list` behaves correctly with the app's OAuth scope
- the current `drive.file` scope is sufficient for all Ivy-created remote files
- page-token replay works reliably across app restarts and repeated sync runs

If this validation fails, the rest of this plan must be revised before implementation continues.

### Behavior

- If there is no saved page token, obtain a `startPageToken`.
- Read changes page by page until complete.
- For each changed file, decide whether it belongs to:
  - a book metadata object
  - a clip metadata object
  - a clip audio object
  - a session metadata object
- Group all changed files by Ivy entity ID.

For clips, metadata and audio changes may arrive separately. The sync loop should group them and reconcile the clip once the change batch has been collected.

### Important Rule

The page token must only be advanced after all remote changes in the batch have been successfully applied locally. Otherwise Ivy could permanently skip a change that was observed but not fully processed.

## Per-Entity Reconciliation

The core algorithm is local. For each remote-changed entity:

1. Fetch local entity, if any.
2. Download remote JSON metadata.
3. Compare local and remote versions.
4. Apply merge rule.
5. If the merged result differs from remote and should become authoritative remotely, upsert an outbox item.

There is no global planning stage. The comparison is direct. This removes the need to assemble a full world snapshot first, but it does not remove the underlying decision complexity of merge behavior itself.

## Version Comparison

The protocol uses a simple version model, not a causality-perfect one.

Useful cases:

### Case 1: Same logical version

If local and remote payloads carry the same `updated_at`, same `updated_by`, and equivalent synced fields, do nothing.

### Case 2: Remote is ahead

If remote clearly supersedes local, apply remote locally.

### Case 3: Local is ahead

If local clearly supersedes remote, keep local and ensure the outbox contains the entity.

### Case 4: Concurrent change

If both sides changed and neither obviously dominates, run the entity-specific merge function.

This protocol does not attempt to encode full ancestry. It uses:

- `updated_at`
- `updated_by`

as a practical comparison stack. That is less precise than vector clocks, but much simpler.

## Concurrency Model

There are two distinct concurrency problems.

### 1. Same-device concurrency

The user may edit an entity while sync is already processing it.

To handle this:

- use a local sync mutex so only one sync run exists at once
- before clearing an outbox item after upload, re-read the entity timestamp

If the upload completed for an older timestamp but the entity has since changed locally, the outbox must not be cleared as complete.

This makes in-flight uploads safely stale instead of dangerous.

### 2. Cross-device concurrency

Two different devices may edit the same entity without seeing each other's changes first.

There is no global lock on Drive. Cross-device concurrency is resolved by:

- version metadata on the entity
- deterministic per-entity merge rules
- eventual replay of remote changes via the Drive change feed

This is a convergence protocol, not a lock-based protocol.

## Merge Rules

The merge rules should stay explicit and domain-specific.

### Books

- `position`: take the max
- `hidden`: tombstone-like behavior; hidden wins unless restore is modeled as its own stronger operation
- `title`, `artist`, `artwork`, `speed`: last-writer-wins using `(updated_at, device_id)`
- `name`, `duration`, `file_size`, `fingerprint`: identity-derived fields, not user-merged

This preserves the two most important user behaviors:

- progress should never move backward
- user metadata edits should not be silently lost when another device simply listened further

### Clips

- `note`: last-writer-wins
- `transcription`: prefer non-null over null; if both non-null, use last-writer-wins
- `start`, `duration`, `source_id`: structural; newer definition wins
- audio: treat as immutable for the first version of this protocol

If clip structure changes in a way that implies new audio, the metadata update should point at the new audio blob. There is no need for block-level diffing.

### Sessions

Sessions become much easier if treated as append-mostly records.

- if two devices create different sessions, keep both
- if the same session row is updated concurrently, merge using:
  - `started_at = min(local, remote)`
  - `ended_at = max(local, remote)`
  - `updated_at = max(local, remote)`

If session behavior continues to be awkward, the longer-term simplification is to make sessions fully immutable and generate new rows instead of editing existing ones.

## Tie-Breaking

Ivy needs a deterministic total order for ambiguous cases.

Use:

1. later `updated_at` wins when one side is clearly newer
2. if still tied, lexicographically larger `updated_by` wins

That final rule is arbitrary, but convergence requires an arbitrary rule somewhere. All devices must make the same choice when faced with the same pair of states.

## Deletes

Deletion semantics should remain conservative in the first implementation.

- books keep the existing `hidden` behavior
- clips and sessions continue using the current delete-by-absence model for now

Explicit tombstones are a valid future improvement, but they should be deferred unless the new protocol exposes a concrete deletion bug that cannot be tolerated. The first implementation should focus on replacing full remote crawl with change-feed-driven discovery without simultaneously adding new lifecycle states for clips and sessions.

## Failure Semantics

The protocol must tolerate partial failure.

### Upload succeeds, cleanup fails

If a remote upload succeeded but the app crashed before clearing the outbox, the next sync should be safe to retry. Idempotence comes from comparing entity version metadata and re-uploading only when the current local row still requires it.

### Pull sees changes but crashes before applying all of them

Do not advance `last_page_token` until the change batch is fully applied. This ensures the same changes can be replayed safely.

### Clip audio upload succeeds but metadata upload fails

Treat the orphaned blob as acceptable for now. A later cleanup process can remove unused blobs. Correctness matters more than immediate remote neatness.

### Checkpoint corruption

Keep a rare full rebuild path:

- list remote folders
- rebuild file ID knowledge
- fetch current start page token

This is an operational escape hatch, not the normal sync path.

## Full Reconcile Triggers

The protocol needs explicit self-healing conditions.

Trigger a full reconcile when:

- the user manually requests sync repair or rebuild
- Drive returns an invalid or unusable page token
- the app detects a file ID mismatch or missing remote file in a state that should be impossible
- local sync metadata is corrupted or missing

Optional later addition:

- a low-frequency periodic reconcile, such as every 7 to 30 days

The initial implementation does not need scheduled full reconcile if manual repair and invalid-token recovery are solid.

## Cutover and Removal of Old Sync

The new protocol should not land as an in-place rewrite with no transition plan. Ivy already has:

- planner-based sync logic
- manifest entries with old timestamp semantics
- a queue built for the old execution model
- remote files that were produced by the old system

Those need an orderly migration path.

### Compatibility Goals

During rollout:

- existing remote JSON files must remain valid inputs
- existing queue items must not be dropped
- existing manifest file IDs should be reused when useful
- old timestamp-based manifest semantics must stop being authoritative

The key idea is to preserve transport continuity while replacing decision-making logic.

### Stage 1: Add New Schema Without Switching Behavior

Ship migrations that:

- add `updated_by` where needed for synced entities
- add `sync_checkpoint`
- add `updated_at_when_queued` to the queue or create `sync_outbox`
- keep current manifest rows in place

At this stage:

- old sync still runs
- new fields are populated for new writes where possible
- old reads remain valid for rows that do not yet have the new metadata

### Stage 2: Start Writing New Metadata Everywhere

Before the new sync loop becomes active, all sync-relevant local actions should:

- stamp `updated_at`
- stamp `updated_by`
- enqueue outbox-compatible entries

This ensures that once the new engine is enabled, locally modified entities already carry the metadata it needs.

### Stage 3: Introduce New Sync Engine Behind a Flag

Implement the new loop in parallel with the old one and gate it behind a feature flag or internal switch.

During this stage:

- old planner sync remains the default path
- new sync can be exercised in development and on controlled installs
- logs should explicitly identify which engine ran

The goal is to validate:

- Drive changes checkpointing
- per-entity reconciliation behavior
- outbox stale-upload handling
- compatibility with old remote JSON files
- `changes.list` behavior with Ivy's OAuth scope

### Stage 4: Migrate Existing Queue State

Existing `sync_queue` items must be migrated cleanly.

Recommended approach:

- if `sync_queue` is adapted in place, backfill `updated_at_when_queued` from the entity's current `updated_at`
- if `sync_outbox` is a new table, copy pending queue rows into it during migration
- preserve `attempts` and `last_error`

Important limitation:

- old queue items do not carry historical version intent
- they can only be interpreted as "upload or delete the current local state of this entity"

That is acceptable because the current system already behaves that way in practice.

### Stage 5: Demote Old Manifest Semantics

The old manifest currently stores:

- `local_updated_at`
- `remote_updated_at`
- remote file IDs

Under the new protocol:

- remote file IDs remain useful
- timestamp comparison semantics must stop driving sync decisions

This means:

- no new code should rely on `local_updated_at > manifest.local_updated_at`
- no new code should rely on `remote_updated_at > manifest.remote_updated_at`
- manifest rows should gradually become transport metadata only

This is the critical conceptual removal. The manifest may survive temporarily, but its old meaning should not.

### Stage 6: Switch Entry Points

Once the new engine is validated:

- `syncNow()` and `autoSync()` should call the new sync loop
- the old planner path should no longer run in production

At this point the old engine should be considered dead code unless explicitly retained for rollback.

### Stage 7: Remove Planner-Based Logic

After the new engine has been stable for a release window, delete:

- `gatherSyncState()` full-remote snapshot building
- full remote JSON crawl/parsing as the normal sync path
- planner-driven orchestration
- manifest timestamp comparison logic

Likely removals include:

- `planSync()` usage in sync orchestration
- remote parse helpers that assume full folder listings are the main source of truth
- queue processing paths that repeatedly call `listFiles()` to rediscover remote state

Pure merge helpers may remain if still useful to the per-entity reconciler.

### Stage 8: Database Cleanup

Only after the new engine has proven stable should the database be simplified.

Potential cleanup migration:

- remove obsolete manifest timestamp columns if they are no longer read
- rename `sync_queue` to `sync_outbox` if a temporary compatibility path was used
- remove dead status or compatibility columns introduced only for transition

This should happen later than the code cutover so rollback remains possible during the first release window.

### Rollback Plan

If the new engine misbehaves:

- disable the feature flag
- fall back to the old planner path temporarily
- preserve newly written `updated_at` and `updated_by` fields
- do not delete queue/outbox rows during rollback

Because remote files remain per-entity JSON objects in both designs, rollback should be operationally possible as long as old code is still present.

### Definition of Done for Old System Removal

The old system is not fully removed until all of the following are true:

- `syncNow()` and `autoSync()` no longer invoke planner-based sync
- no production code performs full remote folder crawl as the primary sync strategy
- manifest timestamps are no longer used to decide uploads/downloads/merges
- queue/outbox behavior is owned solely by the new protocol
- recovery paths are explicit and separate from the normal sync flow

Until then, Ivy is in transition and should be treated as such.

## Why This Is Simpler Than The Larger Redesign

This protocol is intentionally smaller because it removes:

- the full-world sync planner
- the need to construct complete remote state before acting
- the need for a rich replicated remote index
- the need for advanced distributed version structures

It keeps only the minimum pieces needed for an efficient eventually-consistent sync system:

- local outbox
- Drive change cursor
- entity version metadata
- deterministic merge rules
- local mutex

## Implementation Plan

### Phase 1: Schema

- add `updated_by` to books, clips, and sessions
- add `sync_checkpoint`
- replace or adapt `sync_queue` into `sync_outbox`
- add `updated_at_when_queued` to the outbox shape
- simplify manifest usage to remote file ID storage

### Phase 2: Local Mutation Path

- update every sync-relevant action to stamp `updated_at`
- stamp `updated_by`
- enqueue outbox entries with `updated_at_when_queued`

### Phase 3: Drive Changes Integration

- add Drive changes client methods
- store and update `last_page_token`
- parse changed files into entity groups

### Phase 4: Reconciliation Engine

- implement per-entity comparison helpers
- implement merge functions with explicit tests
- replace planner-driven sync with reconcile-on-sight flow

### Phase 5: Delete Semantics

- keep clip/session delete behavior unchanged in the first implementation
- add optional background cleanup for old remote files

### Phase 6: Migration and Safety

- support entities missing `updated_by` by defaulting old records
- add a recovery path to rebuild checkpoint state
- add integration tests for same-device and cross-device concurrency

## Tests Required

At minimum, add tests for:

- remote change replay updates only changed entities
- outbox items are not cleared when local `updated_at` advances during upload
- two devices concurrently updating book position converge to max position
- metadata edit plus progress update on different devices preserves both
- concurrent clip note edits converge deterministically using last-writer-wins by explicit product choice
- session concurrent updates merge intervals correctly
- page token is not advanced on partial pull failure
- full reconcile triggers on invalid page token

## Recommendation

This should be the replacement direction for Ivy sync.

It is meaningfully simpler than a full replication protocol redesign, but materially better than the current crawl-and-plan architecture. Most importantly, it changes Ivy's sync cost from "pay for the whole remote world every time" to "pay for what changed."
