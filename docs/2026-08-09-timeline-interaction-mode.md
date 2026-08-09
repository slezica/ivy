# Timeline Engine: Interaction Mode Union

**Status: implemented.** Replaces the engine's parallel interaction flags
with a single discriminated union, fixing a state-leak bug and making its
whole class unrepresentable.

## The bug

Field report: while editing a clip during playback, after a handle drag the
timeline glided to the playhead, then playhead + timeline + audio teleported
back in time.

Root cause: `touchDown` (tap onBegin) and `panStart` (pan onStart) hit-tested
the selection handle **independently**, with different x — the finger travels
~10px before pan activation. When touchDown hit but panStart missed, panStart
started a scroll drag while the handle drag was armed: `_isDragging` and
`_draggingHandle` both set. `panUpdate` preferred the handle branch (the edit
looked normal), but `panEnd`'s handle branch returned early and `_isDragging`
leaked true forever. The engine stayed `isActive`: playback follow and
external position sync blocked (frozen timeline), and the next scrub's
`onSeek` fired with the stale frozen scroll center — seeking audio seconds
into the past.

The miss is common in practice: the hit column is pin center ±24px, the
handle line sits 16px inside the pin, so a grab **by the line** dragging
inward (shrinking) has an 8px budget — less than the ~10px pan activation
slop. Re-grabbing during the post-release glide also triggers it.

## The fix

`src/components/timeline/engine.ts` — one `InteractionMode` union replaces
`_isDragging`, `_dragStartOffset`, `_draggingHandle`, `_handleDragStartValue`,
`_hasMomentum`, `_velocity`, `_animation`, `_emaVelocity`, `_lastDragSample`:

```
idle | scrollDrag | handleDrag | momentum | animation
```

- Per-mode data rides in the variant; dropping a mode drops its data. The
  leaked combination (scroll drag + handle drag) is unrepresentable.
- **panStart honors a handle drag armed at touchDown** — never re-hit-tests.
  touchDown's `startValue` capture stays exact: the dragged anchor cannot
  move between touchDown and panStart (prop echoes locked out, linked pushes
  exempt the dragged anchor), and RNGH translations are measured from the
  activation point (`PanGestureHandler.activate()` calls `resetProgress()`),
  so they pair with any capture taken while the anchor was stationary.
- Two mode categories: **finger-held** (scrollDrag, handleDrag) cleared by
  `touchUp` — the guaranteed finalizer, which also flushes pending throttled
  selection emits; **ballistic** (momentum, animation) survive `touchUp`
  (pan.onEnd sets them right before pan.onFinalize fires) and end in their
  tick's finalize or when the next touchDown brakes them.
- Stays **outside** the union: playback follow (orthogonal continuous state —
  composes with modes: detached follow runs during handleDrag); pinch (runs
  Simultaneous with pan, so pinching mid-drag is legal; the cooldown is a
  time-window, not an event-cleared state); `_suppressTap` (a memo about the
  current touch's intent, must survive touchUp, rewritten by every touchDown).

Side effect of honor-armed: with a tiny selection, a grab on handle A whose
slop travel ends in handle B's column used to switch handles at activation;
now the touchDown grab wins. Deliberate — grab stability.

## Scenario tests

`src/components/timeline/__tests__/scenarios.test.ts` drives full flows
against a ground-truth audio model (1 Hz stale position events, like the
app). Universal invariants: the engine settles back to inactive after every
gesture, and follow re-converges onto ground truth. Includes a seeded fuzz
over random gesture interleavings. The bug above was encoded as `it.failing`
tests first (red), then fixed (green) — use that convention for future bugs.

## Rejected alternatives

- **Formal statechart / FSM library**: playback follow and pinch are
  orthogonal-continuous, not modes — a flat FSM misfits, parallel-region
  statecharts add a dependency and ceremony for one file.
- **Pinch as a union variant**: pinching during a scroll drag is reachable
  (Simultaneous gestures) — a slot would make a legal combination
  unrepresentable.
- **One-line fix only** (panStart early-return): fixes this leak, leaves the
  flag pairs representable — the cancelled-pan variant of the same leak
  (onFinalize without onEnd) needed the same structural change.

## Deferred findings (triage later)

Real issues found during design review, out of scope here:

- **Fling-grab abandons the fling position**: touchDown's handle branch stops
  momentum/animation without `onSeek`, unlike the brake branch — audio stays
  at the pre-fling position until an external event reconciles (snap if >2s).
  Two paths disagree about whether stopping ballistic motion commits.
- **Zoom mid-handle-drag jumps the anchor**: pinchUpdate rescales segment
  width while panUpdate's `_xt(translationX)` converts the whole accumulated
  translation at the new scale. Clip editor only (needs canZoom + selection).
- **Mid-pinch external snap**: `setExternalPosition` is not blocked while
  pinching (pinch is not part of `isActive`) — a 1 Hz position event during a
  pinch on a playing timeline snaps the scroll under the user's fingers.
- **rAF liveness during pinch+playback**: `_isPlaybackFollowing` is false
  while pinching, so the tick loop dies; recovery relies solely on
  pan.onFinalize's `scheduleTick`. Works, single point of failure.
- **Test debt**: the fuzz never pinches; the scenario driver's
  `fromTranslation` convention models RNGH translations as touch-relative —
  they are activation-relative (harmless to current assertions).
