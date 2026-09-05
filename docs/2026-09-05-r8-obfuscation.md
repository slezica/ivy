# R8 Obfuscation

Enable R8 (minify + obfuscate) on release, preview and maestro builds, with a
harness that measures the result and catches R8 breakage before Play does.

## Trigger

Play Console, release v1.6.2: "App optimization is below our threshold —
Obfuscation (1%). Percentages under 25% in any category may impact your
visibility and publishing capabilities. Fix by Feb 2027."

Cause: `android.enableMinifyInReleaseBuilds` was never set → R8 off → every
class ships under its real name.

## Rationale

- R8 was deliberately off (CLAUDE.md "Native Packaging Changes",
  docs/2026-08-04-edge-to-edge-deprecations.md rejected it as "a whole risk
  class for zero user-visible gain"). Play now supplies the gain: a policy
  deadline.
- The risk class is real: R8 failures are runtime-only, surface at the first
  reflective or JNI call, and are often non-fatal (caught, logged, feature
  silently dead). The existing suite runs on unminified maestro builds and
  has no eye on logcat. So the work is mostly harness.
- The vendored ffmpeg is unaffected: an exec'd binary, native/filesystem path,
  outside the JVM. `FFmpegEnvironment.kt` is plain Kotlin with no reflection
  on it; R8 may rename it freely. The `*Module.kt` classes are kept by RN's
  `NativeModule` consumer rule.

## Decisions

- **Variants:** R8 on for `release`, `preview` and `maestro`; `debug` stays
  unminified (Metro dev loop). The template wires `minifyEnabled` /
  `proguardFiles` into `release {}` only, and `initWith debug` copies
  debug's `false` — so the `preview` block in `plugins/withIvyBuildTypes.js`
  sets both explicitly (maestro inherits). A static R8-marker check on the
  maestro APK keeps this from regressing silently. Consequence: e2e +
  upgrade tests exercise the shipped bytecode; maestro builds get slower
  (delta recorded) and e2e logcat is obfuscated (mapping available).
- **Minify only, no `shrinkResources`.** Play scores obfuscation.
  `BuildInfoModule` resolves `ivy_build_variant` / `ivy_build_date` via
  `getIdentifier`; resource shrinking would put them at risk for nothing.
- **Mechanism:** `expo-build-properties` `enableMinifyInReleaseBuilds` (the
  template gradle already reads the property) + `extraProguardRules`. Full
  R8 mode (AGP 8 default) unless a library forces compat mode.
- **Keep rules up front**, not "if needed". Two dependencies ship no consumer
  rules and look up Java members by name from JNI: `whisper.rn`
  (`onProgress`, `onNewSegments`, `emitNativeLog` on private nested classes
  with no Java callers — stripped → `GetMethodID` null → JNI abort; its README
  documents `-keep class com.rnwhisper.** { *; }`) and `react-native-audio-api`
  (`-keep class com.swmansion.audioapi.** { *; }`). Ivy never passes
  `onProgress`, so no runtime test would catch the first one. Verified fine:
  expo-sqlite (`@DoNotStrip`), reanimated/worklets/expo-modules-core (ship
  rules), track-player (media3/coroutines/guava rules in AARs), google-signin
  (Play Services rules), react-native-fs (plain Java), Skia (`@DoNotStrip`).
- **Mapping delivery:** `build release` / `prepare` copy
  `app/build/outputs/mapping/release/mapping.txt` to
  `dist/ivy-release-X.Y.Z-mapping.txt`. The AAB also embeds it
  (`BUNDLE-METADATA/com.android.tools.build.obfuscation/proguard.map`), so
  Play deobfuscates crash reports automatically. Local retrace:
  `$ANDROID_HOME/cmdline-tools/latest/bin/retrace mapping.txt trace.txt`
  (no toolkit command until a real obfuscated crash asks for one).
- **yt-dlp artifact scan dropped.** An agent scan of the repo and the
  vendored payload found zero lineage strings anywhere (source, docs aside,
  `libffmpeg.so`, all 184 entries of `libffmpeg.zip.so`, sibling libs).
  Under R8 class names vanish (string literals survive). The remaining
  "tripwire" value guarded only deliberate future edits (re-vendor from the
  old AAR, Maven re-add). Legacy; removed with its docs mentions. Stale
  comment in `plugins/withIvyPackaging.js` fixed alongside. Unrelated to R8
  on merits — bundled here because the artifact-check code is being touched.

## Testing plan

Principle: measure statically, cover the reflective/JNI surface at runtime,
scan logs for what doesn't crash. Cheapest experiment first; harness sized
from its result, calibrated against the unminified build so every detector
has a known baseline.

### Phase −1 — spike

1. Preview block sets `minifyEnabled` + `proguardFiles`; keep rules for
   whisper.rn + audio-api; `enableMinifyInReleaseBuilds: true`. Build
   maestro, run the existing e2e suite, hand-run one transcription. Answers
   "does R8 break Ivy" in half a day. Record build-time and size delta.

**Spike result (2026-09-05): R8 breaks nothing reachable.**

| | v1.6.4 release (D8) | maestro, R8 full mode |
|---|---|---|
| APK | 84.7MB | 73.1MB |
| DEX | 5 files, 47.7MB | 2 files, 13.5MB |
| classes in mapping | — | 19,321 (94.7% renamed) |
| build (container, cold) | — | 4m03s |

- Build clean: no R8 warnings, no missing classes.
- `usage.txt`: zero removals under `com.rnwhisper`, `com.swmansion.audioapi`,
  `com.salezica`. All `*Module` classes, `MainActivity`, `MainApplication`
  kept by name; `FFmpegEnvironment` → `s9.e`, `IvyPackage` → `s9.k`.
- E2e 12/12. One flow took 16m39s: maestro waited 15m44s for the view
  hierarchy to "settle" before a tap; rerun alone passed in ~90s. Flake,
  not R8.
- Whisper under R8: tiny model seeded as `ggml-small.bin` via adb root,
  transcription toggled on, pending clip transcribed and persisted
  (`(electronic music)`) within ~10s. Path covered: ffmpeg exec →
  audio-api decode (JNI) → Whisper JNI → DB.
- Logcat grep for the R8 signature list: zero hits — but the default dump
  held only the last flow's pid, confirming the streaming/pid-set design if
  the scan is built at all (decision deferred: build it only if a baseline
  shows the caught-and-logged category is real).
- Gotchas: `adb root`/`unroot` destabilize the TCP adb connection (maestro
  "device offline"); reconnect after. Maestro is not on PATH in the
  container (`~/.maestro/bin`).

### Phase 0 — harness, calibrated on the unminified build

2. **R8 artifact checks** (`doctor` + release artifact checks), deterministic:
   - R8 marker present in every DEX (`~~R8{...}`; carries `r8-mode` and
     `pg-map-id`). The unminified build has `~~D8{` only — this check must
     fail on it and pass after the flip. On maestro APKs too (guards the
     `initWith` regression).
   - `pg-map-id` in the marker == `# pg_map_id:` in the delivered mapping →
     mapping matches the artifact. AAB: `proguard.map` under
     `BUNDLE-METADATA/com.android.tools.build.obfuscation/`.
   - Rename ratio from `mapping.txt` (class lines where original ≠
     obfuscated), advisory only. Play's own "App optimization" number is the
     only oracle for itself: a DEX class-name heuristic reads 7.5% on
     v1.6.4 (Play Services ships pre-obfuscated `zz*` classes) where Play
     says 1%, so no calibration is possible.
   - `com.salezica.ivy.*Module` classes present by name (RN keeps
     `NativeModule` implementations). `FFmpegEnvironment` is not one and
     may be renamed — fine, nothing reflects on it.
3. **Stripped-member diff:** `-printusage` → `usage.txt`; fail on anything
   removed under `com.rnwhisper`, `com.swmansion.audioapi`,
   `com.doublesymmetry`, `expo.modules`, `com.salezica`. Static; catches
   what libraries swallow silently (reflection failures caught and logged
   nowhere, or surfacing as unrelated JS rejections).
4. **R8 signature logcat scan** for `test --e2e` / `test --upgrade`. The
   app's pid changes on every `launchApp clearState` and the ring buffer
   can't hold a suite, so: `logcat -c` at start, stream
   `logcat -v threadtime` to `log/` for the run (child process, like the
   bridge), then filter by the pid set from `ActivityManager: Start proc`
   lines. Patterns: `ClassNotFoundException`, `NoClassDefFoundError`,
   `NoSuchMethodError/Exception`, `NoSuchFieldError/Exception`,
   `UnsatisfiedLinkError`, `AbstractMethodError`,
   `IncompatibleClassChangeError`, `ExceptionInInitializerError`,
   `VerifyError`, `KotlinReflectionInternalError`, `JNI DETECTED ERROR`,
   `No implementation found`, `Fatal signal`, `libc++abi`. First run on the
   unminified build yields the baseline allowlist (lines normalized: pids,
   timestamps, hashes stripped). The matcher is unit-tested on a fixture
   logcat in `bin/__tests__/ivy.test.ts`.
5. **Native crash detection:** `appCrashExcerpt` matches the Java
   `Process: com.salezica.ivy` format only; JNI/fbjni aborts print
   `>>> com.salezica.ivy <<<` / `Fatal signal`. Add both.
6. **Simulated model server** — the bridge serves the Whisper model:
   - `GET /model` streams `cache/whisper/ggml-tiny.bin` (~75MB, fetched once
     into `cache/`). Fault modes `model/mode/ok|error|stall|slow` are cheap
     on top and enable the follow-up below; the R8 work uses `ok` only.
   - Reachability: `adb reverse tcp:<port> tcp:<port>`, so the emulator's
     `127.0.0.1:<port>` is the container bridge. Fixed port. Set up and torn
     down by `test --e2e`.
   - URL override, build-time: maestro-only
     `resValue 'string', 'ivy_whisper_model_url', 'http://127.0.0.1:<port>/model'`
     read through `BuildInfoModule.stringResource` (missing resource →
     `null` → default HuggingFace URL). No runtime state, no cleanup, no
     leftover-URL hazard; preview/release carry no such resource.
   - Cleartext: `android:usesCleartextTraffic="${ivyCleartext}"` in the main
     manifest (`withAndroidManifest`); placeholder `false` in `defaultConfig`,
     `true` on maestro (must resolve in every variant or the merge fails).
     Expo's `src/debug` manifest already forces `true` via `tools:replace`.
     `false` is the platform default since targetSdk 28 — production
     unchanged in effect. Localhost gets no exemption from the block.
   - Follow-up (same branch, separate commits): rewrite
     `transcription-states.yaml` on the fault modes — it currently starts a
     real 465MB HuggingFace download every run.
7. **New flow `transcription-inference.yaml`:** clearState → model downloads
   from the bridge → import → add clip (default 250ms) → bridge
   `check/transcribed` polls `clips.transcription IS NOT NULL`. Oracle is
   "Whisper ran and persisted", not "transcription correct" — empty string
   counts. Duration measured on first run.
8. **New flow `playback-integration.yaml`:** media key via `adb shell cmd
   media_session dispatch play-pause` (same path as Bluetooth/headset
   controls → track-player remote integration), HOME → position advances
   (bridge DB check), `stopApp` → `launchApp` → auto-resume shows the book.
   Notification shade skipped (fragile on emulator; the media key exercises
   the same service).
9. Baseline recorded: suite result, scan allowlist, sizes, build time.

### Phase 1 — flip, static

10. Build must pass: R8 fails on missing classes by default (no blanket
    `-dontwarn`). R8 warnings surfaced from `log/build.txt`.
11. Checks 2–3 green; size + build-time delta vs baseline; one `retrace`
    round-trip on a synthetic obfuscated stack proves the delivered mapping
    works.

### Phase 2 — runtime, emulator, automated

12. Full e2e suite (incl. the two new flows) + upgrade test + R8 scan diffed
    against the baseline allowlist.

### Phase 3 — runtime, real device, manual (preview build, now minified)

13. Google sign-in, sync push + pull, Drive picker import, share sheet. Not
    automatable (real account, OAuth, system share UI).

### Phase 4 — ship

14. `prepare` delivers the mapping next to the artifacts.
15. Upload to internal testing → Play's own "App optimization" metric is the
    oracle; the pre-launch report (robo crawl on real devices) is a second
    crash detector.

## Rejected alternatives

- **Release-only R8** (preview/maestro unminified): minimal, but the suite
  would stop testing the shipped bytecode. The whole point of the work is
  certainty; the extra build minute is cheap.
- **`shrinkResources`:** no Play credit, real risk to `getIdentifier`
  lookups.
- **Seeded model** (adb push `ggml-tiny.bin` under the `ggml-small.bin`
  name + app restart): simpler, but no fault injection, keeps the HF
  download in `transcription-states`, and lies about the filename.
- **Manifest overlay** (`src/maestro/AndroidManifest.xml` via
  `withDangerousMod`) for cleartext: a source-set file written on prebuild.
  The placeholder does the same inside the existing plugin.
- **`settings put global` for the model URL override:** survives
  `clearState`, needs no root — but is runtime state the toolkit must set and
  clean up, and a dead toolkit leaves a stale URL behind. The maestro-only
  `resValue` has none of that; the fixed bridge port is the price.
- **DEX class-name obfuscation ratio as Play's metric:** unreproducible (see
  Phase 0 step 2). R8 marker + mapping checks instead.
- **Host-network reachability** (`10.0.2.2`) instead of `adb reverse`: the
  bridge runs in the container, whose ports aren't published to the Mac.
  Environment-dependent; `adb reverse` works over TCP devices and native Mac
  runs alike.
- **Proving the log scan with an injected logcat line** (`adb shell log`):
  wrong pid, wouldn't pass the app-pid filter. The matcher unit test is the
  proof.
- **`retrace` toolkit command:** deferred until an obfuscated crash actually
  needs it. The *check* that the mapping retraces is not deferred (Phase 1).

## Review

An adversarial review of the first draft found: the `initWith` inheritance
gap (blocking), the unreproducible ratio calibration, the two missing keep
rules, the Java-only crash detector, the pid/ring-buffer flaw in the log
scan, the silent-failure gap (→ `usage.txt` diff), and the spike-first
ordering. All folded in above.
