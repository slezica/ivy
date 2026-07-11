# Sync redesign: deletion semantics, identity, and reliability

**Status:** implemented (2026-07-11, commits `3a1847e..c85af5f` on `remove-ytdlp`)
**Date:** 2026-07-11
**Context:** the 2026-07-10 bug hunt ([2026-07-10-BUGS.md](2026-07-10-BUGS.md)) found that the sync engine's remaining High/Medium bugs (H2, H4, H5, M5, M7–M9) share one root: the design never specified deletion semantics, cross-device identity, or failure policy. This doc fixes the design, then the code.

## Decisions (agreed 2026-07-11)

1. **Books are per-device; clips and sessions are global.**
   - Book *presence* (audio on disk) was always per-device — audio never syncs. This extends the model to *deletion*: `hidden` becomes a *local-only field*, excluded from the synced payload. Deleting or archiving a book affects only the device you do it on. The remote JSON is the shared cloud library; a new device bootstraps all of it (as audio-less entries).
   - Clip and session deletion *propagates* via tombstones: deleting a clip on one device deletes it everywhere.
   - Rationale: books are heavy local files legitimately managed per-device (small phone vs. travel tablet); clips/sessions are small shared data where "I deleted it" means "I'm done with it."

2. **Clips have independent lifespans.** Already mostly true (own audio file, own sync entities, `delete_book` doesn't touch them, soft-deleted books keep satisfying the join). This doc makes it structural (see LEFT JOIN below) and makes the sync layer honor it (tombstones only on *individual* clip deletion).

3. **Book identity merges by fingerprint.** Same audiobook imported independently on two devices (two UUIDs) is one book: on fingerprint match, the local device adopts the *remote* id, re-keys its local rows, and retires its own remote copy.

4. **Sync failures retry forever and stay visible.** No more silent 3-strikes abandonment: exponential backoff, failing items counted and surfaced in Settings.

## Design

### D1. Tombstones (clips & sessions)

A deletion rewrites the entity's JSON in place as a tombstone instead of deleting the Drive file. **The tombstone is the full last-known payload plus `deleted: true`** — not a minimal stub:

```json
{ "id": "…", "source_id": "…", "start": …, "…": "…", "deleted": true, "updated_at": 1760000000000, "updated_by": "device-…" }
```

Full-payload tombstones cost nothing (a few KB) and buy graceful degradation everywhere a stub would crash: old-code devices apply them as a harmless live edit (no parse crash on missing NOT NULL fields, no frozen sync token — the clip merely lingers on stale devices); fresh-device bootstraps and full reconciles can parse them uniformly and branch on `deleted` alone.

- **Transport-compatible (verified against `drive.ts:237`):** it's a normal `updateFile` on the existing file id — flows through the change feed with full metadata, so the "removed changes carry no filename" problem (H2) never arises. The manifest entry stays valid.
- **Applying (incremental):** reconcile parses the JSON and branches on `deleted` **before** any audio handling or `restore*FromBackup` call. If the tombstone's `updated_at` wins LWW, delete the local row + local audio file, null the manifest's `remote_audio_file_id`, emit the store notification. If a local edit is newer, the edit wins and re-uploads (un-deleting — acceptable LWW semantics).
- **Applying (full reconcile):** the current clip loop has `if (!json || !audio) continue` (`sync.ts:837`) — after D1 a tombstoned clip is exactly a JSON-with-no-audio pair, so **the loop must be restructured**: parse the JSON first, branch on `deleted` (apply LWW deletion), and only require the audio file for live clips. The session loop needs the same `deleted` branch before `restoreSessionFromBackup`.
- **`queueLocalOnlyEntities` needs no tombstone check** (verified): tombstone JSONs keep their filename, so the entity id lands in the remote-id set and re-upload is already suppressed. The resurrection fix falls out of the file continuing to exist.
- **Clip audio:** the tombstone updates the JSON file; the separate audio file *is* deleted remotely (reclaim space), and the pusher nulls `remote_audio_file_id` in its manifest row (the id is dead). A device pulling the audio-file removal ignores it (grouping already skips nameless removals, `sync.ts:260-262`).
- **Retention:** keep forever. (Optional future compaction: drop tombstones older than N months.)
- **Local delete flow:** `delete_clip` keeps deleting the local row immediately (optimistic) and queues `operation: 'delete'` — the payload for the tombstone is captured at queue time (the row is gone by push time). `pushOutbox`'s delete path changes from `drive.deleteFile(json)` to `drive.updateFile(json, tombstone)` + `drive.deleteFile(audio)` + manifest audio-id null. If no manifest entry exists (never uploaded), there is nothing to tombstone — drop the queue item.
- **Stale-tombstone guard:** before pushing a tombstone, read the remote JSON; three cases: remote `updated_at` newer → skip push, drop the queue item (the edit won); remote is already a tombstone → drop the queue item (done); read 404s (user purged Drive) → nothing to tombstone, drop the queue item and the manifest entry.
- Sessions: same mechanism, minus the audio file.

### D2. Local-only `hidden` (books)

- Remove `hidden` from `BookBackup`. Old remote JSONs still contain it; readers ignore the field.
- `restoreBookFromBackup`: the `ON CONFLICT` update list drops `hidden` (local value survives); fresh inserts default to `hidden = 0`.
- `delete_book` / `archive_book` **stop queueing sync upserts AND stop bumping `updated_at`/`updated_by`** (`hideBook` at `database.ts:428-434`, `archiveBook` at `:474-480`). Merely not queueing is insufficient: the local-ahead branches in `reconcileBook` (`sync.ts:342`) and `fullReconcile` (`:811-819`) re-queue an upsert whenever local `updated_at` exceeds remote — so an archive-time bump would ship anyway and could revert another device's real edit (archive at 12:00 beats a title edit at 11:55, uploading pre-edit fields). If the library UI needs "recently archived" ordering, add a local-only, non-synced column later; do not reuse `updated_at`.
- Restore-by-re-add: `load_file`'s fingerprint-match path must clear local `hidden` (today's `handleDuplicate` only `touchBook`s — with local-only hidden the impossible `hidden=1 + uri` state can no longer arrive via sync, but a *locally* deleted book re-added takes the restore branch since its `uri` is NULL; verify `restoreBook` sets `hidden = 0`, add if missing).
- **Consequence to document loudly in SYNC.md:** new devices bootstrap every book ever added, as audio-less entries. If this becomes noise, a future explicit "remove from cloud" action tombstones the book JSON (mechanism from D1); not in scope now.
- H5 is thereby *deleted, not fixed*: no sync-applied `hidden` means no `hidden=1 + live uri` state, no leaked audio, no cemented deletion.

