# Clip Editor: Playhead Motion During Handle Drags

**Status: analysis — not decided.** Evaluates whether decoupling the playhead
from the frozen timeline during handle drags is worth building.

## Current Behavior (verified)

Handle drag and playback follow are mutually exclusive by design
(`engine.ts`, `_isPlaybackFollowing()` requires `_draggingHandle === null`):

- Grabbing a handle while audio plays works; the timeline freezes for the
  drag's duration. Audio keeps playing.
- On release, follow resumes; external position drift folds in (≤ 2s) or
  snaps (> 2s), producing a jump.
- The whole system rests on one invariant: **playhead ≡ screen center ≡
  `_xt(scrollOffset)`**. Draw, `onSeek`, follow, linked push, drift, and
  display position all derive from it.

## Proposal

During handle drag while playing: keep scroll frozen (content must not move
under the user's fingers), but advance the playhead independently. Playhead
may leave the screen. On release, scroll snaps to the playhead and the
invariant is restored.

## Is It Good? The Case For

1. **Honest time display.** Today the time counter freezes during a drag
   while audio runs on. With a live playhead clock, it counts in real time.
2. **Fixes a latent linked-mode bug.** Today, releasing a handle after audio
   ran ahead triggers a drift snap, whose forward sweep
   (`setExternalPosition` → `_pushSelection`) can carry the end anchor past
   the position the user just deliberately set. With a playhead that never
   re-sweeps (it was at the live position all along), the user's placement
   survives. This is the strongest concrete argument.
3. **Model honesty.** The playhead claims to represent playback; freezing it
   while audio plays is a small lie. Users adjusting bounds mid-playback see
   where the audio actually is and can account for it.

## The Case Against

1. **Visual payoff is tiny.** ClipEditor's timeline has no zoom: ~5px/s
   playhead speed. A typical 3s handle drag moves the playhead ~15px — and
   the release jump it eliminates is equally ~15px. The motion itself is
   nearly invisible; only the time counter and release semantics are.
2. **Breaks the core invariant.** A second clock (`_playheadTime`) exists
   only during handle-drag + playing. Every derived behavior needs auditing:
   draw, drift routing, display position, tick loop lifetime, linked push.
3. **Dents the "solid playhead" story.** In linked mode the playhead pushes
   anchors; during a drag it would visually pass through them without
   pushing (handle drag owns the selection — keeping that rule is the sane
   choice). A transient exception to a rule users just learned.
4. **Rare situation.** The linked core workflow (scrub → play → pause at
   end) does handle work mostly while paused. Mid-playback handle drags are
   an edge of an edge.

## Alternatives

- **A. Full decouple (the proposal).** One truthful playhead.
  ~40 engine lines + small hook/draw changes; engine is pure →
  unit-testable. Costs: invariant break, linked-semantics exception.
- **B. Ghost marker.** Main playhead stays frozen/coupled; a thin secondary
  marker shows the live position. No invariant break — drawing plus a
  clock. But: two playheads, and it inherits none of A's release-semantics
  fix. Most of A's drawing work without its cleanup — awkward middle.
- **C. Status quo.** Jumps are ~15px, drags are short. Cheapest.
- **D. Fix only the retro-push bug.** Suppress `_pushSelection` on the
  first post-drag drift snap (a one-line-ish guard). Captures argument #2 —
  the strongest one — without the second clock. Loses the live counter.

## Implementation Sketch (if A)

- Engine: on handle grab while playing, `_playheadTime = _xt(scrollOffset)`;
  new tick branch advances it (dt × rate + drift fold); `setExternalPosition`
  routes drift to the playhead clock during drag instead of early-returning.
- Release: `scrollOffset = _tx(playheadTime)`, clear, follow resumes. Snap —
  no animation needed at these distances.
- Hook: `scheduleTick` also on `tap.onBegin` (playhead animation can start
  at touch-down); expose `playheadTimeRef`.
- Draw: `playheadX = playheadTime ?? scrollOffset` — draw code already
  parameterizes playheadX; off-screen is free (clipping).
- Linked rule: pushes disabled during drag (unchanged); sweep resumes from
  the playhead's live time on release — no retroactive sweep.

## Recommendation

The feature's headline (moving playhead) is worth little at 5px/s; its real
value is the release-semantics fix and the live counter. If that fix alone
justifies a change, **D** delivers it at a fraction of the cost. Choose **A**
only if the honest-playhead model is valued for its own sake (e.g. zoom may
come to the editor later, making the motion visible). **B** is not
recommended.
