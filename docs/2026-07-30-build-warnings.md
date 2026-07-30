# Release Build Warning Triage

**Date:** 2026-07-30

Classification of all warnings in a clean `build release` log (1.3.0-era,
Expo 54 / RN 0.81.5 / AGP with compileSdk 36).

**Status: items 1–4 fixed on 2026-07-30** (IvyPackage → BaseReactPackage +
dead sub-packages deleted; resValue set post-declaration; keepDebugSymbols in
`modules/ivy` and `withIvyPackaging.js`). Verified: clean maestro build log,
481 unit tests, 9/9 e2e flows. Items 5–9 remain intentionally ignored.

## Worth fixing (our code)

1. **`ivy-native:compileReleaseKotlin` deprecation warnings (7).**
   All `modules/ivy` package classes override the deprecated
   `ReactPackage.createNativeModules` without `@Deprecated`.
   Fix: annotate, or migrate `IvyPackage` to `BaseReactPackage`.
   Bonus: `AudioSlicerPackage`, `AudioMetadataPackage`, `FileCopierPackage`,
   `FFmetadataReaderPackage`, `BuildInfoPackage` are dead code —
   `IvyPackage` instantiates the modules directly. Delete candidates.

## Worth silencing (ours, benign but noisy)

2. **`BuildType(maestro): resValue 'string/ivy_build_variant' is being
   replaced`** — `withIvyBuildTypes.js`: `initWith preview` copies the
   resValue, then we set it again. Harmless; restructure to set once.
3. **`ivy-native:stripReleaseDebugSymbols` "Unable to strip
   libandroid-*.so, libcrypto_3.so, libexpat_1.so"** — vendored prebuilts,
   expected. Silence with `packaging { jniLibs { keepDebugSymbols } }` in
   `modules/ivy` build.gradle.
4. **`llvm-strip error: libffmpeg.zip.so not a valid object file` (×4
   ABIs).** Worst-looking, fully benign: it is a zip masquerading as `.so`
   (youtubedl-android packaging). Same `keepDebugSymbols` fix, via a config
   plugin for `:app`. Highest silencing priority — prints "error" on every
   build.

## Leave and ignore (third-party; resolved only by upgrades)

5. All `node_modules` Kotlin/Java deprecation warnings — track-player,
   screens, expo-*, google-signin, skia, reanimated, safe-area-context,
   audio-api, fs, worklets. Bulk of the log. Not actionable.
6. Manifest `package=` namespace warnings (5 libs) — value ignored,
   upstream fix only.
7. Apollo deprecated-field warnings (expo-dev-launcher), soloader /
   FileSystemFileProvider manifest-merger notes, `NODE_ENV not specified`
   (expo-constants), whisper.rn Metro `exports` fallback — all benign.
8. **`[RNAudioApi] incompatible react-native-audio-worklets version`** —
   ignorable: we use `react-native-audio-api` only for `decodeAudioData`
   (whisper preprocessing), no worklet nodes.
9. Gradle 9.0 deprecation notice — from AGP/RN plugins; revisit at Gradle
   upgrade time.

## Observation (optional follow-up)

`expo-dev-launcher` / `expo-dev-menu` warnings appear in *release* builds
because `expo-dev-client` is a main dependency, so dev tooling compiles
into release (RN gates it at runtime). Standard Expo setup; moving it to a
debug-only path would trim the release closure.
