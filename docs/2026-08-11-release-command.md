# Release Process in the CLI

Capture the full release process in `bin/ivy.ts`: one interactive command
(`prepare`) runs preflight → tests → screenshots → version bump → commit →
release build → tag, plus a `generate` command for Play Store assets, and a
`playstore/` → `samples/` + `dist/` reorganization.

## Rationale

- The release sequence lived only in CLAUDE.md prose; every release re-derived
  it by hand. Encode it once, enforce safety (tests before tag, doctor before
  ship, clean tree before commit).
- Keystore password must be interactive-only: password manager → TTY prompt →
  process memory → gone. Never in conversation logs, never stored. This forces
  the command to be user-run on the Mac, which unifies the previously split
  agent-prepares / user-builds flow.
- `playstore/` mixed committed sources, gitignored outputs, and shipped
  artifacts. Split by rule: `samples/` = 100% committed sources, `dist/` =
  100% gitignored outputs.

## Directory reorganization

| From | To | Git |
|---|---|---|
| `playstore/data.json` | `samples/data.json` | committed |
| `playstore/feature.html` | `samples/feature.html` | committed |
| `playstore/artwork/` | `dist/artwork/` | gitignored (was committed; now regenerated) |
| `playstore/cache/` | `dist/audio/` | gitignored |
| `playstore/shots/` | `dist/screenshots/` | gitignored |
| `playstore/feature-graphic.png` | `dist/feature.png` | gitignored (was committed) |
| `playstore/icon-512.png` | `dist/icon-512.png` | gitignored (was committed) |
| `playstore/*.aab` | `dist/ivy-X.Y.Z.aab` | gitignored |
| `playstore/gen-audio.js` | absorbed into `generate --audio` | — |
| `playstore/generate-artwork.py` | invoked by `generate --artwork` | script stays committed (Pillow) |

Gitignore collapses to one line: `dist/`. All references (toolkit, docs,
CLAUDE.md) updated. `samples/` holds only sources; everything generated or
built lands in `dist/`.

## `generate` command

`bin/ivy.ts generate --audio --artwork --feature --screenshots --icon` (1+
flags, each independent):

- `--audio`: silent MP3s from `samples/data.json` → `dist/audio/` (cached,
  existing files skipped).
- `--artwork`: demo covers from `samples/data.json` → `dist/artwork/`
  (python3 + Pillow; clear error if missing).
- `--feature`: render `samples/feature.html` via headless chromium →
  `dist/feature.png` (clear error if chromium missing).
- `--screenshots`: ensure audio/artwork exist (generate if not) → seed + shoot
  on the emulator (current `prepare --screenshots` pipeline) →
  `dist/screenshots/` → also refresh `web/assets/` copies and restitch the
  README composite `docs/screenshots.png` (ImageMagick). Emulator-only.
- `--icon`: derive `dist/icon-512.png` from app icon assets.

The old `prepare --screenshots` command is replaced by this; `prepare` is
repurposed (below).

## `prepare` command

```
bin/ivy.ts prepare --version <X.Y.Z> --changes <markdown> [--screenshots]
```

User-run on the Mac, interactive TTY required (agent has no TTY and fails
fast). The agent writes the changelog and prints the exact command to paste.

Pipeline, in order:

1. **Preflight** — fail before any side effect:
   - Tools: node + node_modules, java/keytool, adb, maestro, aapt2, NDK
     llvm-readelf; if `--screenshots`: ImageMagick convert (+ python3/Pillow
     if artwork absent).
   - Environment: ANDROID_HOME resolves, `credentials/release.keystore`
     present, emulator running and verifiably an emulator,
     `local.properties` pollution check, `samples/data.json` present.
   - Git/version: clean tree, branch is `master`, version > current,
     minor/patch < 100 (versionCode derivation), VERSIONS.md has no section
     for the version, tag `vX.Y.Z` absent. No origin check (single
     developer; network-free).
2. **Password** — prompt immediately, verify against the keystore via keytool
   (wrong password fails in seconds). Held in process memory only, passed as
   env to the gradle child in step 7. Prompt-early so the user pastes once
   and walks away.
3. **Test** — build `maestro` variant (test affordances; `preview` lacks
   them), install on emulator, run unit + e2e suites.
4. **Screenshots** (if `--screenshots`) — reuse the installed maestro build;
   same code as `generate --screenshots`, including web/README refresh.
5. **Bump + log** — set version in package.json, insert `--changes` section
   into VERSIONS.md.
6. **Commit** — `release: vX.Y.Z` (package.json + VERSIONS.md); if
   screenshots changed committed assets, a separate `web: refresh
   screenshots` commit first (repo convention: tight scopes).
7. **Release build** — assemble + bundle (existing build code).
8. **Doctor, scoped** — artifact checks on the fresh APK/AAB only (version
   stamp, ffmpeg closure). Full doctor would fail on stale unrelated APKs.
9. **Copy** — `dist/ivy-X.Y.Z.aab` (+ `.apk`).
10. **Tag** — `vX.Y.Z`, only now, after the release build is proven.
11. **Checklist** — print manual follow-ups: push master + tag, Play Console
    upload (exact file path, versionCode, changelog text to paste), GH
    release. Publishing stays manual — sensitive, future work.

`build release` standalone keeps steps 7–9 (auto-doctor + copy) for rebuilds,
but never tags; tagging expresses release intent and lives only in `prepare`.
`build preview` also auto-doctors its artifact.

## Safety model

- Tests and doctor gate the tag; a tag existing implies a shipped-quality
  build existed.
- Dirty tree fails preflight — release commits contain only the release.
- Password: TTY prompt → memory → child process env → forgotten. No logs, no
  storage, no agent involvement.
- Destructive/emulator-only guards unchanged (`requireEmulator`).

## Testing

Extract the new logic as pure functions and cover in `bin/__tests__/`:

- Version math: semver compare, minor/patch < 100, versionCode derivation.
- VERSIONS.md: section detection, section insertion (position, formatting).
- Preflight predicates: git status parsing, tag existence parsing.
- Checklist rendering.

Side-effectful pipeline steps (gradle, maestro, adb) stay untested at unit
level — e2e coverage is the pipeline running for real each release.

## Rejected alternatives

- **Tag in prepare before the release build** (after preview tests): build
  failure would leave a tag pointing at an unshipped version.
- **Split prepare/build commands** (agent prepares, user builds): the split
  existed only for the password; prompt-early interactive prepare removes the
  reason.
- **Automating Play Console / GitHub publishing**: sensitive; deferred.
  Printed checklist instead.
- **`--changes-file`**: inline `--changes` kept for now; revisit if too
  clunky.
- **Embedding feature.html in CLI code**: it's a source; committed in
  `samples/`.

## Doc updates required

- CLAUDE.md: "Preparing a Release" rewritten around `prepare`; file structure;
  toolkit reference.
- docs/2026-07-21-playstore-screenshots.md: paths + command names.
- docs/VERSIONS.md header: process pointer.
