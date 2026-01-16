/**
 * SelectionTimeline
 *
 * A timeline component for selecting a range of audio (clip editing).
 * Behaves like PlaybackTimeline (center-fixed playhead, scroll = seek) with
 * the addition of draggable selection handles.
 *
 *
 * ## Behavior (same as PlaybackTimeline)
 *
 * - **Playhead**: Fixed at center, content scrolls behind it
 * - **Scrolling**: Pan/flick to scroll, which also seeks playback position
 * - **Tap**: Seeks to tapped position
 * - **Auto-sync**: View syncs to playback position when idle
 *
 *
 * ## Selection-specific features
 *
 * - **Bar coloring**: Bars are primary (default) or yellow (within selection)
 * - **Selection handles**: Two vertical lines with draggable yellow circles
 * - **Handle drag**: Adjusts selection bounds (independent of scrolling)
 *
 *
 * ## Selection Constraints
 *
 * - Minimum 1 second between handles
 * - Handles cannot cross each other
 */

import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { View, Text, StyleSheet, LayoutChangeEvent } from 'react-native'
import {
  Canvas,
  Picture,
  Skia,
  createPicture,
  SkCanvas,
} from '@shopify/react-native-skia'
import {
  Gesture,
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
  MIN_SELECTION_DURATION,
  MIN_VELOCITY,
  VELOCITY_SCALE,
  DECELERATION,
  SCROLL_TO_DURATION,
  timeToX,
  xToTime,
  clamp,
  getSegmentHeight,
} from '.'

// Selection handle dimensions
const HANDLE_CIRCLE_RADIUS = 12
const HANDLE_TOUCH_RADIUS = 24 // Larger for easier touch targeting
const HANDLE_LINE_WIDTH = 2

// =============================================================================
// Drawing - Selection mode (selected/unselected bar colors)
// =============================================================================

/**
 * Draw the selection timeline with selected (yellow) and unselected (primary) bars.
 * Also draws selection handles. Playhead is rendered as a React View overlay.
 */
function drawSelectionTimeline(
  canvas: SkCanvas,
  scrollOffset: number,
  containerWidth: number,
  totalSegments: number,
  selectionStart: number,
  selectionEnd: number
) {
  // Create paints
  const unselectedPaint = Skia.Paint()
  unselectedPaint.setColor(Skia.Color(Color.PRIMARY))

  const selectedPaint = Skia.Paint()
  selectedPaint.setColor(Skia.Color(Color.SELECTION))

  const placeholderPaint = Skia.Paint()
  placeholderPaint.setColor(Skia.Color(Color.GRAY))

  const handlePaint = Skia.Paint()
  handlePaint.setColor(Skia.Color(Color.SELECTION))

  const halfWidth = containerWidth / 2

  // Convert times to x coordinates
  const selectionStartX = timeToX(selectionStart)
  const selectionEndX = timeToX(selectionEnd)

  // Calculate visible range in timeline coordinates
  const visibleStartX = scrollOffset - halfWidth
  const visibleEndX = scrollOffset + halfWidth

  // Real segment range
  const startSegment = Math.max(0, Math.floor(visibleStartX / SEGMENT_STEP) - 5)
  const endSegment = Math.min(totalSegments, Math.ceil(visibleEndX / SEGMENT_STEP) + 5)

  // Timeline boundaries
  const timelineStartX = 0
  const timelineEndX = totalSegments * SEGMENT_STEP

  // Transform: position scrollOffset at center of canvas
  canvas.save()
  canvas.translate(halfWidth - scrollOffset, 0)

  // Draw placeholder bars on the LEFT (before timeline start)
  if (visibleStartX < timelineStartX) {
    let x = Math.floor(visibleStartX / SEGMENT_STEP) * SEGMENT_STEP
    while (x < timelineStartX) {
      const h = PLACEHOLDER_HEIGHT
      const y = (TIMELINE_HEIGHT - h) / 2
      canvas.drawRRect(
        Skia.RRectXY(Skia.XYWHRect(x, y, SEGMENT_WIDTH, h), 2, 2),
        placeholderPaint
      )
      x += SEGMENT_STEP
    }
  }

  // Draw real segments
  for (let i = startSegment; i < endSegment; i++) {
    const x = i * SEGMENT_STEP
    const segmentCenterX = x + SEGMENT_WIDTH / 2
    const height = getSegmentHeight(i)
    const y = (TIMELINE_HEIGHT - height) / 2

    // Check if segment is within selection
    const isSelected = segmentCenterX >= selectionStartX && segmentCenterX <= selectionEndX
    const paint = isSelected ? selectedPaint : unselectedPaint

    canvas.drawRRect(
      Skia.RRectXY(Skia.XYWHRect(x, y, SEGMENT_WIDTH, height), 2, 2),
      paint
    )
  }

  // Draw placeholder bars on the RIGHT (after timeline end)
  if (visibleEndX > timelineEndX) {
    const placeholderY = (TIMELINE_HEIGHT - PLACEHOLDER_HEIGHT) / 2
    let x = timelineEndX
    while (x < visibleEndX) {
      canvas.drawRRect(
        Skia.RRectXY(Skia.XYWHRect(x, placeholderY, SEGMENT_WIDTH, PLACEHOLDER_HEIGHT), 2, 2),
        placeholderPaint
      )
      x += SEGMENT_STEP
    }
  }

  // Draw selection handles (if visible)
  const handleTop = 10
  const handleBottom = TIMELINE_HEIGHT - 10
  const circleY = handleBottom + HANDLE_CIRCLE_RADIUS

  // Start handle
  if (selectionStartX >= visibleStartX && selectionStartX <= visibleEndX) {
    canvas.drawRect(
      Skia.XYWHRect(selectionStartX - HANDLE_LINE_WIDTH / 2, handleTop, HANDLE_LINE_WIDTH, handleBottom - handleTop),
      handlePaint
    )
    canvas.drawCircle(selectionStartX, circleY, HANDLE_CIRCLE_RADIUS, handlePaint)
  }

  // End handle
  if (selectionEndX >= visibleStartX && selectionEndX <= visibleEndX) {
    canvas.drawRect(
      Skia.XYWHRect(selectionEndX - HANDLE_LINE_WIDTH / 2, handleTop, HANDLE_LINE_WIDTH, handleBottom - handleTop),
      handlePaint
    )
    canvas.drawCircle(selectionEndX, circleY, HANDLE_CIRCLE_RADIUS, handlePaint)
  }

  canvas.restore()
}

