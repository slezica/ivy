# Migrations

How Ivy's database migration system works, the rules for writing migrations,
and how they are tested. **This guide is canonical for the migration rules** —
the comment block in `database.ts` and CLAUDE.md carry pointers, not the full
story. Design records:
[2026-09-02-artwork-oom-repair.md](2026-09-02-artwork-oom-repair.md) (async
unification), [2026-09-02-migration-testing.md](2026-09-02-migration-testing.md)
(testing system), [2026-09-28-upgrade-scenarios.md](2026-09-28-upgrade-scenarios.md)
(upgrade test rework: scenarios per live version),
[2026-09-28-artwork-as-files.md](2026-09-28-artwork-as-files.md) (migration
14, the first one crossed by a scenario).

## The system

- Migrations live in a single ordered array in
  `src/services/storage/database.ts`. The array **is** the schema history.
- Signature: `(db, deps) => Promise<void>`. `deps` (`MigrationDeps`) injects
  native services so data-repair migrations can do real work (e.g. image
  re-encoding via `AudioMetadataService.downscaleArtwork`, cover files via
  `ArtworkStore.write`).
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
| 14 | Move base64 covers to files (`artwork_file`), clear `artwork` | Per-device normalization — no bump, no queue (wire format unchanged) |

Migration 14 also shows idempotence with filesystem work: ADD COLUMN guarded
by `PRAGMA table_info`, rows gated on `artwork IS NOT NULL`, deterministic
filenames (a rerun reuses the file), and filesystem errors throw so the
migration reruns rather than stranding covers.

## Adding a migration — checklist

1. Append to the `migrations` array in `database.ts` (rules above).
2. If data-transforming: add a jest prefix-replay case
   (`migrations.test.ts`) and an upgrade scenario (`bin/upgrade_scenarios.ts`)
   naming it in `migrations: [n]`, seeded by the live versions below it.
   Pure ADD COLUMN migrations need neither.
3. If an existing scenario's data changes representation, update its
   `verify` in the same commit (same invariant, new representation).
4. Bump `LATEST_MIGRATION` in `bin/upgrade_scenarios.ts` — hand-maintained
   (the toolkit can't import `database.ts`); a unit test fails if you forget.
5. If data-transforming: append the index to `DATA_TRANSFORMING` in
   `bin/__tests__/upgrade_scenarios.test.ts` — also hand-maintained;
   forgetting leaves the coverage guard blind to the new migration.
6. `bin/ivy-dev.ts build maestro` then `bin/ivy-dev.ts test --upgrade`.

**Seed-schema trap:** seeds run against the *base version's* schema — a
scenario cannot use columns that version doesn't have (branch on
`ctx.hasColumn`, never on version numbers).

**Release coupling:** `release` runs the upgrade test from every listed
version (when a previous release tag exists), and its preflight fails when the
previous release has no `VERSIONS` entry — so each release forces adding its
own entry before the next one. A base already at `LATEST_MIGRATION` still
runs: the upgrade install, scenario verifies and crash check apply.

## Testing

Three layers (see the testing design record for full rationale):

1. **Jest prefix-replay** (`src/services/storage/__tests__/migrations.test.ts`):
   reconstruct any prior schema version with the `dbAtVersion(n)` helper
   (runs an array prefix on a real SQLite DB via `sqlite_adapter.ts` —
   `createTestDatabase()`, foreign keys deliberately off to mirror the device,
   `testMigrationDeps` with an identity downscaler), seed period-correct rows
   via raw SQL, run the pending migration, assert. **Required for every
   data-transforming migration.**
2. **Upgrade test** (`bin/ivy-dev.ts test --upgrade`): for each release users
   still run (`VERSIONS`), installs its maestro APK (cached in
   `cache/upgrade/` by `release`; rebuilt from tag as fallback — Mac-only),
   seeds the scenarios that version lists, upgrade-installs the current
   build, then verifies exactly those scenarios + migration index + no crash.
   All versions run even when one fails; one verdict at the end.
   Prerequisites and side effects: needs a built maestro APK, host `sqlite3`,
   and a rootable emulator image (DB and app storage via adb root — the
   maestro variant is not debuggable); it **uninstalls the app** and disables
   wifi/data for the run (restored afterwards; suppresses the whisper-model
   download). Defaults to the previous release; `--from <tag>` picks another
   listed version; `release` runs them all.
3. **Scenarios and versions** (`bin/upgrade_scenarios.ts`): we test app
   upgrades, not just migrations — seeds and verifies are code (SQL on the
   pulled DB, files pushed into app storage, root shell).
   - A **scenario** is one interesting situation: `seed(ctx)` always produces
     the same semantic state, `verify(ctx)` checks it on the current build.
     Scenario constants (ids, expected values) live next to it.
   - A **version** is a release users still run (Play Console → Statistics →
     install base by app version). Its `seed(run)` lists the scenarios its
     app could have produced — never a state it couldn't (seeds bypass the
     app). `migration` is asserted at runtime.
   - Seeds are stable; verifies follow the current schema. Drop a version
     when nobody runs it, then scenarios no version seeds — git keeps them.
   - Guards (jest): `LATEST_MIGRATION` mirror; every data-transforming
     migration above the oldest live version is crossed by a scenario;
     versions unique, tagged, not ahead; every version seeds
     `baselineLibrary`.
   - **Dry run (jest):** each version's scenarios are seeded into a jest DB
     at its migration index, migrated to latest, and verified — catches SQL
     typos and seed/verify drift in seconds. The device run stays the real
     check (real base builds, native file writes).
   - First scenario crossing a migration: `libraryWithCovers`
     (`migrations: [14]`, seeded by every live version) — JPEG, PNG and
     coverless books; verifies filename shape, exact file size on disk
     (`ctx.fileSize`), base64 cleared, no `updated_at` bump.

**Testing:** `src/services/storage/__tests__/migrations.test.ts`,
`src/services/storage/__tests__/sqlite_adapter.ts`,
`bin/__tests__/upgrade_scenarios.test.ts` (guards + dry run), `bin/ivy-dev.ts test --upgrade`.