### D3. Identity merge by fingerprint (books)

**Primary rule: the merge target is the lexicographically smaller UUID** — deterministic, no coordination, symmetric. When reconcile pulls a remote book whose `(file_size, fingerprint)` matches a local book with a different id:

- **If the remote id is smaller** (we hold the larger, losing id), this device performs the merge:
  1. In one **exclusive** SQLite transaction (`withExclusiveTransactionAsync` — the fire-and-forget writers `updateBookPosition`/`updateSessionEndedAt` can interleave into a plain async transaction): re-key `files.id`, `clips.source_id`, `sessions.book_id` from localId → remoteId, and apply the remote book's metadata via normal LWW.
  2. **Manifest: delete + insert, never rename.** The `('book', localId)` row's `remote_file_id` points at `book_{localId}.json` — renaming the row would make future uploads write remoteId content into a localId-named file, which other devices group by *filename* (`parseFilename`, `sync.ts:961-970`) and misapply. Instead: delete the `('book', localId)` manifest row, insert `('book', remoteId)` pointing at `book_{remoteId}.json`'s file id (in hand from the triggering reconcile). Re-key `sync_queue` rows with an explicit ON CONFLICT merge (keep the newest `updated_at_when_queued`) — a blind UPDATE collides with the UNIQUE constraint if a remoteId row already exists.
  3. **Retire our old remote copy**: write a *book tombstone* (D1 full-payload form) into `book_{localId}.json` carrying **`merged_into: remoteId`**, then drop local references to it.
  4. Queue an upsert of the merged book so our fields (position, speed, metadata edits) compete under LWW on the surviving id.
  5. **Re-upload re-keyed children**: bump `updated_at` and queue upserts for every re-keyed clip and session — third devices only learn the new `source_id` through ordinary LWW updates; without this, their clips keep pointing at a book id that no longer exists anywhere (visible thanks to the LEFT JOIN, but "go to source" and bounds-editing permanently broken). *Accepted cost:* the mass-bump can clobber a concurrent clip edit from another device (rare, LWW-consistent).
