# Artwork OOM: downscale + repair migration

## Problem

Production crashes starting ~2026-08-30 on the developer's device, same app version
(1.6.2) that had been stable. Diagnosed from device forensics (`dumpsys activity
exit-info`, dropbox, logcat crash buffer):

- **Sep 1 crash**: `OutOfMemoryError` (Java heap at the 256MB growth limit) thrown
  while setting the `source` prop of an `RCTImageView` — a base64 artwork data URI —
  13.6s after process start, during initial mount.
- **History**: exit RSS of 455–818MB; an Aug 26 SIGKILL at 818MB (low-memory killer).
  Same disease, different symptom.

## Root cause

`AudioMetadataModule` re-encodes embedded artwork as JPEG q80 but **never
downscales** it. A 3000×3000 embedded cover becomes a multi-MB base64 string. Every
book's artwork lives simultaneously in DB rows, the Zustand store, and bridge
traffic as Image `source` strings. Recently imported books with large covers pushed
the Java heap over its 256MB cap. Not a regression — cumulative data growth.

## Decision

Keep base64 artwork (simplifies sync and correctness). Two-part fix:

1. **Cap at extraction**: downscale artwork to max 512px in `AudioMetadataModule`.
   Fixes all future imports.
2. **Repair migration**: downscale stored artwork where base64 length > 100KB.
   Queued for sync (see LWW note below).

## Migration system unification

The repair needs async native calls; the old migration system was synchronous
(`(db) => void`). Rather than a parallel "data migration" lane, migrations are
unified: `(db, deps) => Promise<void>`, with injected native deps, awaited in order
by the runner. Migrations run before store hydration, so data repairs write the DB
only — the store hydrates already-repaired rows.

**Migration rules** (now that migrations can fail mid-way):

- **Idempotent**: a failed migration doesn't bump the index and reruns fully next
  launch. Gate work so reruns are safe (here: the >100KB size gate).
- **Memory-lean**: never `SELECT` bulky columns for all rows at once. Fetch ids
  first, then process row-at-a-time.

## Sync interaction (LWW)

The repair queues each modified book for sync (bumps `updated_at`). Under
whole-entity LWW this can discard a concurrent unsynced edit from another device
(repair is a bulk machine-write on startup, on maximally stale data). **Accepted
risk**: book detail edits are rare after import; drift between local and remote
artwork was judged worse. Ping-pong (each device repairing + uploading) converges.

## Rejected alternatives

- **Artwork as files** (`artwork/{id}.jpg`, `file://` URIs): removes base64 from
  store/bridge/DB entirely. Correct long-term, but touches sync (artwork travels
  inside the book JSON payload). Deferred; composes with this fix.
- **Repair as post-hydration pass** (lazy, `metadata_version`-style): made obsolete
  by the async migration unification — pre-hydration is simpler and runs on an
  empty heap.
- **Not queueing the repair for sync**: avoids the LWW clobber risk but leaves
  local/remote artwork drifting. Rejected by preference for convergence.
- **"Updating" progress screen**: no ANR risk (main thread idles under the native
  splash; work is on JS + native-module threads), stall is one-time and small.
  Logcat progress lines instead.
- **Rollback support**: only matters on app downgrade, which is already
  unsupported. Idempotency covers mid-failure reruns. Deferred.

## Context

This investigation also validated `ApplicationExitInfo` as the backbone of a future
local-only crash reporting system (optional, default off) — the same API used to
diagnose this crash retroactively. Not built yet; see conversation record.
