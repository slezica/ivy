# Linked Clip Bounds ("bounds follow playhead")

## Core Idea

The clip editor's core friction: listening and adjusting bounds are separate
gestures. Play, listen, pause, drag handle, replay to verify, repeat.

This feature links the two. A **link toggle** (lower right of the editor,
default on) makes the playhead **solid**: any playhead movement pushes the
selection anchors it collides with — like Photoshop's width/height link.

Target workflow: scrub to the start point (anchors get pushed into place),
hit play, pause where the clip should end. Listening *is* delimiting.

## The Rule

**Link down = playhead is solid; any playhead movement sweeps anchors along.**

One rule, no per-source exceptions:

- Applies identically to drag, fling momentum, tap-to-seek animation, and
  playback follow. Playback pushing the end anchor forward falls out
  naturally — no special case.
- Sweep semantics: an anchor inside the interval the playhead just traveled
  gets carried to the playhead's new position.
- Minimum-duration rod: when a push would compress the selection below
  `MIN_SELECTION_DURATION`, the partner anchor is pushed too — both move,
  keeping the min gap. Visually intuitive: handles collide, then travel
  together.
- Clamped to `[0, duration]` at the timeline edges.
- Toggling the link never moves anchors by itself; only subsequent movement
  does. Anchors the playhead already passed while unlinked are not affected
  (no contact — out of the swept path).

`MIN_SELECTION_DURATION` rises from 1s to **4s**: the distance at which the
24px handle circles stop overlapping at the editor's fixed zoom. Sub-4s clips
don't make sense for audiobooks (context matters). Existing shorter clips
still open fine; the first interaction enforces the new minimum.

## Rejected Alternatives

- **End anchor teleports to playhead on play** — guarantees "pause = clip
  end" even when playing inside the selection, but destroys bounds when the
  user just wants to listen to a middle section. Surprise outweighs the win.
- **Exempting tap-to-seek from pushing** — taps animate through the timeline
  anyway; exempting them adds a rule and a surprise. Toggle the link up for
  free movement instead.

Known trade-off of the pure push model: pausing *before* the old end anchor
leaves it untouched (shrinking isn't automatic). Recovery is cheap — scrub
forward past the anchor, then back to the pause point; it rides the playhead.

## Implementation

### Selection ownership (the one subtle part)

Today the engine treats `_selection` as React-owned: handle drags emit
`onSelectionChange`, React state echoes back via `updateSelection()`. Pushing
breaks this: during playback the engine mutates the selection every frame,
and a stale React echo would drop an anchor out of the playhead's swept path
— sweep contact would never recover it.

Fix: while linked pushing is possible (handle drag, scroll motion, or
playback active), the engine is authoritative and `updateSelection()` ignores
prop echoes. Emissions are throttled like display position (50ms), with
forced emits at motion endpoints (pan end, momentum/animation finalize,
pause, external snap) so React always converges to the final value.

### Phases

1. **Engine** (`timeline/engine.ts` + tests)
   - `MIN_SELECTION_DURATION` → 4000 (`constants.ts`).
   - `linked` config + `setLinked()`.
   - `_pushSelection(prevTime, newTime, now)` called from every scroll-offset
     mutation: pan scroll, momentum tick, animation tick, playback tick,
     external snap. Pinch is excluded (zoom preserves time).
   - Throttled `_emitSelection()` with forced emits at motion endpoints.
   - `updateSelection()` lock while pushing is possible.
2. **Plumbing** (`useTimelinePhysics.ts`, `Timeline.tsx`)
   - `linkedSelection?: boolean` prop, forwarded to the engine. Timeline
     gains no logic — same altitude as `canZoom`/`tapSkip`/`playbackRate`.
3. **Editor UI** (`ClipEditor.tsx`)
   - `linked` state, default `true` on every open.
   - Link IconButton at the lower right of the play-button row: filled
     `link` icon on primary background when down, `link-outline` on muted
     background when up.
4. **Docs** — CLIPS.md editing section.

### Testing

Engine unit tests (deterministic, no device): forward/backward sweeps for
each anchor, rod compression both directions, edge clamps, playback-follow
push, tap-animation push, no-push when unlinked or out of path, echo lock,
emission throttling and forced endpoint emits.
