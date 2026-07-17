# FFmpeg native library unpacking: why it happens at runtime, and why we keep it that way

**Status:** decision recorded (no code change from this discussion)
**Date:** 2026-07-17

## Context

`libffmpeg.so` is the bundled FFmpeg executable used by clip slicing
(`AudioSlicerModule`) and chapter extraction (`ChapterReaderModule`). It comes
from the `youtubedl-android` `:ffmpeg` artifact (the yt-dlp engine itself was
removed — see [2026-06-30-remove-ytdlp.md](2026-06-30-remove-ytdlp.md)).

While building out e2e tests we measured a **~88 s one-time cost** on the first
FFmpeg use after a fresh install *on the emulator* (≈1–a few seconds on real
hardware — it is dominated by slow emulator storage). This document records what
that cost is, why it is structurally necessary, the option of eliminating it by
pre-packaging, and why we decided against that for now.

## What ships in the APK

The `:ffmpeg` `.aar` provides, per ABI:

- `libffmpeg.so` — the FFmpeg **executable** (~317 KB), exec'd as a subprocess.
- `libffmpeg.zip.so` — a **35 MB zip** containing ~76 shared libraries (FFmpeg's
  own `libav*`, plus `libssl`/`libcrypto`, `libfontconfig`, `libass`, etc.),
  stored with their **real, versioned soname filenames**.
- (`libffprobe.so`, unused by us.)

We additionally vendor four libs the package links against but does not ship
(`libexpat.so.1`, `libcrypto.so.3`, `libandroid-support.so`,
`libandroid-posix-semaphore.so`) — see docs/CLIPS.md "Vendored shared libs".

## Why the libs are unpacked at runtime (not prepared at install)

The root cause is **filenames**. Android's package installer extracts only
files matching the glob `lib*.so` into the app's read-only `nativeLibraryDir`.
Most of FFmpeg's dependencies have **versioned sonames** —
`libavcodec.so.61.19.101`, `libcrypto.so.3`, `libexpat.so.1` — which do **not**
match that glob. Android therefore never places them on disk; they stay inside
the APK.

But FFmpeg runs as an **exec'd subprocess**, and its dependencies are resolved
by the dynamic linker from `LD_LIBRARY_PATH`, which must point at **real files
with correct names on a writable/linkable filesystem path** — not at entries
inside a read-only APK. So something has to write those ~76 files, under their
real names, to a device path after install. That is exactly what
`FFmpeg.init()` does: it unzips `libffmpeg.zip.so` into
`no_backup/youtubedl-android/packages/ffmpeg/usr/lib/` on first use.

`FFmpeg.init()` (decompiled) is `public final synchronized void init(Context)`,
guarded by a `private static boolean initialized` and a `shouldUpdateFFmpeg`
version check. So it is thread-safe and idempotent: concurrent callers are
serialized on the monitor, and it only re-unzips when the on-disk copy is stale.

## Lifecycle: install / first run / every run / every use

- **Build:** APK contains `libffmpeg.so`, the 35 MB `libffmpeg.zip.so`, our
  vendored `lib*_N.so`, and `libc++_shared.so`.
- **Install:** Android extracts only the `lib*.so`-named files into
  `nativeLibraryDir` (read-only) — including the 35 MB blob, *unopened*. No
  FFmpeg-specific work.
- **First run / first FFmpeg use:** `init()` sees nothing extracted → unzips
  35 MB → ~76 files into `no_backup/…/ffmpeg/usr/lib/`; the first exec
  cold-links them off freshly-written storage. This is the whole one-time cost
  (unpack + cold-link): ~88 s on the emulator, far less on real hardware.
- **Every later run (new process):** the static `initialized` resets, but
  `shouldUpdateFFmpeg` sees the extraction is current → **skips the unzip**; the
  first exec re-links, now warm → fast.
- **Every use (each slice / chapter read):** a fresh `libffmpeg.so` subprocess
  links the on-disk (page-cached) libs → ~40 ms of actual work.
- **Re-unpacks only on:** fresh install, `clearState`/data-clear, or an app
  **update that changes the FFmpeg version**. *Not* a plain restart, and *not*
  an update with unchanged libs — because `no_backup/` survives updates. That
  last case is the "stale libs mask a fresh-install linking failure" trap that
  caused the original clip-add crash (see docs/CLIPS.md, `FFmpegEnvironment.kt`).

## The alternative we considered: pre-package at build time

Because the only blocker is filenames, we *could* eliminate the runtime unzip:

1. **Build step:** extract `libffmpeg.zip.so`, rename every `.so*` to a
   `lib*.so`-compatible form (e.g. `libavcodec.so.61.19.101` →
   `libavcodec_61_19_101.so`), ship them as jniLibs, and emit a soname→file
   manifest. Android then extracts them at install like any native lib.
2. **Runtime step:** recreate the soname symlinks from the manifest into a
   writable dir on `LD_LIBRARY_PATH` (fast — symlinks, not a 35 MB copy).

This is the same mechanism we already use for the 4 vendored libs, just scaled.

### Pros

- Eliminates the ~88 s (emulator) / few-second (device) first-use unpack.
- Lets us drop the 35 MB `libffmpeg.zip.so` from the APK.
- No dependence on upstream's `init()`/unzip behavior at runtime.

### Cons

- **Forks upstream packaging.** We'd own an extract+symlink scheme parallel to
  `youtubedl-android`'s. On an FFmpeg bump the lib set, the intra-lib symlink
  graph, or `shouldUpdateFFmpeg`'s versioning can change, and our custom path
  diverges silently. This is maintenance coupling, not fragility — the transform
  is mechanical and self-regenerating — but it is a standing cost.
- **More moving parts than the 4-lib case:** the zip contains intra-lib symlink
  aliases (`libfoo.so → .so.1 → .so.1.2.3`), so the runtime step must recreate
  the whole alias graph, not one link per lib.
- **Near-zero payoff for real users.** The cost is largely an emulator artifact
  (slow virtio storage). On real hardware it is a few seconds, once per install,
  and the planned startup **warm-up** already moves it off the critical path.

## Decision

**Keep the upstream zip + runtime `init()` as-is.** Do not pre-package.

Rationale: the only thing pre-packaging meaningfully buys is emulator test-suite
speed, and that is already solved more cheaply by "cold-canary + warm-rest" (one
genuine cold-unpack run per suite catches packaging regressions; subsequent
flows reuse the warmed `no_backup/`), backed by the build-time
`scripts/check-ffmpeg-closure.js` static check. The packaging rework buys real
users nothing the warm-up doesn't already give them, at the cost of forking
upstream packaging forever.

## Related decisions (tier 2 test work, same discussion)

- **Background FFmpeg warm-up:** kick `init()` + one throwaway `-version` exec on
  a background thread at app startup (after critical hydration), so the first
  real slice/chapter is fast. Genuine user win.
- **Single funnel to avoid races/duplication:** route the slicer, chapter
  reader, and the warm-up through one idempotent
  `FFmpegEnvironment.ensureReady(context)` that does `init()` + the warm exec
  once. Upstream `init()` is already `synchronized`; the funnel additionally
  dedupes the warm exec and gives every caller one door.
- If pre-packaging is ever revisited, the emulator bottleneck must be the reason
  and the warm-rest coupling must be undesirable — otherwise the trade doesn't
  pay.