// =============================================================================
// useSelectionPhysics - Custom hook for scroll + handle dragging
// =============================================================================

interface UseSelectionPhysicsOptions {
  maxScrollOffset: number
  containerWidth: number
  duration: number
  externalPosition: number
  selectionStart: number
  selectionEnd: number
  onSelectionChange: (start: number, end: number) => void
  onSeek?: (position: number) => void
}

function useSelectionPhysics({
  maxScrollOffset,
  containerWidth,
  duration,
  externalPosition,
  selectionStart,
  selectionEnd,
  onSelectionChange,
  onSeek,
}: UseSelectionPhysicsOptions) {
  const [frame, setFrame] = useState(0)

  // Scroll state (refs for 60fps)
  const scrollOffsetRef = useRef(timeToX(externalPosition))
  const velocityRef = useRef(0)
  const isDraggingRef = useRef(false)
  const dragStartOffsetRef = useRef(0)
  const rafIdRef = useRef<number | null>(null)

  // Handle drag state
  const draggingHandleRef = useRef<'start' | 'end' | null>(null)
  const handleDragStartValueRef = useRef(0)

  // Animation state for tap-to-seek
  const animationRef = useRef<{
    startOffset: number
    targetOffset: number
    startTime: number
  } | null>(null)

  const stoppedMomentumRef = useRef(false)

  const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)

  const stopAnimation = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
    velocityRef.current = 0
    animationRef.current = null
  }, [])

  // Animated scroll to target position
  const animateToPosition = useCallback((targetOffset: number) => {
    stopAnimation()

    animationRef.current = {
      startOffset: scrollOffsetRef.current,
      targetOffset: clamp(targetOffset, 0, maxScrollOffset),
      startTime: performance.now(),
    }

    const tick = () => {
      if (!animationRef.current || isDraggingRef.current || draggingHandleRef.current) {
        animationRef.current = null
        rafIdRef.current = null
        return
      }

      const elapsed = performance.now() - animationRef.current.startTime
      const progress = Math.min(elapsed / SCROLL_TO_DURATION, 1)
      const easedProgress = easeOutCubic(progress)

      const { startOffset, targetOffset } = animationRef.current
      scrollOffsetRef.current = startOffset + (targetOffset - startOffset) * easedProgress

      setFrame(f => f + 1)

      if (progress < 1) {
        rafIdRef.current = requestAnimationFrame(tick)
      } else {
        animationRef.current = null
        rafIdRef.current = null
        onSeek?.(xToTime(scrollOffsetRef.current))
      }
    }

    rafIdRef.current = requestAnimationFrame(tick)
  }, [maxScrollOffset, onSeek, stopAnimation])

  // Momentum loop
  const startMomentumLoop = useCallback(() => {
    const tick = () => {
      if (isDraggingRef.current || draggingHandleRef.current) {
        rafIdRef.current = null
        return
      }

      if (Math.abs(velocityRef.current) > MIN_VELOCITY) {
        scrollOffsetRef.current = clamp(
          scrollOffsetRef.current + velocityRef.current,
          0,
          maxScrollOffset
        )
        velocityRef.current *= DECELERATION

        setFrame(f => f + 1)
        rafIdRef.current = requestAnimationFrame(tick)
      } else {
        velocityRef.current = 0
        rafIdRef.current = null
        // Seek to final position when momentum stops
        onSeek?.(xToTime(scrollOffsetRef.current))
      }
    }

    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
    }
    animationRef.current = null
    rafIdRef.current = requestAnimationFrame(tick)
  }, [maxScrollOffset, onSeek])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
      }
    }
  }, [])

  // Sync to external position when idle (not dragging, not in momentum, not dragging handle)
  useEffect(() => {
    if (!isDraggingRef.current && rafIdRef.current === null && !draggingHandleRef.current) {
      scrollOffsetRef.current = timeToX(externalPosition)
      setFrame(f => f + 1)
    }
  }, [externalPosition])

  // Check if touch is on a handle circle
  const getHandleAtPosition = useCallback((touchX: number, touchY: number): 'start' | 'end' | null => {
    const halfWidth = containerWidth / 2
    const circleY = TIMELINE_HEIGHT - 10 + HANDLE_CIRCLE_RADIUS

    // Convert touch to timeline coordinates
    const timelineX = scrollOffsetRef.current + (touchX - halfWidth)

    const startHandleX = timeToX(selectionStart)
    const endHandleX = timeToX(selectionEnd)

    // Check distance to each handle circle
    const distToStart = Math.sqrt(
      Math.pow(timelineX - startHandleX, 2) + Math.pow(touchY - circleY, 2)
    )
    const distToEnd = Math.sqrt(
      Math.pow(timelineX - endHandleX, 2) + Math.pow(touchY - circleY, 2)
    )

    // Return closest handle if within touch radius
    if (distToStart <= HANDLE_TOUCH_RADIUS && distToStart <= distToEnd) {
      return 'start'
    }
    if (distToEnd <= HANDLE_TOUCH_RADIUS) {
      return 'end'
    }

    return null
  }, [containerWidth, selectionStart, selectionEnd])

  // --- Gesture handlers ---

  const handleTouchDown = useCallback((x: number, y: number) => {
    // Check if touching a handle
    const handle = getHandleAtPosition(x, y)
    if (handle) {
      draggingHandleRef.current = handle
      handleDragStartValueRef.current = handle === 'start' ? selectionStart : selectionEnd
      stopAnimation()
      stoppedMomentumRef.current = true
      return
    }

    // Not on handle - check if we should stop momentum
    if (rafIdRef.current !== null || animationRef.current !== null) {
      stopAnimation()
      stoppedMomentumRef.current = true
    } else {
      stoppedMomentumRef.current = false
    }
  }, [getHandleAtPosition, selectionStart, selectionEnd, stopAnimation])

  const handleTap = useCallback((x: number) => {
    if (stoppedMomentumRef.current || draggingHandleRef.current) {
      stoppedMomentumRef.current = false
      draggingHandleRef.current = null
      return
    }

    const halfWidth = containerWidth / 2
    const offsetFromCenter = x - halfWidth
    const tappedTime = xToTime(scrollOffsetRef.current + offsetFromCenter)
    const clampedTime = clamp(tappedTime, 0, duration)

    animateToPosition(timeToX(clampedTime))
  }, [containerWidth, duration, animateToPosition])

  const onPanStart = useCallback((x: number, y: number) => {
    // Check if starting on a handle
    const handle = getHandleAtPosition(x, y)
    if (handle) {
      draggingHandleRef.current = handle
      handleDragStartValueRef.current = handle === 'start' ? selectionStart : selectionEnd
      stopAnimation()
      return
    }

    // Regular pan
    isDraggingRef.current = true
    velocityRef.current = 0
    dragStartOffsetRef.current = scrollOffsetRef.current
    stopAnimation()
  }, [getHandleAtPosition, selectionStart, selectionEnd, stopAnimation])

  const onPanUpdate = useCallback((translationX: number) => {
    if (draggingHandleRef.current) {
      // Dragging a handle - positive translationX (drag right) should increase time
      const deltaTime = xToTime(translationX)
      const newValue = handleDragStartValueRef.current + deltaTime

      if (draggingHandleRef.current === 'start') {
        // Clamp start handle: 0 <= start <= end - MIN_SELECTION_DURATION
        const maxStart = selectionEnd - MIN_SELECTION_DURATION
        const clampedStart = clamp(newValue, 0, maxStart)
        onSelectionChange(clampedStart, selectionEnd)
      } else {
        // Clamp end handle: start + MIN_SELECTION_DURATION <= end <= duration
        const minEnd = selectionStart + MIN_SELECTION_DURATION
        const clampedEnd = clamp(newValue, minEnd, duration)
        onSelectionChange(selectionStart, clampedEnd)
      }

      setFrame(f => f + 1)
      return
    }

    // Regular scroll
    scrollOffsetRef.current = clamp(
      dragStartOffsetRef.current - translationX,
      0,
      maxScrollOffset
    )
    setFrame(f => f + 1)
  }, [selectionStart, selectionEnd, duration, maxScrollOffset, onSelectionChange])

  const onPanEnd = useCallback((velocityX: number) => {
    if (draggingHandleRef.current) {
      draggingHandleRef.current = null
      return
    }

    isDraggingRef.current = false
    velocityRef.current = -velocityX * VELOCITY_SCALE

    if (Math.abs(velocityRef.current) > MIN_VELOCITY) {
      startMomentumLoop()
    } else {
      // No momentum - seek to current position
      onSeek?.(xToTime(scrollOffsetRef.current))
    }
  }, [startMomentumLoop, onSeek])

  // Build gesture
  const panGesture = Gesture.Pan()
    .runOnJS(true)
    .onStart((event) => onPanStart(event.x, event.y))
    .onUpdate((event) => onPanUpdate(event.translationX))
    .onEnd((event) => onPanEnd(event.velocityX))

  const tapGesture = Gesture.Tap()
    .runOnJS(true)
    .onBegin((event) => handleTouchDown(event.x, event.y))
    .onEnd((event) => handleTap(event.x))

  const gesture = Gesture.Race(panGesture, tapGesture)

  return {
    scrollOffsetRef,
    frame,
    gesture,
  }
}

