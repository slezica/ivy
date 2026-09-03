# Migration testing: device-level upgrade verification

Follow-up to [2026-09-02-artwork-oom-repair.md](2026-09-02-artwork-oom-repair.md)
(which made migrations async and added the first data-repair migration). Data
migrations are the most release-sensitive code in the app: bugs corrupt user
data and are harder to fix after shipping than anything else. This design adds
device-level verification on top of the existing jest coverage.

The design went through an adversarial review round (independent agent) which
caught two broken assumptions — debug APKs carry no JS bundle (Metro-only), and
the debug keystore was not actually committed — and prompted several amendments,
folded in below.

## Coverage model

Three layers, each covering what the previous can't:

1. **Jest prefix-replay** (`migrations.test.ts`, exists): migration *logic* on
   real SQL. Fast, deterministic, runs on every `npm test`. Cannot cover: native
   deps (fakes injected), real expo-sqlite, the true upgrade-install path.
2. **Generic upgrade smoke test** (new, toolkit): the real transition — previous
   release binary writes the DB, current build migrates it. Catches integration
   breakage (runner wiring, native calls, install path) for every future
   migration with zero per-migration work.
3. **Per-migration hooks** (new, plug-in on layer 2): seed + verify code keyed
   by migration index, for migration-specific data shapes and assertions.
   **Required for data-transforming migrations, skipped for pure ADD COLUMN**
   (same policy as jest migration tests).

## Components

### 1. `bin/ivy.ts test --upgrade [--from <tag>]`

Emulator-only (destructive; wipes to clear tinkered-with builds — same
no-override gate as `device wipe`). Tests the **latest transition** by default:
previous release tag → current working tree. `--from` tests any cached base.

Both sides use the **maestro build variant**: it embeds a JS bundle (debug is
Metro-only and never launches headless). The review's "make maestro
debuggable" suggestion turned out to break the build — `debuggable true`
flips AGP's CMake config to Debug, which references debug-only RN symbols
while `matchingFallbacks` links the release prefab (undefined symbols at link
time). DB access on the non-debuggable maestro build goes through **adb
root** instead (the review's own alternative; emulator-only, which the test
already is — fails cleanly on unrootable Google Play images). Signature
continuity holds: the standard Android debug keystore is now **committed**
(`secrets/` stays ignored except that one file), so any post-keystore tag
checkout builds self-contained.

Pipeline:

1. Wipe emulator app state; uninstall any installed build.
2. Obtain the previous release's maestro APK from `cache/upgrade/` (populated
   by `prepare`, see below). Fallback on cache miss: worktree-checkout the tag
   under `worktrees/` and build it — works for tags containing the committed
   keystore; older tags require re-seeding the cache by hand. **No tooling
   ever copies `secrets/` anywhere** (hard rule: secrets are never duplicated).
3. Install old APK; launch once (app creates + migrates its DB at the old
   version).
4. Read the old build's `status.migration` index; select hooks in range
   `(old index, current]`.
5. Seed: baseline data plus selected seed hooks, written as SQL against the
   **previous-release schema** — frozen forever, so committed seed code cannot
   rot. (When several migrations land in one cycle, *all* their seeds target
   the previous-release schema.) Applied via adb root (force-stop first; pull
   DB, apply on the host with sqlite3, push back; clean journal sidecars,
   restore ownership + SELinux context).
6. `adb install -r` the current maestro build (higher versionCode — a true
   upgrade install, exactly what users experience).
7. Launch; wait for initialization.
8. Verify: migration index = latest, baseline data intact, no crash in logcat,
   plus selected verify hooks (SQL asserts against the new schema).

Runs inside `prepare` (before the e2e suite — it wipes the device) and on
demand. **Not** in the default `test` command: native builds are too slow for
the inner loop.

### 2. Per-migration hooks

Seed/verify pairs keyed by migration index, colocated with the toolkit.
**Hooks are kept forever, like migrations — they tell the story.** The runner
selects only the ones the tested transition needs (step 4 above); old hooks
simply never match again.