- **If the remote id is larger** (we hold the smaller, winning id): skip the download (as today, `sync.ts:451-454`) and record nothing. Convergence comes from the other device's merge — its re-keyed children and book upsert arrive as normal changes.

**Book tombstone semantics (pull side):** a book JSON with `deleted: true` and `merged_into` → delete the local row for that id if present and re-key its children to `merged_into` (a device that bootstrapped the retired id heals). A plain book tombstone without `merged_into` (M9 twin cleanup) → delete the local row only if `uri IS NULL` (metadata-only duplicate; never destroy local audio — D2's no-deletion-propagation rule stands). All readers — `downloadBook`, `fullReconcile`, bootstrap — must branch on `deleted` before touching payload fields like `fingerprint`.

Clips/sessions previously downloaded under the winning id (today's invisible orphans, M8) become visible automatically once the local book row carries that id; a one-time `UPDATE clips SET source_id = :newId WHERE source_id = :oldId` on the merging device reattaches any pre-existing orphans.

### D4. Outbox: retry forever, surface failures

**Push side:**
- Drop the `attempts < 3` filters. Add `next_attempt_at INTEGER` to `sync_queue`; on failure set `next_attempt_at = now + min(2^attempts × 30s, 6h)` and increment `attempts`. `getOutboxItems` takes `WHERE next_attempt_at <= now`.
- `getQueueCount` counts everything pending; a second count (`attempts >= 3`) feeds a distinct Settings line: *"N changes failing — will keep retrying"* with the last error on tap. `sync.pendingCount`/state gains a `failingCount`.
- A successful push resets `attempts`. `queueChange`'s upsert already resets attempts on re-queue — keep.
- **`updateOutboxItemAttempt` becomes conditional on `updated_at_when_queued = ?`**, symmetric with the conditional `removeOutboxItem`: a push failure for an old version must not stamp hours of backoff onto a row that was re-queued fresh mid-flight.

**Pull side (poison-pill quarantine):** the token-advance-on-zero-errors fix means one *deterministically* failing entity (corrupt JSON, dead audio id) would freeze the page token forever — no remote change of any kind applied again, silently. Mirror the push policy: track per-entity consecutive reconcile failures (in-memory or a small table); after N (=5) consecutive failures, **quarantine** the entity — its failure no longer blocks token advance, it goes on a retry list (attempted each sync) and counts into `failingCount` in Settings. Transient-error retry semantics are preserved for everything below the threshold — the design *relies* on short-term blocking (e.g. JSON-before-audio windows heal via retry), so the threshold must not be 1.

### D5. Reliability fixes riding along (from the bug report)

- **H4 — 404 fallback at four sites:** `uploadBook` JSON, `uploadClip` JSON, `uploadClip` **audio** (`sync.ts:679` — easy to miss, it's a second `updateFile` inside the same function), `uploadSession` JSON. On 404, invalidate **only the dead id** (for clip audio: null `remote_audio_file_id`, keep the JSON id) and fall through to `uploadFile` (create new). With D1, 404s become rare but Drive-side surprises (user cleanup, trash purge) stay recoverable.
- **M5 — audio versioning in the manifest.** The originally-proposed "re-download the JSON on audio-only changes" does **not** fix M5: uploads are update-in-place, so the audio *file id never changes*, and a device that already applied the JSON short-circuits on `isSameVersion` (`sync.ts:377-378`) — stale audio becomes permanent. Fix: store the audio file's Drive version (`md5Checksum`, or `modifiedTime`) in a new manifest column `remote_audio_version`; whenever a grouped change contains an audio file whose version differs from the manifest's, download the audio **regardless of the JSON LWW outcome**. This also gives resurrection healing a receiving side: when the audio holder re-uploads (create-new after 404 fallback), receivers see a version mismatch and fetch.
- **M9 — bootstrap gating:** if pull-phase init fails (`getStartPageToken`/`fullReconcile` throws), **skip the push phase** for that sync run. Also: write the manifest entry *before* declaring an upload complete is not possible atomically — instead make `reconcile*`'s duplicate handling deterministic (prefer the manifest's file id when present; else lexicographically smallest file id) so accidental twins converge instead of flapping. Twins get cleaned by tombstoning the loser when detected during reconcile.
- **L7 — trashed files:** request `trashed` in the changes feed fields and treat `trashed: true` like `removed` (with D1, both are no-ops for JSONs; audio-file trash is ignored by grouping). **Known limit:** trashing the whole `Ivy/` folder emits no per-child feed entries — children stay "live" until individually touched. Recovery for that gesture is the full reconcile (whose `listFiles` already filters trashed): it sees an empty remote and re-uploads everything as local-only. That *is* the desired recovery; documented so nobody expects the feed to catch it.
- **L9 — folder race:** after `findOrCreateFolder` creates, re-query; if multiple same-name folders exist, deterministically adopt the oldest (`createdTime`) everywhere. Don't attempt Drive-side cleanup.
- **L8 — base64 perf:** replace the char-by-char `uint8ArrayToBase64`/`atob` loops with chunked conversion (e.g. `String.fromCharCode.apply` over 8KB chunks, or `Buffer` if available via RN polyfill). Mechanical, contained to `sync.ts` helpers.
- **Clip visibility hardening:** `getAllClips` (and the sessions query) switch `INNER JOIN files` → `LEFT JOIN`, so a clip whose book JSON hasn't arrived yet (fresh-device ordering) is visible immediately via its own audio, and clip independence stops depending on the soft-delete implementation detail. **This makes `ClipWithFile.file_name/file_duration` and `SessionWithBook` book fields nullable** — a type change that ripples into ClipsListScreen, SessionsScreen, and the timeline's bounds math (`file_duration`); handle nulls explicitly in that step, not incidentally.
- **Clip audio healing (T3 resurrection):** there is no reconcile-side probe — the actual healer is the *push* path: the un-deleting device's upsert re-uploads audio unconditionally (`uploadClip` always uploads audio), the 404 fallback creates a new audio file, and receivers converge via the M5 audio-version mechanism above.

### Out of scope (unchanged)

Whole-entity LWW with wall-clock timestamps and `updated_by` tiebreak; book audio never syncing; per-entity (not per-field) conflict resolution — all stay as designed. M10 (cleanup TOCTOU) and M13 (rollback gaps) are storage-layer issues tracked separately in the bug report.

## Schema changes

- `sync_queue`: `ALTER TABLE ADD COLUMN next_attempt_at INTEGER DEFAULT 0` (follows the existing migration pattern; M6 postponed).
- `sync_manifest`: `ALTER TABLE ADD COLUMN remote_audio_version TEXT` (M5 audio versioning).
- No changes to `files`/`clips`/`sessions`. `ClipBackup`/`SessionBackup` gain optional `deleted?: boolean`; `BookBackup` gains optional `deleted?: boolean` + `merged_into?: string` (D3 retirement) and drops `hidden`.

## Cross-version compatibility (beta caveat — write into SYNC.md)

**Upgrade all devices before the first post-upgrade delete.** Specifically: (a) Phase 1 — new-code uploads omit `hidden`, but *old-code* `restoreBookFromBackup` still applies `remote.hidden ?? false` in its ON CONFLICT, so any upsert from an upgraded device un-deletes hidden books on a not-yet-upgraded device; (b) Phase 2 — full-payload tombstones degrade gracefully on old code (applied as a live edit; the clip lingers but nothing crashes or freezes), yet the *audio* hard-delete makes old-code `downloadClip` 404 → with old code's 3-strikes that entity is abandoned, acceptable; (c) **Phase 2 is a one-way data-format door**: once tombstones exist in Drive, reverting a device to pre-tombstone code re-exposes it to (b). With one beta user this is a footnote; before any multi-user release it becomes a version gate in the payloads.

## Implementation plan

Phased so each lands green and independently revertible. Commit style per CLAUDE.md.

**Phase 0 — test harness (prerequisite):**
1. `qa: add real-sqlite outbox test harness` — in-memory better-sqlite3 (or expo-sqlite test adapter) exercising the *actual* `sync_queue`/`sync_manifest` DDL, so UNIQUE-upsert semantics and the new backoff/count queries are tested against real constraints. The 2026-07-10 hunt showed the fully-mocked DB hides exactly this class of bug.
2. `qa: sync engine scenario fixtures` — helper to run `BackupSyncService` against a scripted fake Drive (feed pages, 404s, trashed flags) + the real-sqlite DB.

**Phase 1 — books local-only hidden (smallest, deletes H5):**
1. `sync: drop hidden from book backup payload`
2. `db: preserve local hidden when applying remote books`
3. `library: stop bumping updated_at on archive and delete` (and stop queueing — see D2; the bump ships via local-ahead re-queue otherwise)
4. `library: clear hidden when restoring book by re-add`
5. `docs: sync semantics — books are per-device` (SYNC.md + BOOKS.md)

**Phase 2 — tombstones (fixes H2, enables D3/D5):**
1. `sync: write full-payload tombstones instead of deleting remote files` (capture payload at queue time; stale-tombstone guard incl. 404/already-tombstoned cases)
2. `sync: apply remote tombstones on incremental reconcile` (branch on deleted before audio/restore calls; null manifest audio id)
3. `sync: apply tombstones in full reconcile` (restructure the `!json || !audio` clip loop; session loop deleted-branch)
4. `docs: tombstone lifecycle in SYNC.md`

**Phase 3 — outbox & pull reliability (fixes M7, H4, poison pill):**
1. `db: add next_attempt_at backoff to sync queue`
2. `sync: retry failed pushes forever with backoff` (conditional `updateOutboxItemAttempt`)
3. `sync: fall back to create on remote 404` (four sites; per-id invalidation)
4. `sync: quarantine entities that fail reconcile repeatedly` (pull-side poison-pill policy, N=5)
5. `settings: surface failing sync items` (push `failingCount` + pull quarantine list)

**Phase 4 — identity merge (fixes M8):**
1. `db: exclusive transactional book re-key helper` (manifest delete+insert, queue ON CONFLICT merge)
2. `sync: merge fingerprint-matched books toward smaller id`
3. `sync: retire superseded remote copy with merged_into tombstone`
4. `sync: apply book tombstones on pull` (merged_into re-key; plain tombstone delete-if-no-uri)
5. `sync: re-upload re-keyed clips and sessions after merge`
6. `db: reattach orphaned clips after merge`

**Phase 5 — hardening (M5, M9, L7, L8, L9, joins):**
1. `db: add remote_audio_version to sync manifest`
2. `sync: download clip audio on version mismatch` (the actual M5 fix)
3. `sync: skip push phase when pull bootstrap fails`
4. `sync: deterministic duplicate remote file resolution`
5. `sync: ignore trashed files in change feed`
6. `sync: chunked base64 conversion`
7. `drive: adopt oldest folder on duplicate trees`
8. `db: left-join clips and sessions to files` (nullable joined fields — update types + UI null handling in the same commit)

## Testing

- Phase 0 harness runs every phase's scenarios: delete-propagation round trip, tombstone LWW (edit-after-delete both orders), double-import merge (including simultaneous), 404 recovery, backoff schedule, bootstrap-failure gating, audio-only change healing, trashed-file feed entries.
- Manual two-device checklist appended to SYNC.md after Phase 2 and Phase 4 (the only parts with cross-device state machines that unit scenarios approximate).

## Open questions

1. **Tombstone compaction** — keep forever (default) or GC after N months? Affects nothing until libraries get large. Default: keep.
2. **"Remove from cloud" for books** — wanted eventually? D1 gives us the mechanism for free; UI/action is a separate small feature.
3. ~~**M6 (transactional migrations)** before Phase 3's migration?~~ **Postponed** (2026-07-11): single beta user, nuking the DB is acceptable. Phase 3's migration follows the existing pattern.

## Known costs (accepted)

- New devices bootstrap the full cloud library, including books deleted locally elsewhere (audio-less entries in Archived). Revisit with "remove from cloud" if it becomes noise.
- Un-delete on conflict: an offline edit newer than a tombstone resurrects the clip. Consistent with LWW; rare; arguably correct.
- Tombstoned clips' audio is gone — un-delete restores the row but not the audio until the heal rule (D5) re-uploads it from the device that kept it, or the source book is present to re-slice.
- **Automatic mutations can defeat deletions (timeline T7):** if a background transcription completes on device B inside the window before B pulls A's tombstone, the transcription write is a fresh edit that wins LWW and resurrects the deleted clip — with no human intent behind it. Narrow window (transcription completes seconds after clip creation), accepted for now; the transcription write path goes through `updateClip`, so a tombstone-awareness check has a single choke point if this ever bites.
