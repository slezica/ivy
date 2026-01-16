# Timeline Component Specification

## Overview

`Timeline` is a unified, GPU-accelerated audio timeline component that replaces both `PlaybackTimeline` and `SelectionTimeline`. It renders a scrollable bar visualization with a center-fixed playhead, supporting both playback progress display and range selection.

**Location:** `src/components/timeline/Timeline.tsx`

## Rationale

### Why Unify?

The existing `PlaybackTimeline` and `SelectionTimeline` share ~80% of their code:
- Same gesture handling (pan, tap, momentum)
- Same scroll physics
- Same component structure (canvas, playhead overlay, time indicators)
- Same segment calculation and visibility culling

They differ only in:
- Bar coloring logic (played/unplayed vs selected/unselected)
- Selection handles (present only in SelectionTimeline)

A unified component eliminates duplication and provides a cleaner mental model.

### Why Color Props?

Instead of mode-based rendering (`mode: 'playback' | 'selection'`), we use explicit color props:

```typescript
leftColor: string    // bars (or portions) left of playhead
rightColor: string   // bars (or portions) right of playhead
selectionColor?: string  // overrides both within selection range
```

This is more flexible and self-documenting. The caller describes what they want visually, not which internal mode to use.

## Rendering Theory

### The Stencil + Paint Layers Approach

Traditional approach (per-bar rendering):
```
For each visible bar:
  For each color segment in bar:
    Clip canvas to segment region
    Draw bar shape
```
This is O(bars × segments) draw operations.

**New approach (stencil + layers):**
```
1. Build ONE path containing all visible bar shapes (the "stencil")
2. Draw the path 2-3 times with different clip regions (the "paint layers")
```
This is O(bars) path operations + 3 draw operations.

### How It Works

```
Step 1: Build stencil path
─────────────────────────
    ██  ██  ████  ██  ██████  ██  ██  ████  ██
    (one Path object containing all bar RRects)

Step 2: Draw layers with clips (painter's algorithm)
────────────────────────────────────────────────────

Layer 1 - leftColor, clipped to [start, playhead]:
    ██  ██  ██|
              │ ← clip boundary at playhead

Layer 2 - rightColor, clipped to [playhead, end]:
              |██  ██████  ██  ██  ████  ██
              │

Layer 3 - selectionColor, clipped to [selStart, selEnd]:
                  |████      |
                  │          │ ← selection boundaries
                  (overwrites layers 1 & 2)

Final result:
    ██  ██  ██  ████  ██████  ██  ██  ████  ██
    ├──left───┤├─sel─┤├────────right────────┤
```

The painter's algorithm (draw back-to-front) naturally handles selection overriding the base colors.

### Partial Bar Coloring

Because clips are applied to the entire path, bars that straddle boundaries are automatically split:

```
Bar spanning 0-30s, playhead at 5s, selection 12-22s:

    ╭──────────────────────────────────────────╮
    │ left │  right  │ selection │    right   │
    ╰──────────────────────────────────────────╯
           5         12          22
```

Each "segment" of the bar receives the correct color based on which clip region it falls within. This happens automatically - no per-bar segment calculation needed.

### Performance Characteristics

| Aspect | Value |
|--------|-------|
| Path build | O(visible bars) - ~50-100 `addRRect` calls |
| Draw calls | Fixed: 2-3 regardless of bar count |
| Overdraw | Selection region painted 2-3× (negligible) |
| Memory | One Path object (~few KB for 100 bars) |

## API

```typescript
interface TimelineProps {
  // === Core (required) ===
  duration: number              // Total duration in milliseconds
  position: number              // Current playback position in milliseconds
  onSeek: (position: number) => void  // Called when user seeks

  // === Bar Colors (required) ===
  leftColor: string             // Color for bars/portions left of playhead
  rightColor: string            // Color for bars/portions right of playhead

  // === Selection (optional) ===
  selectionColor?: string       // Color for bars/portions within selection
  selectionStart?: number       // Selection start in milliseconds
  selectionEnd?: number         // Selection end in milliseconds
  onSelectionChange?: (start: number, end: number) => void  // Called when handles dragged

  // === Display (optional) ===
  showTime?: 'top' | 'bottom' | 'hidden'  // Time indicator placement (default: 'bottom')
}
```

### Selection Behavior

- Selection handles appear only when all four selection props are provided (`selectionColor`, `selectionStart`, `selectionEnd`, `onSelectionChange`)
- Handles are draggable circles at the bottom of the timeline
- Minimum selection duration: 1 second
- Handles cannot cross each other

### Usage Examples

**Playback mode** (replaces PlaybackTimeline):
```tsx
<Timeline
  duration={player.duration}
  position={player.position}
  onSeek={handleSeek}
  leftColor={Color.GRAY}      // played
  rightColor={Color.PRIMARY}  // unplayed
/>
```