First hook: migration 13 (artwork repair) — seeds an oversized-artwork row
*and a corrupt (undecodable) oversized row* through the old binary, verifies
on-device downscale (real Kotlin `downscaleArtwork`), the corrupt row's
artwork dropped, the sync-queue entries, and untouched small-artwork rows.

### 3. `docs/MIGRATIONS.md`

Short guide: how the migration system works (async, deps-injected, runs first
in `initializeApplication`), the rules (never edit a shipped migration —
append-only; idempotent; memory-lean; the sync-queueing decision framework),
and the testing layers above.

### 4. Pre-migration DB snapshot (runtime)

When pending migrations exist at startup, snapshot the DB (`VACUUM INTO`,
available in bundled SQLite 3.50) before running them; delete on success.
Policy: delete any stale snapshot first (`VACUUM INTO` fails if the target
exists); on snapshot failure, log and proceed — the safety net must never
block startup. Not rollback machinery — an inspection artifact for when an
upgrade test or a production migration fails.

### 5. Import-path artwork assert (e2e)

The repair hook covers the *repair* path; the *import-time cap* is a sibling
path (shared `encodeArtwork`, different plumbing). Add a `length(artwork)`
assert to the existing import e2e flow — a two-line addition, no new test.

### 6. `prepare` integration

Amended release sequence — version bump split into file-edit (early, so every
tested artifact carries the release version) and commit (late, so failures
leave nothing to undo):

1. Preflight
2. Keystore password prompt + verify
3. **Bump files only** (`npm version --no-git-tag-version` + VERSIONS.md)
4. Maestro build (carries the new versionCode)
5. **Upgrade test** (cached previous base → step-4 build)
6. Wipe → fresh install → jest + full e2e suite
7. [Screenshots + `web:` commit]
8. Commit `release: vX.Y.Z`
9. Release build + artifact checks
10. `dist/` delivery + **cache the step-4 APK as `cache/upgrade/ivy-<version>-maestro.apk`**
11. Tag; manual checklist

Failure before step 8: revert the three bumped files; tree back to clean.
`cache/` is gitignored and lives in the project (no external paths — the
container build mirror and the SDK location remain the only deliberate
exceptions, both environmental).

## Rejected alternatives

- **Per-migration device tests as a standalone system**: duplicates jest at
  100× runtime with heavy per-migration authoring. Resolved instead as small
  hooks on shared smoke-test machinery, required only for data-transforming
  migrations.
- **Rebuild-from-tag as the primary old-APK source**: the flakiest possible
  component (npm registry, prebuild drift, toolchain drift) at the worst
  moment — mid-release. Demoted to fallback; `prepare` caches each release's
  upgrade base, built anyway.
- **Copying `secrets/` into worktrees**: rejected on principle — secrets are
  never duplicated by tooling. The standard debug keystore is public knowledge
  and committed instead; the release keystore never leaves its place.
- **Retiring old hooks**: rejected — hooks are historical record like the
  migrations themselves; index-based selection makes stale hooks inert, so
  deletion buys nothing.
- **Full-history upgrade testing (v0 → current)**: the shipped migrations
  already ran on every real device; only the new transition is unverified.
  Jest prefix-replay covers multi-step logic.
- **Maestro-driven seeding of the old app**: fragile (old UI flows) and slow.
  SQL against the frozen old schema is stable and precise. The old binary still
  participates (it creates and migrates the DB to its version on first launch).
- **Append-only enforcement via source-hash guard (jest)**: rejected as
  unnecessary process — never-edit-shipped-migrations is standard procedure;
  documented as a one-line rule in CLAUDE.md and MIGRATIONS.md instead.
- **Rollback support**: still deferred (see previous doc); the pre-migration
  snapshot covers inspection without adding downgrade machinery.

## Accepted risks

- Cache loss + pre-keystore tag = manual cache re-seed (build the tag by hand
  once). Post-keystore tags rebuild automatically.
- Upgrade test needs the Mac-hosted emulator; container sessions can run
  `test --upgrade` only when it's reachable.
- A skipped (transient-failure) artwork repair persists until the next
  migration failure rerun; confidently-undecodable artwork is dropped rather
  than skipped (amended in the repair migration).
