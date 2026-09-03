# Migrations

How Ivy's database migration system works, the rules for writing migrations,
and how they are tested. Design records:
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
  the index after each.
- Execution: the `runMigrations` action is the **first thing**
  `initializeApplication` does — nothing reads or writes the DB before it
  resolves. The store starts with defaults (`DEFAULT_SETTINGS`); settings and
  sync state hydrate right after. The native splash covers the wait; there is
  no ANR risk (main thread idles; work is on the JS + native-module threads).
- Snapshot: when pending migrations exist, the DB is snapshotted first
  (`VACUUM INTO`; stale snapshot deleted beforehand; snapshot failure logs and
  proceeds — never blocks startup; deleted on success). An inspection
  artifact, not rollback machinery.

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
   - Deterministic per-device normalization → touch nothing sync-related
     (see migration 12, quote stripping).

## Testing

Three layers (see the testing design record for full rationale):

1. **Jest prefix-replay** (`migrations.test.ts`): reconstruct any prior schema
   version by running an array prefix, seed period-correct rows via raw SQL,
   run the pending migration, assert. **Required for every data-transforming
   migration**; pure ADD COLUMN migrations are safe by construction.
2. **Upgrade smoke test** (`bin/ivy.ts test --upgrade`): installs the previous
   release's maestro APK (cached in `cache/upgrade/` by `prepare`; rebuilt
   from tag as fallback), seeds real data, upgrade-installs the current build,
   verifies migration index + data + no crash. Runs in `prepare` and on
   demand; emulator-only.
3. **Per-migration hooks** (seed/verify SQL keyed by migration index, in the
   toolkit): device-level assertions for data-transforming migrations —
   exercised with real native deps and real expo-sqlite. Hooks are kept
   forever (they tell the story, like migrations); the runner selects only
   the ones in the tested transition's range.

When adding a **data-transforming** migration: write the jest case (layer 1)
and the upgrade hook (layer 3). ADD COLUMN migrations need neither.
