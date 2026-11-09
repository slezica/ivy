# Artwork as files

**Status:** implemented (branch artwork-files). Follows the
upgrade-scenarios rework ([2026-09-28-upgrade-scenarios.md](2026-09-28-upgrade-scenarios.md));
`libraryWithCovers` is its first real scenario.

## Problem

Book covers are stored as base64 data URIs in `files.artwork`. That has now
caused two incidents:

- **OOM** (2026-09-02, [artwork-oom-repair](2026-09-02-artwork-oom-repair.md)):
  uncapped covers multiplied across DB, store and bridge copies.
- **SystemUI crash** (2026-09-28, [systemui-artwork-crash](2026-09-28-systemui-artwork-crash.md)):
  the data URI went into media-session metadata. The fix
  ([media-session-artwork-files](2026-09-28-media-session-artwork-files.md))
  writes a cache file on each play, a workaround for not having a file.

Structural costs, beyond the incidents:

- Every book's cover lives in the Zustand store as a JS string, whether shown
  or not. The estimate from backup JSON sizes is ~60KB per book, ~10MB for
  100 books. Not catastrophic, but display data in the state layer is the
  wrong layer.
- File-needing APIs (media session, sharing) need conversion.
- `<Image>` decodes data URIs from the string instead of using the native
  image cache.

The original reasons for storing covers in the DB were easier sync and
atomicity (one row = the whole book).

## Decision: files locally, wire format unchanged (option B)

- Covers live at `<documents>/artwork/<bookId>.<hash4>.<ext>`:
  - `hash4`: first 4 hex chars of `fnv1a` over the content. Busts the
    `<Image>` URI cache when a cover changes. A collision means a stale
    display, 1-in-65,536 per change of the same book.
  - `ext`: from the image's real type (JPEG from extraction, PNG from demo
    seeds).
- The DB holds the path, not the image.
- The store holds the path. `<Image>` loads covers on demand from the native
  cache.
- The media session uses the file directly. `services/audio/artwork.ts` (the
  cache workaround) is removed.
- **The sync wire format is unchanged.** Book JSON still embeds the cover as
  base64:
  - push: `uploadBook` reads the file and embeds it (it already reads from
    the DB, not the store)
  - pull: decodes to a file, then updates the row
  Atomicity is kept, and mixed-version devices keep working.

### Write order

