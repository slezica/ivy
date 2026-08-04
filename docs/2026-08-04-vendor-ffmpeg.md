# Vendored FFmpeg Runtime + MIT License

**Date:** 2026-08-04

## Idea

Remove the `io.github.junkfood02.youtubedl-android:ffmpeg` Maven dependency.
Vendor its payload — `libffmpeg.so` (exec'd binary) and `libffmpeg.zip.so`
(shared-lib bundle) — directly in `modules/ivy/android/src/main/jniLibs`, and
absorb the wrapper's only job (extract the zip on first use) into our own
`FFmpegEnvironment.kt`. License Ivy itself under MIT.

## Rationale

Two independent problems, one root:

1. **License conflict.** youtubedl-android (`:ffmpeg` + transitive `:common`)
   is GPL-3.0, and its classes compiled into the app — linking, not
   aggregation. Combined with Ivy having no license, that was noncompliant.
   With the wrapper gone, the only GPL component left is the ffmpeg binary
   itself, which we exec as a separate process — mere aggregation, so Ivy is
   free to be MIT.
2. **Play flagging.** Play scans uploads and reads the APK/AAB dependency
   metadata (`dependencies.pb`); a "youtubedl" dependency plus
   `com.yausername.*` DEX namespaces are YouTube-downloader fingerprints on an
   app that contains no downloader (the yt-dlp engine was removed
   2026-06-30). Goal: zero yt-dlp traces in shipped artifacts, enforced by a
   `doctor` scan.

## What changed

- `modules/ivy` jniLibs now carry `libffmpeg.so` + `libffmpeg.zip.so`
  (arm64-v8a), taken byte-identical from the `ffmpeg-0.18.1` AAR — a
  termux-packages ffmpeg build (GPLv3: `--enable-gpl --enable-version3`,
  x264/x265 et al). Provenance kept here, not in code.
- `FFmpegEnvironment.ensureExtracted` replaces `FFmpeg.getInstance().init`:
  extracts the zip to `no_backup/ivy-native/ffmpeg`, marker = zip size,
  wipe-and-re-extract on mismatch, zip-slip guarded. The zip stores lib alias
  symlinks as entries `java.util.zip` extracts as tiny files holding the
  target name (upstream used commons-compress, which restores them); a
  post-extraction pass recreates them as real symlinks — without it the
  linker fails with "too small to be an ELF executable". The
  `com.yausername.youtubedl_android.YoutubeDLException` shim is gone.
  Installs upgraded from ≤ 1.4.x keep an orphaned ~35MB legacy extraction dir:
  deleting it would require naming it in code — the exact trace this change
  removes. Accepted (affected: dev devices + closed testers only).
- **arm64-v8a only** (`withIvyArchitectures.js` defaults
  `reactNativeArchitectures=arm64-v8a`): the vendored runtime ships one ABI,
  so other ABIs must not be built or Play would serve installs with broken
  clip slicing. x86* is dead on phones, v7a is pre-2015; both can return by
  re-vendoring from the AAR (git history) plus dropping the default. Also
  shrinks the release APK by ~150MB and keeps the repo cost to one 34MB blob.
- `doctor` scans every built APK/AAB (extracted, byte-level, DEX + entry
  names) for `yausername|youtubedl|yt-dlp|ytdlp|junkfood02` and fails on hits.
- Ivy is MIT (`LICENSE`, `package.json`). Settings → Licenses screen shows
  MIT, dependency notices, and the full GPLv3 text + source pointers for the
  bundled ffmpeg (GPL requires text + source availability to accompany
  distribution).

## Rejected alternatives

- **License Ivy GPL-3.0** — resolves compliance but forces copyleft on the
  whole app; unnecessary once no GPL code is linked in.
- **Fetch binaries from termux-packages directly** — cleanest provenance, but
  the runtime needs ffmpeg's full shared-lib closure (~40 packages); the AAR
  bundle already has it assembled and shipped-tested. Revisit if we ever
  rebuild ffmpeg ourselves.
- **Download task + GitHub release asset instead of git blob** — keeps the
  repo slim but adds infra and a network step; moot once arm64-only made the
  in-repo cost 34MB.
- **Multi-ABI vendoring** — 130MB of git for ABIs with no real users.

## Future

A self-built, audio-only, LGPL-configured ffmpeg (termux build scripts) would
cut the bundle to ~10MB and void the GPL-notice obligation entirely. Not
worth the build infra today.
