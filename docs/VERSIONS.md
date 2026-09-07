# Version History

Release log: one section per shipped version, newest first. Record versionName,
versionCode (derived from semver: major\*10000 + minor\*100 + patch, see
`plugins/withIvyVersionName.js`) and the user-facing changeset. Sections are
written by `bin/ivy.ts prepare` from its `--changes` argument (see CLAUDE.md
"Preparing a Release") — the agent drafts that markdown in this file's style
(Features/Fixes/Infra headings as applicable).

## 1.6.5 (versionCode 10605) — 2026-09-07

Features:

- Play at the end of a book or clip restarts it from the top (on-screen button
  and media key alike) instead of resuming into silence
- Clip viewer always plays the clip's own audio, with the main player's timeline
  look: playback ends where the clip does (it used to run on into the book),
  and the surrounding book is the editor's job

Fixes:

- Player timers: remaining time now ticks in lockstep with the current
  position (they drifted apart at speeds other than 1x)
- Settings: inline links ("Sync now", "Retry") and error labels sit on the
  same baseline as the text beside them
- Single-button headset and Bluetooth play/pause keys now toggle playback

Infra:

- Release, preview and maestro builds are minified and obfuscated by R8;
  the mapping ships alongside release artifacts and artifact checks verify
  the kept native modules
- Toolkit: `state`, `drive --seek/--play/--pause`, tree fallback while
  playing, flow screenshot collection, bridge model server for transcription
  e2e, help gains workflow/recipes/gotchas
- E2e: transcription inference, playback integration (media key, background,
  cold restart, finished-track restart), clip viewer play-through

## 1.6.4 (versionCode 10604) — 2026-09-04

Fixes:

- Clip audio on Drive always keeps its m4a name: the invariant is enforced
  at upload, so renames and re-uploads can no longer leave stale names
- Transcription metered gate hardened: failed connectivity checks no longer
  pass as Wi-Fi, and concurrent download starts are prevented
- A partially-applied bootstrap migration no longer wedges the app: the
  database recovers and migrations rerun cleanly
- Initialization failures now surface a toast instead of failing silently

Infra:

- Toolkit: repo hygiene test (bans tracked debug dumps), upgrade-test hook
  for migration 12, maestro APK stashed across release prebuild
- Dead code trimmed (unused metadata/file-service methods, dead retry delay)
- Docs: correction pass across all guides, READMEs and CLAUDE.md

## 1.6.3 (versionCode 10603) — 2026-09-03

Fixes:

- Out-of-memory crashes from oversized cover art eliminated: extracted
  artwork is capped at 512px, and a repair migration downscales artwork
  stored by earlier versions (undecodable artwork is dropped), with the
  repaired covers syncing across devices
- Transcriptions are no longer wrapped in stray quotes: new results are
  stripped at the source and existing ones cleaned up by a migration
- Opening a book no longer flashes "Playing" in the library before playback
  actually starts

Improvements:

- Transcription model download waits for Wi-Fi on metered connections, with
  a "Download now" override and matching status everywhere (clips banner and
  Settings, including the retry countdown)
- Transcription status banner restyled (amber warning treatment, clearer
  content)
- Settings screen restyled with descriptive state subtitles
- Library progress text is green only for in-progress books
- Books load faster (duration polled at 25ms during load)

Infra:

- Migration system unified as async with injected native services;
  the database is snapshotted before pending migrations run
- Device-level upgrade smoke test (test --upgrade): previous release
  installed, seeded, upgraded and verified with per-migration hooks — runs
  inside prepare, with upgrade-base APKs cached per release
- prepare bumps the version before building, so every tested artifact is
  version-identical to the released pack (commit still gated on tests)
- Standard debug keystore committed for self-contained tag checkouts
- E2e: bridge server for mid-flow device control, transcription-states and
  artwork-cap flows, whisper download suppressed during flows

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