New file → update row → remove old file. A crash between steps leaves an
orphan file (swept) or a row pointing at a missing file (treated as "no
cover"). Both are easy to detect.

### Duplicate-book merge (sync)

The cover follows the surviving id. The winner's JSON carries its cover, so
the merge writes the file under the winner's id from that payload.

## Rejected alternatives

- **A — covers as separate Drive files** (like clips' JSON + audio). Would let
  you browse covers in Drive. Costs: a two-file sync protocol, a transition
  period for mixed-version devices, twice the Drive requests. B is the local
  half of A, so A remains possible later.
- **C — keep covers in the DB, load lazily per row** (`useArtwork(id)` + LRU).
  Fixes memory only. File APIs still need conversion, and every cover gets an
  async loading state.
- **ContentProvider serving covers from the DB** (no files at all). This is
  exactly what providers exist for. But native code would read SQLite
  directly (schema coupling, a second DB client). It must not depend on JS,
  which may not be running when the provider is called. And it's Kotlin, so
  no jest. The RN layer makes it the harder path.

## Change surface

- Writers:
  - `load_file.ts` (import/restore)
  - `metadata.ts`/`AudioMetadataModule.kt` (extraction + downscale)
  - `ffmetadata.ts`
  - `seed_demo_data.ts` (screenshots pipeline)
  - `sync.ts` pull
- Readers:
  - `BookItem`, `BookDetails`, `MetadataEditor`, `SessionItem` (via `track_session.ts`)
  - `player.ts`
  - `sync.ts` push
- Tooling:
  - `bin/ivy.ts` artwork-cap check
  - upgrade scenarios
- `clearAllData()` must also wipe the artwork directory.

## Migration

A new migration extracts existing data URIs to files, one row at a time
(memory-lean) and idempotently (skip rows already holding a path), then
clears the base64.

- **Sync semantics:** per-device normalization. No `updated_at` bump, nothing
  queued, since the wire format is unchanged.
- **Rollback:** Play never downgrades (versionCode must increase), so clearing
  the column in the same migration is safe. Only a manual sideload downgrade
  would lose covers.

## Settled (2026-11-09)

- **Column:** new `artwork_file` holds the **filename only**
  (`<id>.<hash4>.<ext>`). The full path is built at runtime from the artwork
  dir, because app storage paths can differ across installs and users. The
  migration clears the old `artwork` column. `Book.artwork` leaves the type,
  so tsc flags every consumer.
- **Push with a missing file:** send `artwork: null`. Local truth is "no
  cover". It's rare (local corruption), and old versions read a missing field
  as null anyway.

## Testing plan

- **Feature (jest):**
  - `ArtworkStore` (in-memory RNFS):
    - naming
    - temp file + rename
    - replace = new → row → remove old
    - `sweep(referenced)`
    - read back as base64
  - Writers:
    - `load_file` import/restore (existing cover wins)
    - re-extraction
    - `seed_demo_data`
  - Sync (FakeDrive harness):
    - push embeds base64; missing file → null
    - pull writes file then row
    - changed cover replaces the file, removes the old one
    - duplicate merge: cover follows the winner
    - old-format JSON works
  - Player uses the book's file. `services/audio/artwork.ts` and its tests
    are deleted.
  - `clearAllData()` wipes the artwork dir.
- **Migration:**
  - Jest prefix-replay: `dbAtVersion(13)` with JPEG, PNG, null and malformed
    covers. Checks: files with exact bytes, `artwork_file` set, old column
    cleared, no `updated_at` bump, nothing queued.
  - Idempotence: crash after the file write, before the row update; rerun
    converges.
  - Upgrade scenario `libraryWithCovers` (`migrations: [14]`), seeded by
    v1.6.4/5/6. Verifies: file exists with exact size, column set, base64
    cleared, nothing queued. `DATA_TRANSFORMING` gets 14.
- **Regression catchers:**
  - types: `Book.artwork` removed
  - jest: books loaded from the DB carry no `data:` strings
  - `artwork-cap.yaml` + bridge `check/artwork-cap` check the file on disk
  - the media-session large-reply check stays
  - screenshots for visual review
- **Iteration:**
  - jest prefix-replay (seconds)
  - `test --upgrade --from v1.6.6` (~2–3 min, fresh state every run)
  - emulator snapshots for manual retries (toolkit RECIPE)
  - demo library rehearsal (`device put --samples` on v1.6.6, then upgrade)
  - final check: the S25 through alpha

## Roadmap

1. **Storage**
   1. `ArtworkStore` service + tests (`services/storage/artwork.ts`)
   2. Migration 14: add `artwork_file`, extract, clear `artwork` + jest
      prefix-replay + idempotence case
   3. DB layer: `Book.artwork_file`, `Book.artwork` removed,
      `clearAllData()` wipes the dir, a `data:`-free guard test
2. **Writers and readers**
   1. Import/restore + extraction write through `ArtworkStore`
   2. UI readers (`BookItem`, `BookDetails`, `MetadataEditor`,
      `SessionItem`) use a `artworkUri(book)` helper
   3. Player uses the file; the cache module is removed
   4. `seed_demo_data` + the screenshots pipeline
3. **Sync**
   1. Push: file → base64 (missing → null)
   2. Pull: base64 → file → row → remove old; duplicate merge
   3. FakeDrive scenarios
4. **Device verification**
   1. Upgrade scenario `libraryWithCovers` + `DATA_TRANSFORMING`
   2. `artwork-cap` bridge check on files
   3. Full e2e + `test --upgrade --all` + screenshots review
5. **Docs:** BOOKS.md, SYNC.md, PLAYBACK.md, CLAUDE.md schema/tree,
   MIGRATIONS.md worked examples.

## Implementation notes

Decisions made during implementation that the plan above didn't settle:

- `ArtworkStore.readDataUri` instead of `readBase64`: push needs the full wire data URI.
- Malformed = not `data:image/<w>;base64,<b64>` (line breaks allowed in the payload) → dropped as no cover (migration, pull, import).
- Migration 14 throws on filesystem errors (reruns next launch) and guards its ADD COLUMN via `PRAGMA table_info`.
- `db.setBookArtworkFile` never bumps `updated_at`/`updated_by`; callers own sync semantics.
- Cover write failure on import = book imported without a cover.
- Player drops any non-`file://` artwork rather than converting it.
- UI/player helper is `artworkUri(filename)` (takes `artwork_file`, not the book).
- Startup repair (rows pointing at missing files → NULL) + sweep (unreferenced files) run before hydration. No race with sync: pull is UI-triggered only, and the UI renders after `initialized`.
- Duplicate merge: the cover follows the surviving id whichever side LWW picks; a kept local cover is re-homed (`rehomeCover`), also on the `merged_into` adopt path.
- Book tombstones that delete a row remove its cover file immediately (not left for the sweep).
- `Book.artwork` removed from the type; the legacy `artwork` column stays, always NULL (writers set it NULL).
- `clearAllData()` doesn't touch files; its only caller (`seedDemoData`) calls `artworkStore.clear()` alongside it.
- Old `Caches/artwork/` files from the removed media-session cache module are left for the OS to clear.

## Still open

- Hidden books' cover files accumulate (IDEAS.md, quality of life). Not in
  scope.
