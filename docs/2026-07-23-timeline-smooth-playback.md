# Timeline Smooth Playback Follow

## Problem

During playback the timeline advanced only when TrackPlayer reported progress
(`progressUpdateEventInterval: 1`): one 6 px teleport per second. At 1 s/bar
granularity the stepping is prominent — playback feels clunky next to the
perfectly smooth drag/fling scrolling.

## Core Idea

The timeline animates its own motion instead of waiting for position events.

- `Timeline` takes a `playbackRate` prop (0 = paused). One prop; no separate
  `isPlaying`.
- While rate > 0 and the engine is idle, a **playback follow** sub-tick in
  `TimelinePhysicsEngine` advances the scroll offset by `dt × rate` per frame
  on the existing rAF loop (the same fast path momentum uses).
- The 1 Hz TrackPlayer event is demoted from motion source to **drift
  correction**:
  - |drift| ≤ 2 s (`DRIFT_SNAP_THRESHOLD`): folded in exponentially, ~95%
    within 1 s (`DRIFT_FOLD_WINDOW`) — invisible.
  - |drift| > 2 s: an external seek (notification buttons, another device) —
    snap.
- Playback follow never fires `onSeek`; the audio player is the source of
  truth. (Momentum and tap-to-seek still commit seeks — those are user
  intent.)

## Why Not Alternatives

- **Raising the event rate** (10–60 Hz through store → React props): still
  steppy at event granularity, floods React with re-renders.
- **Unifying with momentum physics**: superficial fit only. Momentum decays,
  terminates below `MIN_VELOCITY` (30 px/s — playback moves at 6 px/s, below
  the floor), ends with a seek, and blocks external updates. Playback follow
  is constant-rate, endless, seekless, and consumes external updates.
  Separate ~30-line sub-tick sharing the loop/dt infrastructure.

## Interaction Rules

- Drag, handle drag, and pinch suspend following (`_isPlaybackFollowing`);
  it resumes automatically after release (momentum keeps the tick loop alive
  and returns it to follow when exhausted).
- Motion clamps at the timeline end.
- Paused (`rate === 0`): external positions snap immediately, as before.

## Wiring

- `PlayerScreen`: `playbackRate={isPlaying ? book.speed / 100 : 0}`
- `ClipViewer`/`ClipEditor`: `playbackRate={isPlaying ? 1 : 0}` (clip
  playback is always 1× — see `load_book.ts` `applyRate`)
