# Detached Playhead + Full-Height Handle Grab

Two clip-editor timeline fixes, one architectural shift.

## Problems

1. **Handles hard to grab.** Hit-test was a 24px circle around the pin center
   (mid-height). The visual handle is a full-height line plus pin — touches on
   the line above/below the pin missed and started a scrub instead.

2. **No playback indication while adjusting handles.** A handle drag froze the
   timeline (correct — autoscroll off), but the playhead is drawn at the frozen
   center, so playing audio had no visual position. On release, the accumulated
   drift exceeded the snap threshold and the timeline jumped.

## Fixes

### Full-height hit columns

`_getHandleAtPosition` now tests horizontal distance only: a full-height column
`HANDLE_TOUCH_RADIUS` (24px) to each side of the pin center. The line sits
within the column (`HANDLE_PIN_OFFSET` 16 < 24). Closer-handle-wins preserved
for narrow selections.

Trade-off (accepted): a scrub can no longer start on top of a handle column.
Scrubbing is relative, so starting elsewhere costs nothing.

### Playhead time as first-class state

Previously `playheadX = scrollOffset` — the playhead *was* the center. Now the
engine tracks `_playheadTime` separately:

- **Attached motion** (drag, momentum, tap animation, playback follow,
  external snap): scroll moves via `_scrollTo()`, playhead rides the center.
  Identical to old behavior.
- **Detached follow** (handle drag while `playbackRate > 0`): scroll frozen,
  playhead alone advances across the frozen bars — the missing indication. It
  may exit the viewport; it reappears as the scroll catches up.
- **Release**: playback follow decays the playhead↔center gap exponentially
  (same time constant as drift folding), gliding the playhead back to center.
  Replaces the old post-release snap jump. No extra state: the gap is measured
  from `_playheadTime - xt(scrollOffset)` each tick.

Linked pushes are now driven by **playhead motion**, not scroll motion
(equivalent when attached). Consequences:

- A detached playhead pushes the un-dragged anchor live, during the drag.
- The dragged anchor is exempt — the finger wins (`_draggingHandle` checked
  per-anchor in `_pushSelection`, no longer a blanket skip).
- Catch-up moves only the scroll → no re-push burst after release.

Drawing reads the playhead via `playheadTimeRef` (hook), same pattern as
`selectionRef`.

## Rejected alternatives

- **Pause audio on handle grab.** Simplest, but kills audition-while-trimming —
  hearing playback continue is the point of adjusting bounds live.
- **Clamp detached playhead at viewport edge.** Extra state and drawing logic
  for a rare case; exiting and re-entering reads fine.
- **Separate `_recenterLag` state for catch-up.** Deriving the gap per tick is
  equivalent and stateless.