**Selection mode** (replaces SelectionTimeline):
```tsx
<Timeline
  duration={file.duration}
  position={displayPosition}
  onSeek={handleSeek}
  leftColor={Color.PRIMARY}   // same color = no playhead split
  rightColor={Color.PRIMARY}
  selectionColor={Color.SELECTION}
  selectionStart={clipStart}
  selectionEnd={clipEnd}
  onSelectionChange={handleSelectionChange}
/>
```

**Hybrid mode** (new capability):
```tsx
<Timeline
  duration={player.duration}
  position={player.position}
  onSeek={handleSeek}
  leftColor={Color.GRAY}
  rightColor={Color.PRIMARY}
  selectionColor={Color.SELECTION}
  selectionStart={loopStart}
  selectionEnd={loopEnd}
  onSelectionChange={handleLoopChange}
/>
```

## Implementation

### File Structure

```
src/components/timeline/
├── Timeline.tsx          # NEW: Unified component
├── useTimelinePhysics.ts # NEW: Unified physics hook (replaces useScrollPhysics + useSelectionPhysics)
├── PlaybackTimeline.tsx  # KEEP: For reference, deprecated
├── SelectionTimeline.tsx # KEEP: For reference, deprecated
├── constants.ts          # KEEP: Shared constants
├── utils.ts              # KEEP: Shared utilities
└── index.ts              # UPDATE: Export Timeline as primary
```

### Core Drawing Function

```typescript
function drawTimeline(
  canvas: SkCanvas,
  scrollOffset: number,
  containerWidth: number,
  totalSegments: number,
  playheadX: number,
  selectionStartX: number | null,
  selectionEndX: number | null,
  leftPaint: SkPaint,
  rightPaint: SkPaint,
  selectionPaint: SkPaint | null
) {
  const halfWidth = containerWidth / 2
  const visibleStartX = scrollOffset - halfWidth
  const visibleEndX = scrollOffset + halfWidth

  // Calculate visible segment range
  const startSegment = Math.max(0, Math.floor(visibleStartX / SEGMENT_STEP) - 2)
  const endSegment = Math.min(totalSegments, Math.ceil(visibleEndX / SEGMENT_STEP) + 2)

  // 1. Build stencil path with all visible bars
  const barsPath = Skia.Path.Make()
  for (let i = startSegment; i < endSegment; i++) {
    const x = i * SEGMENT_STEP
    const height = getSegmentHeight(i)
    const y = (TIMELINE_HEIGHT - height) / 2
    barsPath.addRRect(
      Skia.RRectXY(Skia.XYWHRect(x, y, SEGMENT_WIDTH, height), 2, 2)
    )
  }

  // 2. Draw placeholder bars (before/after actual content)
  drawPlaceholders(canvas, visibleStartX, visibleEndX, 0, totalSegments * SEGMENT_STEP)

  // 3. Draw stencil with color layers

  // Layer 1: Left of playhead
  canvas.save()
  canvas.clipRect(
    Skia.XYWHRect(visibleStartX, 0, playheadX - visibleStartX, TIMELINE_HEIGHT),
    ClipOp.Intersect,
    true
  )
  canvas.drawPath(barsPath, leftPaint)
  canvas.restore()

  // Layer 2: Right of playhead
  canvas.save()
  canvas.clipRect(
    Skia.XYWHRect(playheadX, 0, visibleEndX - playheadX, TIMELINE_HEIGHT),
    ClipOp.Intersect,
    true
  )
  canvas.drawPath(barsPath, rightPaint)
  canvas.restore()

  // Layer 3: Selection (overwrites layers 1 & 2)
  if (selectionPaint && selectionStartX !== null && selectionEndX !== null) {
    canvas.save()
    canvas.clipRect(
      Skia.XYWHRect(selectionStartX, 0, selectionEndX - selectionStartX, TIMELINE_HEIGHT),
      ClipOp.Intersect,
      true
    )
    canvas.drawPath(barsPath, selectionPaint)
    canvas.restore()
  }
}
```

### Unified Physics Hook

The `useTimelinePhysics` hook consolidates `useScrollPhysics` and `useSelectionPhysics`:

```typescript
interface UseTimelinePhysicsOptions {
  maxScrollOffset: number
  containerWidth: number
  duration: number
  externalPosition: number
  onSeek: (position: number) => void

  // Optional selection support
  selection?: {
    start: number
    end: number
    onChange: (start: number, end: number) => void
  }
}

interface TimelinePhysicsResult {
  scrollOffsetRef: React.MutableRefObject<number>
  displayPosition: number
  frame: number
  gesture: ComposedGesture
}
```

When `selection` is provided:
- Touch detection checks for handle hits before initiating scroll
- Handle drags update selection bounds via `onChange`
- Scroll gestures work normally when not touching handles

### Selection Handles

Handles are drawn as part of the Skia canvas (not React views) for consistency:

```typescript
function drawSelectionHandles(
  canvas: SkCanvas,
  selectionStartX: number,
  selectionEndX: number,
  handlePaint: SkPaint
) {
  const handleTop = 10
  const handleBottom = TIMELINE_HEIGHT - 10
  const circleY = handleBottom + HANDLE_CIRCLE_RADIUS

  // Start handle: vertical line + circle
  canvas.drawRect(
    Skia.XYWHRect(selectionStartX - 1, handleTop, 2, handleBottom - handleTop),
    handlePaint
  )
  canvas.drawCircle(selectionStartX, circleY, HANDLE_CIRCLE_RADIUS, handlePaint)

  // End handle: vertical line + circle
  canvas.drawRect(
    Skia.XYWHRect(selectionEndX - 1, handleTop, 2, handleBottom - handleTop),
    handlePaint
  )
  canvas.drawCircle(selectionEndX, circleY, HANDLE_CIRCLE_RADIUS, handlePaint)
}
```

Canvas height increases when selection is enabled to accommodate the handle circles below the bar area.

### Component Structure

```tsx
function Timeline({ duration, position, onSeek, leftColor, rightColor, ... }: TimelineProps) {
  const [containerWidth, setContainerWidth] = useState(0)
  const hasSelection = selectionColor && selectionStart != null && selectionEnd != null && onSelectionChange

  const { scrollOffsetRef, displayPosition, frame, gesture } = useTimelinePhysics({
    maxScrollOffset: timeToX(duration),
    containerWidth,
    duration,
    externalPosition: position,
    onSeek,
    selection: hasSelection ? { start: selectionStart, end: selectionEnd, onChange: onSelectionChange } : undefined,
  })

  const canvasHeight = hasSelection
    ? TIMELINE_HEIGHT + HANDLE_CIRCLE_RADIUS * 2
    : TIMELINE_HEIGHT

  const picture = useMemo(() => createPicture((canvas) => {
    // Apply scroll transform
    canvas.save()
    canvas.translate(containerWidth / 2 - scrollOffsetRef.current, 0)

    drawTimeline(
      canvas,
      scrollOffsetRef.current,
      containerWidth,
      Math.ceil(duration / SEGMENT_DURATION),
      scrollOffsetRef.current,  // playhead is always at scroll position (center-fixed)
      hasSelection ? timeToX(selectionStart) : null,
      hasSelection ? timeToX(selectionEnd) : null,
      leftPaint,
      rightPaint,
      hasSelection ? selectionPaint : null
    )

    if (hasSelection) {
      drawSelectionHandles(canvas, timeToX(selectionStart), timeToX(selectionEnd), selectionPaint)
    }

    canvas.restore()
  }, { width: containerWidth, height: canvasHeight }), [frame, containerWidth, ...deps])

  return (
    <GestureHandlerRootView style={styles.container}>
      {showTime === 'top' && <TimeIndicators position={displayPosition} duration={duration} placement="top" />}

      <View style={[styles.playheadContainer, { height: canvasHeight }]} pointerEvents="none">
        <View style={styles.playhead} />
      </View>

      <GestureDetector gesture={gesture}>
        <View style={[styles.timelineContainer, { height: canvasHeight }]} onLayout={handleLayout}>
          {containerWidth > 0 && (
            <Canvas style={{ width: containerWidth, height: canvasHeight }}>
              {picture && <Picture picture={picture} />}
            </Canvas>
          )}
        </View>
      </GestureDetector>

      {showTime === 'bottom' && <TimeIndicators position={displayPosition} duration={duration} placement="bottom" />}
    </GestureHandlerRootView>
  )
}
```

## Migration

### For PlaybackTimeline Users

```tsx
// Before
<PlaybackTimeline showTime="bottom" />

// After
const { player, seek } = useStore()
<Timeline
  duration={player.duration}
  position={player.position}
  onSeek={(pos) => seek({ fileUri: player.file.uri, position: pos })}
  leftColor={Color.GRAY}
  rightColor={Color.PRIMARY}
  showTime="bottom"
/>
```

Note: The new component is not store-connected. The caller must provide position/duration and handle seeks.

### For SelectionTimeline Users

```tsx
// Before
<SelectionTimeline
  duration={clip.file_duration}
  position={displayPosition}
  selectionStart={start}
  selectionEnd={end}
  onSelectionChange={handleChange}
  onSeek={handleSeek}
/>

// After
<Timeline
  duration={clip.file_duration}
  position={displayPosition}
  onSeek={handleSeek}
  leftColor={Color.PRIMARY}
  rightColor={Color.PRIMARY}
  selectionColor={Color.SELECTION}
  selectionStart={start}
  selectionEnd={end}
  onSelectionChange={handleChange}
/>
```

## Testing

### Unit Tests

- Color assignment logic for various playhead/selection configurations
- Break point calculation edge cases
- Selection handle hit detection

### Visual Tests

Use Maestro flows to verify:
- Playback mode renders correctly (gray/primary split at playhead)
- Selection mode renders correctly (yellow selection region)
- Hybrid mode renders correctly (all three colors)
- Handle dragging adjusts selection bounds
- Scrolling/momentum/tap-to-seek work correctly

### Edge Cases

- Selection fully left of playhead
- Selection fully right of playhead
- Selection containing playhead
- Playhead at position 0
- Playhead at max duration
- Very short duration (few bars)
- Very long duration (thousands of bars)
