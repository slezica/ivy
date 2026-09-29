# Artwork as files

**Status:** decided, not implemented. Implementation follows the
upgrade-scenarios rework ([2026-09-28-upgrade-scenarios.md](2026-09-28-upgrade-scenarios.md)),
whose first real scenario it will be.

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

## Open questions

- A push when the local cover file is missing: send the JSON without a cover,
  and does that null the remote cover or leave it? Needs a rule.
- Column: reuse `artwork` for the path, or add `artwork_path` and drop
  `artwork` later?
- Testing plan: to be discussed after the upgrade-scenarios rework lands.
