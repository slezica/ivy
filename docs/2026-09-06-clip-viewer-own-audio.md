# Clip viewer always plays the clip's own audio

**Date:** 2026-09-06

## Problem

Clips overplayed: audio kept going after the clip's end. Reported as "some sound is heard after end".

The viewer played the *source book* whenever it was available, with the clip's range highlighted on the full-book timeline, and stopped by watching the playhead: `position >= clipEnd → pause()`. The playhead is fed by track-player progress events at 1 Hz, so the stop fired 0–1000 ms late (plus the pause round-trip). Up to a second of book audio past the clip, every time, and the playhead was drawn past the end handle afterwards.

The same design also let the user play anywhere in the book from the clip viewer, which turned out to be confusing rather than useful.

## Decision

The viewer always plays the clip's own `.m4a` (already the fallback path for archived books). Consequences:

- The timeline is the clip, styled like the main player (grey played / green remaining, time labels on top; tap-to-seek, no skip taps).
- Playback ends where the file does. No end-watching logic; play with the playhead parked at the end restarts from the top.
- Listening to the surrounding book is the editor's job: it still plays the source book (expansion needs it), and "go to source" hands the book to the main player at the clip's start.
- Nothing changes for archived books — the viewer behaves the same with or without the source.

## Rejected alternatives

- **Timer-armed stop** (`setTimeout` for the remaining time on each progress event, then pause + seek to the end): fixes the overplay to ~tens of ms but keeps the "play the whole book from a clip" UX, which was the deeper problem.
- **Faster progress events** (`progressUpdateEventInterval: 0.1`): 10 Hz store ticks app-wide, undoing the 1 Hz battery work for a viewer-only concern.
- **Clip-file playback drawn on the book timeline** (offset mapping): exact end plus book context, but a new position-mapping layer for context the editor already provides.
