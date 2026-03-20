/**
 * useTimelinePhysics
 *
 * Unified physics hook for timeline scroll, momentum, tap-to-seek, and optional
 * selection handle dragging and pinch-to-zoom. Uses refs for 60fps animation
 * without React re-render overhead.
 */

import { useCallback, useEffect, useState, useRef } from 'react'
import { Gesture } from 'react-native-gesture-handler'

import {
  SEGMENT_WIDTH,
  SEGMENT_GAP,
  SEGMENT_DURATION,
  DECELERATION,
  MIN_VELOCITY,
  VELOCITY_SCALE,
  SCROLL_TO_DURATION,
  MIN_SELECTION_DURATION,
  MIN_ZOOM,
  MAX_ZOOM,
  TIMELINE_HEIGHT,
} from './constants'
import { timeToX, xToTime, clamp } from './utils'

const HANDLE_CIRCLE_RADIUS = 12
const HANDLE_TOUCH_RADIUS = 24
const DISPLAY_UPDATE_INTERVAL = 50 // Throttle time display updates to reduce re-renders

export interface SelectionConfig {
  start: number
  end: number
  onChange: (start: number, end: number) => void
}

export interface UseTimelinePhysicsOptions {
  containerWidth: number
  duration: number
  externalPosition: number
  onSeek: (position: number) => void
  selection?: SelectionConfig
  canZoom?: boolean
}

export interface TimelinePhysicsResult {
  scrollOffsetRef: React.MutableRefObject<number>
  /** Current zoom-scaled segment width */
  segmentWidth: number
  /** Current zoom-scaled segment gap */
  segmentGap: number
  displayPosition: number
  frame: number
  gesture: ReturnType<typeof Gesture.Race> | ReturnType<typeof Gesture.Simultaneous>
}

