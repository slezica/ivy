# Version History

Release log: one section per shipped version, newest first. Record versionName,
versionCode (derived from semver: major\*10000 + minor\*100 + patch, see
`plugins/withIvyVersionName.js`) and the user-facing changeset. Sections are
written by `bin/ivy.ts prepare` from its `--changes` argument (see CLAUDE.md
"Preparing a Release") — the agent drafts that markdown in this file's style
(Features/Fixes/Infra headings as applicable).

## 1.6.2 (versionCode 10602) — 2026-08-11

Fixes:

- Background battery drain eliminated: the UI no longer re-renders while the
  app is backgrounded — store subscriptions narrowed to what each component
  displays, the whole UI tree frozen while in background, and the timeline's
  render loop paused when playback follow has nothing to draw

Infra:

- Release process fully scripted: `bin/ivy.ts prepare` runs preflight, tests,
  version bump, changelog, release build, artifact checks, delivery and tag
- Store asset generation consolidated under `bin/ivy.ts generate` (demo
  audio/artwork, feature graphic, icon, screenshots + website refresh)
- playstore/ split into samples/ (committed sources) and dist/ (generated
  outputs, gitignored)

## 1.6.1 (versionCode 10601) — 2026-08-09

Improvements:

- Timeline playhead detaches during handle drags while playing: it keeps
  moving across the frozen bars and glides back to center on release
  (previously the timeline jumped after release)
- Selection handles are grabbable along their full height

Fixes:

- Handle drags could leak interaction state (grab registered at touch, pan
  activating outside the hit column), freezing the timeline and making the
  next scrub teleport playback seconds into the past — interaction state
  rebuilt as a single mode union, whole bug class now unrepresentable
- Grabbing a handle mid-fling now commits the fling position; previously the
  timeline showed the fling position over never-moved audio until a position
  event snapped it back
- Selection edits are no longer lost when a gesture is cancelled or a pinch
  interrupts a drag

Infra:

- Timeline scenario test suite: full interaction flows against a
  ground-truth audio model, plus seeded gesture fuzzing
- Granular timeline interaction tracing in test builds (TLTRACE logcat
  stream; see src/components/timeline/trace.ts)
- Toolkit CLI moved to bin/ivy.ts
- Website links the Play Store listing

## 1.6.0 (versionCode 10600) — 2026-08-05

Features:

- Settings → About Ivy screen (version, build date, licenses — generalizes
  the former Licenses screen)

Fixes:

- Dismissing a clip viewer/editor now returns playback to the main player —
  paused, same book, same position. Previously the dismissed clip stayed
  loaded under a dead owner and the media notification could resume it with
  nothing on screen tracking it

## 1.5.0 (versionCode 10500) — 2026-08-04

Features:

- Ivy is now MIT-licensed open source
- Settings → Licenses screen (MIT, dependency notices, GPLv3 text for the
  bundled FFmpeg runtime)

Infra:

- FFmpeg runtime vendored in-repo (termux-packages build, arm64-v8a);
  youtubedl-android dependency and all yt-dlp traces removed from shipped
  artifacts (GPL compliance + Play-flagging risk, see
  docs/2026-08-04-vendor-ffmpeg.md)
- Builds default to arm64-v8a only — release APK ~85MB (was 237MB)
- Toolkit doctor: per-artifact version name/code, yt-dlp trace scan

## 1.4.2 (versionCode 10402) — 2026-08-04

Fixes:

- Enabling sync now always triggers a first sync (sign-in + remote pull);
  previously nothing fired with an empty outbox, so a fresh device never synced
- Sync status no longer claims "Up to date" before any sync ("Not synced yet")

## 1.4.1 (versionCode 10401) — 2026-08-04

Fixes:

- Google sign-in failed (DEVELOPER_ERROR) in release/Play builds: dropped the
  stale `webClientId` from sign-in config (unused; access tokens come from the
  Android OAuth clients)

Supersedes 1.4.0, which was uploaded to Play but never released.

## 1.4.0 (versionCode 10400) — 2026-08-04

Features:

- Listening history: search by book title/name/artist
- Library: playing indicator on the current book
- Timeline: decorative waveform shape seeded per book

Infra:

- Unified toolkit CLI (`script/toolkit.ts`) replacing script/*; ffmpeg closure check moved from build gate to `doctor`
- Native: lazy BaseReactPackage, strip skipped on vendored prebuilts (build warning cleanup)
- Website restyle (screenshots, header, store buttons) + README rework

## 1.3.0 (versionCode 10300) — 2026-07-28

Features:

- Sleep timer with volume fade
- Book details: viewer/editor dialog, metadata extras (narrator, summary, series, ...) extracted + editable + synced
- Clip creation through draft editor; linked bounds mode (playhead pushes selection), toggle remembered
- Timeline: smooth playback follow, tap-to-skip, redesigned pin handles, remaining-time display
- Long-press copy everywhere (title/author, book details, clip note/transcription)
- Delete-original-after-import setting
- Transcription: 3 minute cap with truncation marker
- Clip sharing uses friendly filename
- Clips survive book loss (title/artist snapshot)
- UI: outline/filled button system, richer session histogram, stronger deletion warnings
- Logo recolor to theme green
- Foreground refresh fixes (position, timeline redraw)

Infra:

- Sync payload versioning; extras in backups
- ffmpeg runtime repair + build-enforced closure check
- Maestro e2e suite, maestro build variant, Play Store screenshot pipeline
- Website + Play listing assets

Note: a `release: bump version to 1.2.0` commit exists in this range but 1.2.0
was never built, tagged or shipped — this release supersedes it.

## 1.1.2 (versionCode 2)

Last release before this log existed. See git history up to tag `v1.1.2`.
