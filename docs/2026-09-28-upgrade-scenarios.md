# Upgrade scenarios

Replaces per-migration upgrade hooks
([2026-09-02-migration-testing.md](2026-09-02-migration-testing.md)) with
scenarios seeded per live version. Triggered by the first migration that
reaches outside the database (artwork as files,
[2026-09-28-artwork-as-files.md](2026-09-28-artwork-as-files.md)).

## Problem with hooks

- **Keyed by migration, verified at the end.** Hooks in the range (base,
  current] seed up front, and all checks run after the full chain. A check
  assumes its migration was the last to touch the data. Once a later
  migration transforms the same data (13 downscales base64 artwork, the
  planned files migration moves it), the earlier check fails. Real devices
  are unaffected; only the test's assumptions break.
- **"Kept forever" worked against the goal.** The goal is testing upgrades
  from versions users actually run, not all of history. Nobody runs v1.0.0.
- **SQL only.** An upgrade is more than the DB: files, settings, native
  leftovers (the stale `no_backup/` libs incident was an upgrade bug).

## Model

We test **app upgrades**, not DB migrations.

- **Scenario**: one interesting situation.
  - `description`
  - scenario-local constants (ids, expected values), shared by its seed and
    verify
  - `seed(ctx)`: code. Always produces the same semantic state; how it gets
    there may differ per base (branching on `ctx.hasColumn(...)`, not on
    version numbers).
  - `verify(ctx)`: code, against the current build only.
- **Version**: a release users still run.
  - `name`: the tag (`v1.6.5`). The APK is `cache/upgrade/ivy-maestro-<name>.apk`;
    no version code is stored.
  - `migration`: the base's migration index, asserted at runtime (catches a
    wrong entry, feeds the coverage guard).
  - `seed(run)`: calls `run(scenario)` for each scenario that version's app
    could have produced. Explicit per-version lists are the readable record
    of what is tested from where.
- **Context**: run-wide tooling and info. It holds no scenario params.
  - seed side: `sql`, `shell`, `pushFile`, `hasColumn`, `base`, fixture paths
  - verify side: `query`, `shell`, `file`
- **Run** per version: wipe → install base → launch until its DB settles →
  stop → `version.seed(run)`, where each `run` seeds now and queues that
  scenario's verify → upgrade-install the current build → launch until
  migrated → stop → run the queued verifies → crash check.

A run verifies exactly what it seeded.

### Rules

- **A version seeds only states its app could have produced.** SQL seeds
  bypass the app. Seeding a pre-migration-X state into a post-X base creates
  an impossible state, and its verify would fail for no real reason.
- **Seeds are stable; verifies follow the current schema.** When a migration
  changes how data is represented, update the affected verifies in the same
  commit, keeping the same invariant in the new representation. Rewriting a
  verify is allowed, carefully: same invariant, both paths run.
- **Versions are dropped when nobody runs them.** Delete the entry, then
  delete scenarios no remaining version seeds. Git keeps the history. The
  floor is simply the oldest entry.
- **Live versions** come from Play Console → Statistics → install-base metric
  broken down by app version (tiny versions may be hidden by the privacy
  threshold). Re-check before releases.

### Guards

- **Coverage:** every data-transforming migration above the oldest live
  version's `migration` must be named by some scenario
  (`migrations: [14]`), seeded by a version below it. Jest, from
  `DATA_TRANSFORMING` + `VERSIONS`.
- **Previous release listed:** `prepare` fails if the previous release tag has
  no `VERSIONS` entry. Every release then forces adding its own entry before
  the next one.
- **Latest migration** stays a hand-mirrored constant (the toolkit can't
  import `database.ts`), guarded by the existing jest test.

## Decisions

- One file, `bin/upgrade_scenarios.ts`: scenarios, then versions. Meant to be
  re-read before each release.
- `prepare` tests every version. `test --upgrade` defaults to the previous
  release; `--from <name>` picks one entry.
- On failure: run all versions, report all, exit nonzero.
- Seeding by SQL, files and shell. Driving the old app (maestro on the base
  build) is added when a scenario needs it.
- Existing hooks: the baseline becomes the `baselineLibrary` scenario. Hooks
  12 (quote strip) and 13 (artwork repair) are dropped: the live versions
  (v1.6.4, v1.6.5, v1.6.6; Play Console 2026-09-28) are all at migration 13 or
  above.

## Rejected alternatives

- **Superseded marker** (`supersedes: [13]` on a later hook): keeps "hooks
  forever" but moves the earlier invariant's knowledge into the later hook.
- **Per-version hooks with their own verify:** duplicates the verifies across
  live versions × releases. Most of verify is the same end state.
- **Seed args as versions** (`version=10602`): hides *why* a seed branches.
  `ctx.hasColumn()` says it.