export function useTimelinePhysics({
  containerWidth,
  duration,
  externalPosition,
  onSeek,
  selection,
  canZoom = false,
}: UseTimelinePhysicsOptions): TimelinePhysicsResult {
  const [frame, setFrame] = useState(0)
  const [displayPosition, setDisplayPosition] = useState(externalPosition)

  // Zoom state — owned by this hook, updated synchronously via ref
  const zoomFactorRef = useRef(1)

  // Derived layout from zoom (refs for synchronous access in handlers)
  const segmentWidthRef = useRef(SEGMENT_WIDTH)
  const segmentGapRef = useRef(SEGMENT_GAP)

  const applyZoom = (factor: number) => {
    zoomFactorRef.current = factor
    segmentWidthRef.current = SEGMENT_WIDTH * factor
    segmentGapRef.current = SEGMENT_GAP * factor
  }

  // Helper: call timeToX/xToTime with current layout refs
  const tx = (time: number) => timeToX(time, SEGMENT_DURATION, segmentWidthRef.current, segmentGapRef.current)
  const xt = (x: number) => xToTime(x, SEGMENT_DURATION, segmentWidthRef.current, segmentGapRef.current)
  const maxOffset = () => tx(duration)

  // Scroll state (refs for 60fps)
  const scrollOffsetRef = useRef(tx(externalPosition))
  const velocityRef = useRef(0)
  const isDraggingRef = useRef(false)
  const dragStartOffsetRef = useRef(0)
  const rafIdRef = useRef<number | null>(null)

  // Handle drag state
  const draggingHandleRef = useRef<'start' | 'end' | null>(null)
  const handleDragStartValueRef = useRef(0)

  // Pinch zoom state
  const isPinchingRef = useRef(false)
  const pinchBaseZoomRef = useRef(1)

  // Animation state for tap-to-seek
  const animationRef = useRef<{
    startOffset: number
    targetOffset: number
    startTime: number
  } | null>(null)

  // Track if we stopped momentum on this touch
  const stoppedMomentumRef = useRef(false)

  // Throttle time display updates to reduce React re-renders
  const lastDisplayUpdateRef = useRef(0)
  const updateDisplayPosition = useCallback((position: number, force = false) => {
    const now = performance.now()
    if (force || now - lastDisplayUpdateRef.current >= DISPLAY_UPDATE_INTERVAL) {
      lastDisplayUpdateRef.current = now
      setDisplayPosition(position)
    }
  }, [])

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
      targetOffset: clamp(targetOffset, 0, maxOffset()),
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

      updateDisplayPosition(xt(scrollOffsetRef.current))
      setFrame(f => f + 1)

      if (progress < 1) {
        rafIdRef.current = requestAnimationFrame(tick)
      } else {
        animationRef.current = null
        rafIdRef.current = null
        updateDisplayPosition(xt(scrollOffsetRef.current), true)
        onSeek(xt(scrollOffsetRef.current))
      }
    }

    rafIdRef.current = requestAnimationFrame(tick)
  }, [onSeek, stopAnimation, updateDisplayPosition])

  // Momentum loop
  const startMomentumLoop = useCallback(() => {
    const tick = () => {
      if (isDraggingRef.current || draggingHandleRef.current) {
        rafIdRef.current = null
        return
      }

      const max = maxOffset()
      if (Math.abs(velocityRef.current) > MIN_VELOCITY) {
        scrollOffsetRef.current = clamp(
          scrollOffsetRef.current + velocityRef.current,
          0,
          max
        )
        velocityRef.current *= DECELERATION

        updateDisplayPosition(xt(scrollOffsetRef.current))
        setFrame(f => f + 1)
        rafIdRef.current = requestAnimationFrame(tick)
      } else {
        velocityRef.current = 0
        rafIdRef.current = null
        updateDisplayPosition(xt(scrollOffsetRef.current), true)
        onSeek(xt(scrollOffsetRef.current))
      }
    }

    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
    }
    animationRef.current = null
    rafIdRef.current = requestAnimationFrame(tick)
  }, [onSeek, updateDisplayPosition])

  // Sync to external position when idle
  useEffect(() => {
    if (!isDraggingRef.current && rafIdRef.current === null && !draggingHandleRef.current) {
      scrollOffsetRef.current = tx(externalPosition)
      updateDisplayPosition(externalPosition, true)
      setFrame(f => f + 1)
    }
  }, [externalPosition, updateDisplayPosition])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
      }
    }
  }, [])

  // Check if touch is on a selection handle
  const getHandleAtPosition = useCallback((touchX: number, touchY: number): 'start' | 'end' | null => {
    if (!selection) return null

    const halfWidth = containerWidth / 2
    const circleY = TIMELINE_HEIGHT - 10 + HANDLE_CIRCLE_RADIUS

    // Convert touch to timeline coordinates
    const timelineX = scrollOffsetRef.current + (touchX - halfWidth)

    const startHandleX = tx(selection.start)
    const endHandleX = tx(selection.end)

    // Check distance to each handle circle
    const distToStart = Math.sqrt(
      Math.pow(timelineX - startHandleX, 2) + Math.pow(touchY - circleY, 2)
    )
    const distToEnd = Math.sqrt(
      Math.pow(timelineX - endHandleX, 2) + Math.pow(touchY - circleY, 2)
    )

    if (distToStart <= HANDLE_TOUCH_RADIUS && distToStart <= distToEnd) {
      return 'start'
    }
    if (distToEnd <= HANDLE_TOUCH_RADIUS) {
      return 'end'
    }

    return null
  }, [containerWidth, selection])

  // --- Gesture handlers ---

  const handleTouchDown = useCallback((x: number, y: number) => {
    // Check if touching a handle
    if (selection) {
      const handle = getHandleAtPosition(x, y)
      if (handle) {
        draggingHandleRef.current = handle
        handleDragStartValueRef.current = handle === 'start' ? selection.start : selection.end
        stopAnimation()
        stoppedMomentumRef.current = true
        return
      }
    }

    // Not on handle - check if we should stop momentum
    if (rafIdRef.current !== null || animationRef.current !== null) {
      stopAnimation()
      stoppedMomentumRef.current = true
      onSeek(xt(scrollOffsetRef.current))
    } else {
      stoppedMomentumRef.current = false
    }
  }, [getHandleAtPosition, selection, stopAnimation, onSeek])

  const handleTap = useCallback((x: number) => {
    if (stoppedMomentumRef.current || draggingHandleRef.current) {
      stoppedMomentumRef.current = false
      draggingHandleRef.current = null
      return
    }

    const halfWidth = containerWidth / 2
    const offsetFromCenter = x - halfWidth
    const tappedTime = xt(scrollOffsetRef.current + offsetFromCenter)
    const clampedTime = clamp(tappedTime, 0, duration)

    animateToPosition(tx(clampedTime))
  }, [containerWidth, duration, animateToPosition])

  const onPanStart = useCallback((x: number, y: number) => {
    if (isPinchingRef.current) return

    // Check if starting on a handle
    if (selection) {
      const handle = getHandleAtPosition(x, y)
      if (handle) {
        draggingHandleRef.current = handle
        handleDragStartValueRef.current = handle === 'start' ? selection.start : selection.end
        stopAnimation()
        return
      }
    }

    // Regular pan
    isDraggingRef.current = true
    velocityRef.current = 0
    dragStartOffsetRef.current = scrollOffsetRef.current
    stopAnimation()
  }, [getHandleAtPosition, selection, stopAnimation])

  const onPanUpdate = useCallback((translationX: number) => {
    if (isPinchingRef.current) return

    if (draggingHandleRef.current && selection) {
      // Dragging a handle
      const deltaTime = xt(translationX)
      const newValue = handleDragStartValueRef.current + deltaTime

      if (draggingHandleRef.current === 'start') {
        const maxStart = selection.end - MIN_SELECTION_DURATION
        const clampedStart = clamp(newValue, 0, maxStart)
        selection.onChange(clampedStart, selection.end)
      } else {
        const minEnd = selection.start + MIN_SELECTION_DURATION
        const clampedEnd = clamp(newValue, minEnd, duration)
        selection.onChange(selection.start, clampedEnd)
      }

      setFrame(f => f + 1)
      return
    }

    // Regular scroll
    scrollOffsetRef.current = clamp(
      dragStartOffsetRef.current - translationX,
      0,
      maxOffset()
    )
    updateDisplayPosition(xt(scrollOffsetRef.current))
    setFrame(f => f + 1)
  }, [selection, duration, updateDisplayPosition])

  const onPanEnd = useCallback((velocityX: number) => {
    if (isPinchingRef.current) return

    if (draggingHandleRef.current) {
      draggingHandleRef.current = null
      return
    }

    isDraggingRef.current = false
    velocityRef.current = -velocityX * VELOCITY_SCALE

    if (Math.abs(velocityRef.current) > MIN_VELOCITY) {
      startMomentumLoop()
    } else {
      onSeek(xt(scrollOffsetRef.current))
    }
  }, [startMomentumLoop, onSeek])

  // Build composed gesture
  const panGesture = Gesture.Pan()
    .runOnJS(true)
    .onStart((event) => onPanStart(event.x, event.y))
    .onUpdate((event) => onPanUpdate(event.translationX))
    .onEnd((event) => onPanEnd(event.velocityX))

  const tapGesture = Gesture.Tap()
    .runOnJS(true)
    .onBegin((event) => handleTouchDown(event.x, event.y))
    .onEnd((event) => handleTap(event.x))

  const panTapGesture = Gesture.Race(panGesture, tapGesture)

  const gesture = canZoom
    ? Gesture.Simultaneous(
        panTapGesture,
        Gesture.Pinch()
          .runOnJS(true)
          .onStart(() => {
            isPinchingRef.current = true
            pinchBaseZoomRef.current = zoomFactorRef.current
            stopAnimation()
          })
          .onUpdate((event) => {
            // Compute new zoom, snapped to reduce jitter
            const rawZoom = pinchBaseZoomRef.current * event.scale
            const newZoom = clamp(Math.round(rawZoom * 20) / 20, MIN_ZOOM, MAX_ZOOM)
            if (newZoom === zoomFactorRef.current) return

            // Preserve current time position across zoom change
            const currentTime = xt(scrollOffsetRef.current)
            applyZoom(newZoom)
            scrollOffsetRef.current = tx(currentTime)

            setFrame(f => f + 1)
          })
          .onEnd(() => {
            isPinchingRef.current = false
          })
      )
    : panTapGesture

  return {
    scrollOffsetRef,
    segmentWidth: segmentWidthRef.current,
    segmentGap: segmentGapRef.current,
    displayPosition,
    frame,
    gesture,
  }
}