// =============================================================================
// SelectionTimeline - Main component
// =============================================================================

export interface SelectionTimelineProps {
  duration: number
  position: number
  selectionStart: number
  selectionEnd: number
  onSelectionChange: (start: number, end: number) => void
  onSeek?: (position: number) => void
  showTime?: 'top' | 'bottom' | 'hidden'
}

export function SelectionTimeline({
  duration,
  position,
  selectionStart,
  selectionEnd,
  onSelectionChange,
  onSeek,
  showTime = 'bottom',
}: SelectionTimelineProps) {
  const [containerWidth, setContainerWidth] = useState(0)

  const totalSegments = Math.ceil(duration / SEGMENT_DURATION)
  const maxScrollOffset = timeToX(duration)

  const { scrollOffsetRef, frame, gesture } = useSelectionPhysics({
    maxScrollOffset,
    containerWidth,
    duration,
    externalPosition: position,
    selectionStart,
    selectionEnd,
    onSelectionChange,
    onSeek,
  })

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setContainerWidth(event.nativeEvent.layout.width)
  }, [])

  // Create picture - rebuilt when frame changes
  const picture = useMemo(() => {
    if (containerWidth === 0 || totalSegments === 0) return null

    try {
      return createPicture(
        (canvas) => {
          drawSelectionTimeline(
            canvas,
            scrollOffsetRef.current,
            containerWidth,
            totalSegments,
            selectionStart,
            selectionEnd
          )
        },
        { width: containerWidth, height: TIMELINE_HEIGHT + HANDLE_CIRCLE_RADIUS * 2 }
      )
    } catch (error) {
      console.error('Error creating picture:', error)
      return null
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollOffsetRef is stable, frame triggers updates
  }, [frame, containerWidth, totalSegments, selectionStart, selectionEnd])

  const canvasHeight = TIMELINE_HEIGHT + HANDLE_CIRCLE_RADIUS * 2

  // Calculate playhead top offset based on time indicator position
  const playheadTop = showTime === 'top'
    ? TIME_INDICATORS_HEIGHT + TIME_INDICATORS_MARGIN
    : 0

  return (
    <GestureHandlerRootView style={styles.container}>
      {showTime === 'top' && (
        <TimeIndicators
          position={position}
          duration={duration}
          placement="top"
        />
      )}

      {/* Playhead indicator at center */}
      <View style={[styles.playheadContainer, { top: playheadTop, height: canvasHeight }]} pointerEvents="none">
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

      {showTime === 'bottom' && (
        <TimeIndicators
          position={position}
          duration={duration}
          placement="bottom"
        />
      )}
    </GestureHandlerRootView>
  )
}

// =============================================================================
// TimeIndicators - Time display subcomponent
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
  container: {
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
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
