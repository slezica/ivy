# Timeline Selection Feature

## Overview

Add clip length editing capability using a new `SelectionTimeline` component. Users will be able to drag selection handles to adjust clip start/end times while previewing playback.

**Context:** The current `TimelineBar` component (`src/components/TimelineBar.tsx`) is a GPU-accelerated Skia canvas with center-fixed playhead and momentum scrolling. It's 670 lines and tightly coupled to playback mode behavior.

**Decisions:**
- Extract shared code into `src/components/timeline/` module
- Create two focused components: `PlaybackTimeline` (refactored current) and `SelectionTimeline` (new)
- Selection handles: vertical lines with yellow draggable circles at bottom
- Selected bars painted yellow; no played/unplayed distinction in selection mode
- Playhead moves with playback position in selection mode (not center-fixed)
- Minimum 1 second between selection handles; handles cannot cross
- Tap-to-seek works in both modes
- No auto-sync to playback position in selection mode

**File structure:**
```
src/components/timeline/
├── constants.ts           # Dimensions, physics, timing
├── utils.ts               # timeToX, xToTime, clamp, getSegmentHeight
├── useScrollPhysics.ts    # Momentum/scroll hook (configurable)
├── PlaybackTimeline.tsx   # Playback mode (refactored from TimelineBar)
├── SelectionTimeline.tsx  # Selection mode (new)
└── index.ts               # Barrel exports
```

**Testing:** Follow TDD. All tests passing at end of each phase.

## Phases

### Phase 1: Extract Shared Code

Shared utilities extracted into `timeline/` module. Existing `TimelineBar` refactored to import from shared module. All current functionality preserved.

**End state:** `TimelineBar` works exactly as before, but imports constants/utils/hook from new module.

**Key requirements:**
- `constants.ts`: All dimension, physics, and animation constants
- `utils.ts`: Coordinate conversion, segment height calculation, precomputed heights array
- `useScrollPhysics.ts`: The scroll/momentum hook with configurable auto-sync behavior
- No breaking changes to existing behavior

**Integration contract for Phase 2:**
```typescript
// useScrollPhysics options
interface UseScrollPhysicsOptions {
  maxScrollOffset: number
  containerWidth: number
  duration: number
  externalPosition: number
  onSeek: (position: number) => void
  autoSyncToPosition?: boolean  // NEW: default true for playback, false for selection
}
```

---

### Phase 2: Create PlaybackTimeline

Rename `TimelineBar` to `PlaybackTimeline`. Update all imports. Maintain backward compatibility via re-export.

**End state:** Component renamed, all existing imports work, no functional changes.

**Key requirements:**
- Rename component file to `PlaybackTimeline.tsx`
- Export `PlaybackTimeline` as default from `timeline/index.ts`
- Re-export as `TimelineBar` for backward compatibility (or update all imports)
- Update imports in `PlayerScreen.tsx` and anywhere else it's used

---

### Phase 3: Create SelectionTimeline

New component for clip length editing with draggable selection handles.

**End state:** `SelectionTimeline` component complete with selection handles, movable playhead, and all gestures working.

**Key requirements:**
- Playhead renders at playback position (not center-fixed), can scroll out of view
- Two selection handles (vertical lines) at `selectionStart` and `selectionEnd`
- Yellow draggable circles at bottom of each handle (sized for touch targets)
- Bars within selection range painted yellow; bars outside painted primary color
- Pan on timeline area scrolls view (reuse momentum physics, no auto-sync)
- Pan on handle circles drags that selection edge
- Handles cannot cross; minimum 1 second apart
- Tap on timeline seeks to that position
- Time indicator shows current playback position (centered below, same as playback mode)

**Component contract:**
```typescript
interface SelectionTimelineProps {
  duration: number
  position: number
  selectionStart: number
  selectionEnd: number
  onSelectionChange: (start: number, end: number) => void
  onSeek?: (position: number) => void
  showTime?: 'top' | 'bottom' | 'hidden'
}
```

**Drawing logic:**
- No played/unplayed distinction—only selected vs unselected
- Selection handles and circles drawn after bars (on top)
- Playhead drawn on top of everything
- Handle circles should be ~24-32px diameter for comfortable touch targets

**Gesture handling:**
- Detect touch on handle circles (hit testing with reasonable touch radius)
- During handle drag: clamp to valid range (1s minimum, cannot cross other handle)
- Pan anywhere else scrolls the timeline

---

### Phase 4: Integration

Wire `SelectionTimeline` into clip editing UI.

**End state:** Users can edit clip length via the selection timeline in the clip edit dialog.

**Key requirements:**
- Add `SelectionTimeline` to clip edit modal/dialog
- Pass clip's current start/duration as initial selection
- Handle `onSelectionChange` to update clip bounds
- Handle `onSeek` for playback preview
- Playback controls to let user preview the clip

---

## Notes for Implementer

- The current `TimelineBar` has excellent documentation in its header comment—preserve this pattern
- Segment heights are precomputed for performance; keep this optimization
- Handle momentum physics carefully—the RAF loop and ref-based state are intentional for 60fps
- Selection handle hit testing needs generous touch radius (finger is ~44px)
