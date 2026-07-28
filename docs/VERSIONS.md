# Version History

Release log: one section per shipped version, newest first. Record versionName,
versionCode and the user-facing changeset. Update as part of release preparation
(see CLAUDE.md "Preparing a Release").

## 1.3.0 (versionCode 3) — 2026-07-28

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
