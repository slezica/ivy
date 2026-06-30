# Remove the yt-dlp (URL download) feature

**Status:** planned
**Branch:** `remove-ytdlp`
**Date:** 2026-06-30

## Core idea

Remove the "Add from URL" download feature, which is powered by yt-dlp (via the
`youtubedl-android` library). Keep every other feature working — crucially the
ones that secretly share yt-dlp's bundled FFmpeg.

## Rationale

We want to publish the app. yt-dlp lets users download media from YouTube and
similar sites, which invites terms-of-service violations. Beyond user behavior,
**bundling the yt-dlp binary itself** is a liability: app-store review commonly
flags YouTube downloaders, and yt-dlp is GPL. Removing the engine (not just the
UI) is the clean path.

## Key finding (the trap)

`youtubedl-android` is split into separate Gradle artifacts. We pull two:

- **`:library`** (`io.github.junkfood02.youtubedl-android:library`) — the actual
  yt-dlp engine (Python + yt-dlp). Used **only** by URL download. *Remove this.*
- **`:ffmpeg`** (`…:ffmpeg`) — ships `libffmpeg.so`. This is the **only** FFmpeg
  in the entire app, and it is **shared**. *Keep this.*

`CLAUDE.md` claims clip slicing uses native `MediaCodec`/`MediaMuxer`. **That is
wrong.** Three native modules shell out to the bundled `libffmpeg.so`:

| Feature | Native module | FFmpeg call |
|---|---|---|
| Clip slicing (`add_clip`, `update_clip`) | `AudioSlicerModule.kt` | `-ss/-i/-t -map 0:a:0 -c:a aac` |
| Transcription extraction (`queue.ts` → `slicer.slice` of first ≤60s) | `AudioSlicerModule.kt` | same |
| Chapter reading on import | `ChapterReaderModule.kt` | `-f ffmetadata` |

`AudioMetadataModule.kt` (title/artist/artwork) uses native
`MediaMetadataRetriever` and is FFmpeg-independent. `FileCopierModule.kt` is pure
JVM I/O. Whisper decodes via `react-native-audio-api`, not `libffmpeg.so`.

### The `compileOnly` coupling

`:ffmpeg`'s `FFmpeg.init()` can throw `com.yausername.youtubedl_android.YoutubeDLException`
— a class that lives in **`:library`** — but the module declares
`compileOnly(project(":library"))`. So the published `:ffmpeg` POM pulls
`:common` transitively but **not** `:library`. Dropping `:library` therefore
risks a runtime `NoClassDefFoundError` from `FFmpeg.init()`'s error path.

**Mitigation:** ship a tiny shim class in our own app source so the symbol
resolves without the yt-dlp engine:

```kotlin
// android/app/src/main/java/com/yausername/youtubedl_android/YoutubeDLException.kt
package com.yausername.youtubedl_android
class YoutubeDLException(message: String?, cause: Throwable? = null) : Exception(message, cause)
```

`YoutubeDLException` is the *only* symbol `:ffmpeg` borrows from `:library`, so
this fully decouples us.

## What must keep working

- Clip slicing, transcription extraction, chapter reading (all → `:ffmpeg`).
- Local file import, metadata extraction, cancel-during-add (cancel the copy).
- The "Adding…" progress dialog (shared with local-file copy).

## Scope

**Delete (download-only):**
- Native: `FileDownloaderModule.kt`, `FileDownloaderPackage.kt`, its registration in `MainApplication.kt`.
- Service: `services/storage/downloader.ts` + its barrel re-exports (`storage/index.ts`, `services/index.ts`).
- Actions: `load_from_url.ts`, `fetch_downloader_state.ts`, `update_downloader.ts`.
- Store: the `downloader` state slice + 3 action wirings/exports/types.
- UI: LibraryScreen "Add from URL" menu + dialog; SettingsScreen "YouTube downloader" section.
- Tests/helpers: `load_from_url.test.ts`, `createMockDownloader`, `downloader` field in `createMockState`.
- Gradle: the `:library` dependency line (keep `:ffmpeg`).

**Surgical (keep file, prune download branch):**
- `cancel_load_file.ts` — drop the `downloader` dep and `downloader.cancelDownload()`; keep `copier.cancelCopy`.
- `LibraryLoadingDialog.tsx` — no code change; it simply stops receiving "Downloading"/"Extracting audio" messages.

**Add:**
- `YoutubeDLException.kt` shim (above).

**Keep untouched (verified FFmpeg-independent of `:library`):**
- `AudioSlicerModule.kt`, `ChapterReaderModule.kt`, `AudioMetadataModule.kt`, `FileCopierModule.kt`, the `:ffmpeg` artifact, `expo.useLegacyPackaging`, jitpack repo.

## Implementation plan (tightly-scoped commits)

1. `qa: add cancel and chapter safety tests` — lock the behaviors that must survive (done first, pre-refactor).
2. `downloader: remove url download action and service` — `load_from_url.ts`, `downloader.ts`, barrel exports.
3. `downloader: remove yt-dlp version state and actions` — `fetch_downloader_state.ts`, `update_downloader.ts`, store `downloader` slice + wiring + types.
4. `loader: cancel only the copier on cancel_load_file` — prune the downloader branch.
5. `library: remove add-from-url UI` — LibraryScreen menu/dialog/styles.
6. `settings: remove yt-dlp downloader section` — SettingsScreen.
7. `android: remove yt-dlp native downloader module` — `FileDownloaderModule/Package`, `MainApplication` registration.
8. `android: drop yt-dlp engine, keep bundled ffmpeg` — gradle `:library` line + `YoutubeDLException` shim.
9. `qa: drop download test helpers` — `load_from_url.test.ts`, `createMockDownloader`, `createMockState` downloader field.
10. `docs: correct ffmpeg/slicing notes` — fix `CLAUDE.md` (slicing uses bundled ffmpeg, not MediaCodec) and document that `:ffmpeg` is retained deliberately.

## Risks

- **Dropping `:library` breaks `FFmpeg.init()`** via the missing `YoutubeDLException` → mitigated by the shim (step 8).
- **Deleting the class but not its `MainApplication` registration** → startup crash. Both in step 7.
- **Touching `expo.useLegacyPackaging` / the `:ffmpeg` line** → `libffmpeg.so` stops extracting → slicing/chapters break at runtime. Keep both.
- **Stale `:library` references after partial edits** (`services/index.ts` `downloader` singleton feeds action deps) → TS build break. Steps 2–4 move together.

## Verification

- `npm test` — full suite green (JS wiring; mocks the native slicer).
- `gradlew :app:dependencies` — confirm `:library` is **gone** and `:ffmpeg` (+ `:common`) **remain**.
- `gradlew :app:assembleDebug` — confirm the app compiles/packages without `:library`.
- APK inspection — no yt-dlp/Python classes; `YoutubeDLException` shim present in DEX; `libffmpeg.so` still packaged.
- **On-device smoke test (only reliable runtime check):** create a clip, import a file with chapters, run a transcription. Confirms `libffmpeg.so` still executes. *Cannot be done in CI/headless — no KVM.*
