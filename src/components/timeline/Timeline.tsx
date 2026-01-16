/**
 * Timeline
 *
 * A unified, GPU-accelerated audio timeline component supporting both playback
 * progress display and range selection.
 *
 *
 * ## Visual Design
 *
 * A horizontal row of vertical bars (decorative waveform) with a center-fixed
 * playhead. Bars scroll behind the playhead as the user drags or as playback
 * progresses.
 *
 *
 * ## Rendering Approach: Stencil + Paint Layers
 *
 * Instead of drawing each bar individually with per-segment color logic, we:
 *
 *   1. Build ONE path containing all visible bar shapes (the "stencil")
 *   2. Draw the path 2-3 times with different clip regions (the "paint layers")
 *
 * This gives us O(bars) path ops + 3 draw calls, vs O(bars × segments) draws.
 *
 * The painter's algorithm (draw back-to-front) handles color precedence:
 *   - Layer 1: leftColor, clipped to [start, playhead]
 *   - Layer 2: rightColor, clipped to [playhead, end]
 *   - Layer 3: selectionColor, clipped to [selStart, selEnd] (overwrites 1 & 2)
 *
 *
 * ## Interactions
 *
 *   - **Drag** to scrub through the audio
 *   - **Flick** to scroll with momentum
 *   - **Tap** to seek to that position
 *   - **Drag handles** (when selection enabled) to adjust selection bounds
 */

