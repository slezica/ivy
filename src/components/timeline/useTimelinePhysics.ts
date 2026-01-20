/**
 * useTimelinePhysics
 *
 * Unified physics hook for timeline scroll, momentum, tap-to-seek, and optional
 * selection handle dragging. Uses refs for 60fps animation without React re-render
 * overhead.
 */

import { useCallback, useEffect, useState, useRef } from 'react'
import { Gesture } from 'react-native-gesture-handler'

import {
  DECELERATION,
  MIN_VELOCITY,
  VELOCITY_SCALE,
  SCROLL_TO_DURATION,
  MIN_SELECTION_DURATION,
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
  maxScrollOffset: number
  containerWidth: number
  duration: number
  externalPosition: number
  onSeek: (position: number) => void
  selection?: SelectionConfig
}

export interface TimelinePhysicsResult {
  scrollOffsetRef: React.MutableRefObject<number>
  displayPosition: number
  frame: number
  gesture: ReturnType<typeof Gesture.Race>
}

export function useTimelinePhysics({
  maxScrollOffset,
  containerWidth,
  duration,
  externalPosition,
  onSeek,
  selection,
}: UseTimelinePhysicsOptions): TimelinePhysicsResult {
  const [frame, setFrame] = useState(0)
  const [displayPosition, setDisplayPosition] = useState(externalPosition)

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

      updateDisplayPosition(xToTime(scrollOffsetRef.current))
      setFrame(f => f + 1)

      if (progress < 1) {
        rafIdRef.current = requestAnimationFrame(tick)
      } else {
        animationRef.current = null
        rafIdRef.current = null
        updateDisplayPosition(xToTime(scrollOffsetRef.current), true) // Force final update
        onSeek(xToTime(scrollOffsetRef.current))
      }
    }

    rafIdRef.current = requestAnimationFrame(tick)
  }, [maxScrollOffset, onSeek, stopAnimation, updateDisplayPosition])

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

        updateDisplayPosition(xToTime(scrollOffsetRef.current))
        setFrame(f => f + 1)
        rafIdRef.current = requestAnimationFrame(tick)
      } else {
        velocityRef.current = 0
        rafIdRef.current = null
        updateDisplayPosition(xToTime(scrollOffsetRef.current), true) // Force final update
        onSeek(xToTime(scrollOffsetRef.current))
      }
    }

    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
    }
    animationRef.current = null
    rafIdRef.current = requestAnimationFrame(tick)
  }, [maxScrollOffset, onSeek, updateDisplayPosition])

  // Sync to external position when idle
  useEffect(() => {
    if (!isDraggingRef.current && rafIdRef.current === null && !draggingHandleRef.current) {
      scrollOffsetRef.current = timeToX(externalPosition)
      updateDisplayPosition(externalPosition, true) // Always sync when idle
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

    const startHandleX = timeToX(selection.start)
    const endHandleX = timeToX(selection.end)

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
      onSeek(xToTime(scrollOffsetRef.current))
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
    const tappedTime = xToTime(scrollOffsetRef.current + offsetFromCenter)
    const clampedTime = clamp(tappedTime, 0, duration)

    animateToPosition(timeToX(clampedTime))
  }, [containerWidth, duration, animateToPosition])

  const onPanStart = useCallback((x: number, y: number) => {
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
    if (draggingHandleRef.current && selection) {
      // Dragging a handle
      const deltaTime = xToTime(translationX)
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
      maxScrollOffset
    )
    updateDisplayPosition(xToTime(scrollOffsetRef.current))
    setFrame(f => f + 1)
  }, [selection, duration, maxScrollOffset, updateDisplayPosition])

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
      onSeek(xToTime(scrollOffsetRef.current))
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

  const gesture = Gesture.Race(panGesture, tapGesture)

  return {
    scrollOffsetRef,
    displayPosition,
    frame,
    gesture,
  }
}
