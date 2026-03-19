# Documentation Audit — 2026-03-18

Full verification of AGENTS.md and all docs/ guides against the codebase.

## Changes Made

**AGENTS.md** — Added `finalizeSession` to the actions list. It's an internal action (not exposed on AppState) used by the store's `onAudioStatus` handler to close sessions when playback stops. It was the only action missing from the documented list.

**docs/PLAYBACK.md** — Fixed the `play()` documentation. It claimed two modes: "resume (no context)" and "play with context." In reality, `play()` always requires a `PlayContext` parameter (`{ fileUri, position, ownerId }`). There is no resume-without-context mode.

**docs/SYNC.md** — Fixed references to clip audio format. The "What gets synced" section and "Clip upload safety" section both said "MP3", but clips are actually `.m4a` (the native slicer always outputs MPEG-4). Legacy clips may use `.mp3`, which the rest of the doc already acknowledged.

## Everything Else: Verified Accurate

- **File structure** — every file listed in AGENTS.md exists; no significant files missing
- **Database schema** — all 8 tables match exactly
- **Store types** — AppState interface matches all documented fields
- **All 29 actions** — exist and are wired correctly
- **Constants** — SKIP_FORWARD_MS, SKIP_BACKWARD_MS, DEFAULT_CLIP_DURATION_MS, MIN_SESSION_DURATION_MS, CLIPS_DIR all match
- **Utilities** — generateId, MAIN_PLAYER_OWNER_ID, formatTime, formatDate, throttle all present
- **Books system** — loading pipeline, fingerprinting, three cases, archive/delete/restore all accurate
- **Clips system** — creation, editing, deletion, sharing, source fallback all accurate
- **Transcription** — Whisper model, queue, audio conversion, 10s limit all accurate
- **Sessions** — tracking, 5-minute window, 1s cleanup, finalization all accurate
- **Sync system** — queue, manifest, planner, merge strategies, Drive storage, auth all accurate
- **Tech stack versions** — React Native 0.81.5, Expo ~54.0.30 (docs say "54" which is fine)

## Candidates for Removal

These sections are accurate but take up space without helping agents write code:

### 1. docs/BOOKS.md "File Fingerprinting" section (lines 146-170)
Repeats what's already explained in "Adding a Book" and the AGENTS.md quick summary. The "Why first 4KB?" subsection is design rationale that doesn't inform implementation.

### 2. docs/PLAYBACK.md "The Event Loop" (lines 223-264)
Full ASCII step-by-step walkthrough of things already explained in prior sections. An agent can trace the code directly.

### 3. docs/PLAYBACK.md "The Timeline Component" (lines 325-385)
Very detailed (bar widths, physics constants, three-layer painting). Unless the agent is modifying the timeline, this is noise. The timeline rarely changes.

### 4. docs/SESSIONS.md "The 5-Minute Window" example timeline (lines 140-150)
The concept is already clear from the preceding explanation. The example adds 10 lines for something straightforward.

### 5. docs/SYNC.md "The Planner" pseudocode (lines 233-266)
Repeats in prose what the pure function does. An agent working on sync will read planner.ts directly; the pseudocode is an intermediate representation that can drift.

### 6. All "Table of Contents" sections across all 6 docs
10-13 lines each. Markdown renderers auto-generate TOCs, and agents don't navigate by clicking anchors.

### 7. docs/TRANSCRIPTION.md "Audio preparation" subsection (lines 126-134)
Extremely detailed WAV encoding steps (float32-to-int16 scaling, 44-byte header). Only relevant if changing the Whisper integration, which is rare.