import { useCallback, useMemo, useState } from 'react'
import { View, Text, StyleSheet, LayoutChangeEvent } from 'react-native'
import {
  Canvas,
  Picture,
  Skia,
  createPicture,
  SkCanvas,
  ClipOp,
} from '@shopify/react-native-skia'
import {
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler'

import { Color } from '../../theme'
import { formatTime } from '../../utils'
import {
  SEGMENT_WIDTH,
  SEGMENT_STEP,
  SEGMENT_DURATION,
  TIMELINE_HEIGHT,
  PLAYHEAD_WIDTH,
  PLACEHOLDER_HEIGHT,
  TIME_INDICATORS_HEIGHT,
  TIME_INDICATORS_MARGIN,
  timeToX,
  getSegmentHeight,
} from '.'
import { useTimelinePhysics } from './useTimelinePhysics'

// Selection handle dimensions
const HANDLE_CIRCLE_RADIUS = 12
const HANDLE_LINE_WIDTH = 2

// =============================================================================
// Types
// =============================================================================

export interface TimelineProps {
  // Core (required)
  duration: number
  position: number
  onSeek: (position: number) => void

  // Bar colors (required)
  leftColor: string
  rightColor: string

  // Selection (optional - all four must be provided to enable selection)
  selectionColor?: string
  selectionStart?: number
  selectionEnd?: number
  onSelectionChange?: (start: number, end: number) => void

  // Display (optional)
  showTime?: 'top' | 'bottom' | 'hidden'
}

// =============================================================================
// Drawing
// =============================================================================

function drawTimeline(
  canvas: SkCanvas,
  scrollOffset: number,
  containerWidth: number,
  totalSegments: number,
  playheadX: number,
  selectionStartX: number | null,
  selectionEndX: number | null,
  leftPaint: ReturnType<typeof Skia.Paint>,
  rightPaint: ReturnType<typeof Skia.Paint>,
  selectionPaint: ReturnType<typeof Skia.Paint> | null,
  placeholderPaint: ReturnType<typeof Skia.Paint>
) {
  const halfWidth = containerWidth / 2
  const visibleStartX = scrollOffset - halfWidth
  const visibleEndX = scrollOffset + halfWidth

  // Timeline boundaries
  const timelineStartX = 0
  const timelineEndX = totalSegments * SEGMENT_STEP

  // Calculate visible segment range (with small buffer)
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

  // 2. Draw placeholder bars on the LEFT (before timeline start)
  if (visibleStartX < timelineStartX) {
    let x = Math.floor(visibleStartX / SEGMENT_STEP) * SEGMENT_STEP
    while (x < timelineStartX) {
      const y = (TIMELINE_HEIGHT - PLACEHOLDER_HEIGHT) / 2
      canvas.drawRRect(
        Skia.RRectXY(Skia.XYWHRect(x, y, SEGMENT_WIDTH, PLACEHOLDER_HEIGHT), 2, 2),
        placeholderPaint
      )
      x += SEGMENT_STEP
    }
  }

  // 3. Draw placeholder bars on the RIGHT (after timeline end)
  if (visibleEndX > timelineEndX) {
    let x = Math.max(timelineEndX, Math.floor(visibleStartX / SEGMENT_STEP) * SEGMENT_STEP)
    const placeholderY = (TIMELINE_HEIGHT - PLACEHOLDER_HEIGHT) / 2
    while (x < visibleEndX) {
      if (x >= timelineEndX) {
        canvas.drawRRect(
          Skia.RRectXY(Skia.XYWHRect(x, placeholderY, SEGMENT_WIDTH, PLACEHOLDER_HEIGHT), 2, 2),
          placeholderPaint
        )
      }
      x += SEGMENT_STEP
    }
  }

  // 4. Draw stencil with color layers (painter's algorithm)

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

function drawSelectionHandles(
  canvas: SkCanvas,
  selectionStartX: number,
  selectionEndX: number,
  handlePaint: ReturnType<typeof Skia.Paint>
) {
  const handleTop = 10
  const handleBottom = TIMELINE_HEIGHT - 10
  const circleY = handleBottom + HANDLE_CIRCLE_RADIUS

  // Start handle: vertical line + circle
  canvas.drawRect(
    Skia.XYWHRect(
      selectionStartX - HANDLE_LINE_WIDTH / 2,
      handleTop,
      HANDLE_LINE_WIDTH,
      handleBottom - handleTop
    ),
    handlePaint
  )
  canvas.drawCircle(selectionStartX, circleY, HANDLE_CIRCLE_RADIUS, handlePaint)

  // End handle: vertical line + circle
  canvas.drawRect(
    Skia.XYWHRect(
      selectionEndX - HANDLE_LINE_WIDTH / 2,
      handleTop,
      HANDLE_LINE_WIDTH,
      handleBottom - handleTop
    ),
    handlePaint
  )
  canvas.drawCircle(selectionEndX, circleY, HANDLE_CIRCLE_RADIUS, handlePaint)
}

// =============================================================================
// Timeline Component
// =============================================================================

export function Timeline({
  duration,
  position,
  onSeek,
  leftColor,
  rightColor,
  selectionColor,
  selectionStart,
  selectionEnd,
  onSelectionChange,
  showTime = 'bottom',
}: TimelineProps) {
  const [containerWidth, setContainerWidth] = useState(0)

  // Selection is enabled only when all four props are provided
  const hasSelection = !!(
    selectionColor &&
    selectionStart != null &&
    selectionEnd != null &&
    onSelectionChange
  )

  const totalSegments = Math.ceil(duration / SEGMENT_DURATION)
  const maxScrollOffset = timeToX(duration)

  const { scrollOffsetRef, displayPosition, frame, gesture } = useTimelinePhysics({
    maxScrollOffset,
    containerWidth,
    duration,
    externalPosition: position,
    onSeek,
    selection: hasSelection
      ? { start: selectionStart!, end: selectionEnd!, onChange: onSelectionChange! }
      : undefined,
  })

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setContainerWidth(event.nativeEvent.layout.width)
  }, [])

  // Create paints (memoized to avoid recreating every frame)
  const paints = useMemo(() => ({
    left: createPaint(leftColor),
    right: createPaint(rightColor),
    selection: selectionColor ? createPaint(selectionColor) : null,
    placeholder: createPaint(Color.GRAY),
  }), [leftColor, rightColor, selectionColor])

  // Canvas height increases when selection handles are shown
  const canvasHeight = hasSelection
    ? TIMELINE_HEIGHT + HANDLE_CIRCLE_RADIUS * 2
    : TIMELINE_HEIGHT

  // Create picture - rebuilt when frame changes
  const picture = useMemo(() => {
    if (containerWidth === 0 || totalSegments === 0) return null

    const halfWidth = containerWidth / 2
    const scrollOffset = scrollOffsetRef.current
    const playheadX = scrollOffset // Playhead is always at scroll position (center-fixed)

    const selStartX = hasSelection ? timeToX(selectionStart!) : null
    const selEndX = hasSelection ? timeToX(selectionEnd!) : null

    try {
      return createPicture(
        (canvas) => {
          // Transform: position scrollOffset at center of canvas
          canvas.save()
          canvas.translate(halfWidth - scrollOffset, 0)

          drawTimeline(
            canvas,
            scrollOffset,
            containerWidth,
            totalSegments,
            playheadX,
            selStartX,
            selEndX,
            paints.left,
            paints.right,
            paints.selection,
            paints.placeholder
          )

          if (hasSelection && selStartX !== null && selEndX !== null) {
            drawSelectionHandles(canvas, selStartX, selEndX, paints.selection!)
          }

          canvas.restore()
        },
        { width: containerWidth, height: canvasHeight }
      )
    } catch (error) {
      console.error('Error creating timeline picture:', error)
      return null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame, containerWidth, totalSegments, hasSelection, selectionStart, selectionEnd, paints, canvasHeight])

  // Calculate playhead position based on time indicator placement
  const playheadTop = showTime === 'top'
    ? TIME_INDICATORS_HEIGHT + TIME_INDICATORS_MARGIN
    : 0

  // Playhead height: align with bottom of handle circles when selection is enabled
  const playheadHeight = hasSelection
    ? TIMELINE_HEIGHT - 10 + HANDLE_CIRCLE_RADIUS * 2  // Bottom of handle circles
    : TIMELINE_HEIGHT

  return (
    <GestureHandlerRootView style={styles.container}>
      {showTime === 'top' && (
        <TimeIndicators
          position={displayPosition}
          duration={duration}
          placement="top"
        />
      )}

      {/* Playhead indicator at center */}
      <View
        style={[styles.playheadContainer, { top: playheadTop, height: playheadHeight }]}
        pointerEvents="none"
      >
        <View style={styles.playhead} />
      </View>

      {/* Timeline with gesture handling */}
      <GestureDetector gesture={gesture}>
        <View style={[styles.timelineContainer, { height: canvasHeight }]} onLayout={handleLayout}>
          {containerWidth > 0 && (
            <Canvas style={{ width: containerWidth, height: canvasHeight }}>
              {picture && <Picture picture={picture} />}
            </Canvas>
          )}
        </View>
      </GestureDetector>

      {showTime === 'bottom' && (
        <TimeIndicators
          position={displayPosition}
          duration={duration}
          placement="bottom"
        />
      )}
    </GestureHandlerRootView>
  )
}

// =============================================================================
// Helpers
// =============================================================================

function createPaint(color: string) {
  const paint = Skia.Paint()
  paint.setColor(Skia.Color(color))
  return paint
}

// =============================================================================
// TimeIndicators
// =============================================================================

interface TimeIndicatorsProps {
  position: number
  duration: number
  placement: 'top' | 'bottom'
}

function TimeIndicators({ position, duration, placement }: TimeIndicatorsProps) {
  const marginStyle = placement === 'top'
    ? { marginBottom: TIME_INDICATORS_MARGIN }
    : { marginTop: TIME_INDICATORS_MARGIN }

  return (
    <View style={[styles.timeContainer, marginStyle]}>
      <View style={styles.timeSpacer} />
      <Text style={styles.timeCurrent}>{formatTime(position)}</Text>
      <Text style={styles.timeTotal}>{formatTime(duration)}</Text>
    </View>
  )
}

// =============================================================================
// Styles
// =============================================================================

const styles = StyleSheet.create({
  container: {},
  timelineContainer: {
    justifyContent: 'center',
    overflow: 'hidden',
  },
  playheadContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  playhead: {
    width: PLAYHEAD_WIDTH,
    height: '100%',
    backgroundColor: Color.BLACK,
    shadowColor: Color.BLACK,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.3,
    shadowRadius: 2,
  },
  timeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  timeSpacer: {
    flex: 1,
  },
  timeCurrent: {
    fontSize: 16,
    color: Color.BLACK,
    fontWeight: '600',
  },
  timeTotal: {
    fontSize: 16,
    color: Color.GRAY_DARK,
    textAlign: 'right',
    flex: 1,
  },
})
