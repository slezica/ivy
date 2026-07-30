# Toolkit CLI

**Date:** 2026-07-30

## Idea

One project CLI — `script/toolkit.ts` — replacing the loose scripts in `script/`
and the non-standard npm scripts. Two goals:

1. **Unification:** every "now I build / test / prepare" reflex has exactly one
   command, env-aware (Mac vs container).
2. **Agent harness:** first-class commands for seeing and driving the running
   app (screenshots, view hierarchy, logs, DB queries, ad-hoc maestro), so
   agents can navigate and inspect autonomously instead of hand-rolling adb
   incantations.

## Command tree

```
toolkit build <debug|maestro|preview|release|web> [--install] [--arch <abi>]
toolkit clean
toolkit test [--unit] [--e2e]            # no flag = both
toolkit drive --file <flow> | --inline '<yaml>' | --tap <id|text> | --nav <route>
toolkit prepare [--screenshots]          # no flag = all preparations
toolkit doctor                           # env checks + report on all built APKs
toolkit device <connect | wipe | fix-media | put [--fixtures] [--samples]>
toolkit capture [name]                   # screenshot -> captures/
toolkit tree [--raw]                     # view hierarchy dump
toolkit logs [--tag <tag>] [--follow]
toolkit query "<sql>"                    # app DB (pulled copy, read-only)
```

`--device <serial>` is global; defaults to the sole attached device, honors
`ANDROID_SERIAL` (same convention as adb).

## Decisions and rationale

- **Single TS file, tsx hashbang.** Whole tool in one read (good for agents),
  no import graph to design, matches codebase language. Split only when it
  hurts. (tsx can't infer TS from extensionless files, hence `toolkit.ts`.)
- **Verbs at top level, merged aggressively.** `drive` unifies all app-driving
  (maestro flows, inline steps, fast taps, deep links) behind flags; `doctor`
  absorbs env checks + the ffmpeg closure check; install is a flag on build.
- **No `release` command.** Release stays a documented checklist (CLAUDE.md):
  it needs human inputs (version, changeset curation, keystore password) and
  sometimes individual steps. A command would automate the wrong parts.
- **ffmpeg closure check dropped from builds.** The build-time gate
  (`withIvyFfmpegClosureCheck`) was tied to a specific refactor risk that has
  passed. `doctor` runs the check on every APK it finds; revive the gate from
  git history if packaging churn returns.
- **Destructive commands refuse physical devices, no override.** `device wipe`,
  `device put --samples`, and `prepare` clear app data (samples seeding wipes
  the app DB on launch). The developer's daily-life device runs a preview
  build with real data. Guard = all three must hold: `ro.kernel.qemu`/
  `ro.boot.qemu` = 1, `ro.hardware` ∈ {goldfish, ranchu}, serial matches
  `emulator-*` or `host.docker.internal:*`. No `--force` — a flag that exists
  can be mis-used.
- **Fixtures stay inside `test --e2e`** (pushed every run, idempotent), so
  tests never depend on device pre-state; `device put --fixtures` exists only
  for ad-hoc/manual use.
- **`query` pulls a DB copy** via `run-as` (debug variant only) and runs
  sqlite3 locally — inherently read-only, no risk of corrupting live app state.
  Making the maestro variant debuggable was tried and reverted: RN's gradle
  plugin compiles New-Arch C++ with debug assertions for any debuggable
  variant while prefab still links release `libreactnative.so`
  (matchingFallbacks) — undefined `Sealable` symbols at link time.
- **`drive --tap`** resolves elements from a uiautomator dump and taps via
  `adb input` — an optimization over inline maestro (no JVM startup) with a
  smaller vocabulary. `--nav` uses the `ivy://` scheme (expo-router deep
  links).
- **npm scripts pruned to standard ones** (`start`, `test`, `lint`, jest
  variants); everything project-specific lives in the toolkit. CLAUDE.md
  embeds the full `--help` text so agents know the surface from session init.

## Rejected alternatives

- **Bash dispatcher:** no types, poor arg parsing, worse testability.
- **commander/yargs:** `node:util` parseArgs + a small router is enough.
- **`ivy` top-level command / bin install:** repo-local `script/toolkit.ts`
  needs no installation step and no PATH management.
- **Generic "is emulator" prop check alone:** a physical daily-driver device
  now exists; triple check costs nothing.
- **Whitelist of device serials:** maintenance + first-run friction, adds
  nothing over the triple check while all test devices are emulators.
- **`capture playstore` / `ivy shots`:** the Play Store pipeline is a
  *preparation*, not a screenshot of the current screen — it lives under
  `prepare --screenshots` where future Play Store prep can join it.
