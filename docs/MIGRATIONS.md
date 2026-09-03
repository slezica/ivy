# Migrations

How Ivy's database migration system works, the rules for writing migrations,
and how they are tested. **This guide is canonical for the migration rules** —
the comment block in `database.ts` and CLAUDE.md carry pointers, not the full
story. Design records:
[2026-09-02-artwork-oom-repair.md](2026-09-02-artwork-oom-repair.md) (async
unification), [2026-09-02-migration-testing.md](2026-09-02-migration-testing.md)
(testing system).

## The system

- Migrations live in a single ordered array in
  `src/services/storage/database.ts`. The array **is** the schema history.
- Signature: `(db, deps) => Promise<void>`. `deps` (`MigrationDeps`) injects
  native services so data-repair migrations can do real work (e.g. image
  re-encoding via `AudioMetadataService.downscaleArtwork`).
- The last applied index is tracked in the single-row `status` table.
  `DatabaseService.migrate(deps)` awaits pending migrations in order, bumping
  the index after each. Bootstrap guard: migration 0 records itself in
  `status` before creating the rest of the schema, so `migrate()` reruns it
  (it's fully idempotent) whenever `status` exists but the `files` table
  doesn't — a mid-way bootstrap failure would otherwise resume at 1 against
  missing tables, forever.
- **Migrations are not transactional.** `migrate()` awaits each one and then
  bumps the index — there is no BEGIN/COMMIT around a migration, so partial
  writes from a mid-migration failure stay in the DB. That is *why* rule 2
  (idempotence) exists: the rerun must be safe against its own half-done work.
- Failure surface: the rethrow names the culprit —
  `Migration ${i} failed (db still at ${i-1}, reruns next launch)` — and
  remaining migrations are skipped. `initializeApplication` swallows the error
  so the splash always dismisses, surfacing a toast ("Ivy startup problem…");
  the session runs un-hydrated until the next launch retries.
- Execution: the `runMigrations` action is the **first thing**
  `initializeApplication` does — nothing reads or writes the DB before it
  resolves (details in CLAUDE.md's initialization section).
- Snapshot: when pending migrations exist, the DB is snapshotted first via
  `VACUUM INTO` to `<db path>.pre-migration`
  (`/data/data/<app>/files/SQLite/audioplayer.db.pre-migration` on device;
  skipped for in-memory test DBs; snapshot failure logs and proceeds — never
  blocks startup; deleted on success). An inspection artifact, not rollback
  machinery — note there is currently no toolkit route to retrieve it
  (`query` pulls only the live DB); use adb directly if you need it.

## Rules for writing a migration

1. **Append-only. Never edit a shipped migration.** Devices already ran it;
   editing history makes tests lie and reality diverge. Fix mistakes with a
   new migration.
2. **Idempotent.** A failed migration doesn't bump the index and **reruns
   fully** next launch. Gate data work so reruns are safe (e.g. the artwork
   repair's size gate).
3. **Memory-lean.** Never SELECT bulky columns for all rows at once: fetch ids
   first, then process row-at-a-time.
4. **Decide sync semantics explicitly.**
   - Repair should converge across devices → bump `updated_at`/`updated_by`
     and insert into `sync_queue` (mirrors `queueChange`). Accepted risk:
     whole-entity LWW can discard a concurrent unsynced edit.
   - Deterministic per-device normalization → touch nothing sync-related.

The shipped data-transforming migrations, as worked examples:

| # | What | Sync decision |
|---|------|---------------|
| 8 | Snapshot book title/artist onto clips (backfill new columns) | Per-device backfill — no bump, no queue |
| 12 | Strip enclosing quotes from transcriptions | Per-device normalization — no bump, no queue |
| 13 | Downscale oversized stored artwork | Converging repair — bump + queue |

## Adding a migration — checklist

1. Append to the `migrations` array in `database.ts` (rules above).
2. If data-transforming: add a jest prefix-replay case
   (`migrations.test.ts`) and an upgrade hook (`bin/upgrade_hooks.ts`).
   Pure ADD COLUMN migrations need neither.
3. Bump `LATEST_MIGRATION` in `bin/upgrade_hooks.ts` — hand-maintained
   (the toolkit can't import `database.ts`); a unit test fails if you forget.
4. If data-transforming: append the index to `DATA_TRANSFORMING` in
   `bin/__tests__/upgrade_hooks.test.ts` — also hand-maintained; forgetting
   leaves the hook-coverage guard blind to the new migration.
5. `bin/ivy.ts build maestro` then `bin/ivy.ts test --upgrade`.

**Seed-schema trap:** when several migrations ship in one release, ALL their
hook seeds run against the *previous release's* schema — a later hook cannot
use columns an earlier migration in the same batch added.

**Release coupling:** `prepare` runs the upgrade test unconditionally (when a
previous release tag exists), and the test aborts when the base tag is already
at `LATEST_MIGRATION` — so a release that ships migrations must bump it, and
the abort happens inside the try that reverts the version bump.

## Testing

Three layers (see the testing design record for full rationale):

1. **Jest prefix-replay** (`src/services/storage/__tests__/migrations.test.ts`):
   reconstruct any prior schema version with the `dbAtVersion(n)` helper
   (runs an array prefix on a real SQLite DB via `sqlite_adapter.ts` —
   `createTestDatabase()`, foreign keys deliberately off to mirror the device,
   `testMigrationDeps` with an identity downscaler), seed period-correct rows
   via raw SQL, run the pending migration, assert. **Required for every
   data-transforming migration.**
2. **Upgrade smoke test** (`bin/ivy.ts test --upgrade`): installs the previous
   release's maestro APK (cached in `cache/upgrade/` by `prepare`; rebuilt
   from tag as fallback — Mac-only), seeds baseline data + hook seeds,
   upgrade-installs the current build, verifies migration index + data + no
   crash. Prerequisites and side effects: needs a built maestro APK, host
   `sqlite3`, and a rootable emulator image (DB access via adb root — the
   maestro variant is not debuggable); it **uninstalls the app** and disables
   wifi/data for the run (restored afterwards; suppresses the whisper-model
   download). `--from <tag>` targets a specific cached base.
3. **Per-migration hooks** (`bin/upgrade_hooks.ts`): seed/verify SQL keyed by
   migration index — device-level assertions for data-transforming
   migrations, exercised with real native deps and real expo-sqlite. A
   **baseline** (not a hook) is seeded and checked on *every* run, using only
   initial-schema columns: index at latest + one book/clip/session surviving.
   Hooks are kept forever (they tell the story, like migrations); the runner
   selects only the ones in the tested transition's range.

**Testing:** `src/services/storage/__tests__/migrations.test.ts`,
`src/services/storage/__tests__/sqlite_adapter.ts`,
`bin/__tests__/upgrade_hooks.test.ts`, `bin/ivy.ts test --upgrade`.
