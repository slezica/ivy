/**
 * Custom hook for scroll momentum and tap-to-seek animation.
 *
 * Manages scroll position using refs (not state) to enable 60fps animation
 * without React re-render overhead. A frame counter triggers redraws when needed.
 */

import { useCallback, useEffect, useState, useRef } from 'react'
import { Gesture } from 'react-native-gesture-handler'

import {
  DECELERATION,
  MIN_VELOCITY,
  VELOCITY_SCALE,
  SCROLL_TO_DURATION,
} from './constants'
import { timeToX, xToTime, clamp } from './utils'

export interface UseScrollPhysicsOptions {
  maxScrollOffset: number
  containerWidth: number
  duration: number
  externalPosition: number
  onSeek: (position: number) => void
  /** When true, scroll position syncs to externalPosition when idle. Default: true */
  autoSyncToPosition?: boolean
}

export interface ScrollPhysicsResult {
  scrollOffsetRef: React.MutableRefObject<number>
  displayPosition: number
  frame: number
  gesture: ReturnType<typeof Gesture.Race>
}

export function useScrollPhysics({
  maxScrollOffset,
  containerWidth,
  duration,
  externalPosition,
  onSeek,
  autoSyncToPosition = true,
}: UseScrollPhysicsOptions): ScrollPhysicsResult {
  // Frame counter - incrementing triggers picture rebuild
  const [frame, setFrame] = useState(0)
  const [displayPosition, setDisplayPosition] = useState(externalPosition)

  // Physics state (refs to avoid re-renders)
  const scrollOffsetRef = useRef(0)
  const velocityRef = useRef(0)
  const isDraggingRef = useRef(false)
  const dragStartOffsetRef = useRef(0)
  const rafIdRef = useRef<number | null>(null)

  // Animation state for tap-to-seek
  const animationRef = useRef<{
    startOffset: number
    targetOffset: number
    startTime: number
  } | null>(null)

  // Track if we stopped momentum on this touch (to skip seek on tap end)
  const stoppedMomentumRef = useRef(false)

  const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3)

  // Stop any running animation/momentum
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
      if (!animationRef.current || isDraggingRef.current) {
        animationRef.current = null
        rafIdRef.current = null
        return
      }

      const elapsed = performance.now() - animationRef.current.startTime
      const progress = Math.min(elapsed / SCROLL_TO_DURATION, 1)
      const easedProgress = easeOutCubic(progress)

      const { startOffset, targetOffset } = animationRef.current
      scrollOffsetRef.current = startOffset + (targetOffset - startOffset) * easedProgress

      setDisplayPosition(xToTime(scrollOffsetRef.current))
      setFrame(f => f + 1)

      if (progress < 1) {
        rafIdRef.current = requestAnimationFrame(tick)
      } else {
        animationRef.current = null
        rafIdRef.current = null
        onSeek(xToTime(scrollOffsetRef.current))
      }
    }

    rafIdRef.current = requestAnimationFrame(tick)
  }, [maxScrollOffset, onSeek, stopAnimation])

  // RAF loop for momentum physics
  const startMomentumLoop = useCallback(() => {
    const tick = () => {
      if (isDraggingRef.current) {
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

        setDisplayPosition(xToTime(scrollOffsetRef.current))
        setFrame(f => f + 1)
        rafIdRef.current = requestAnimationFrame(tick)
      } else {
        velocityRef.current = 0
        rafIdRef.current = null
        onSeek(xToTime(scrollOffsetRef.current))
      }
    }

    // Cancel existing RAF but preserve velocity (don't call stopAnimation)
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
    }
    animationRef.current = null
    rafIdRef.current = requestAnimationFrame(tick)
  }, [maxScrollOffset, onSeek])

  // Sync to external playback position when idle (if enabled)
  useEffect(() => {
    if (autoSyncToPosition && !isDraggingRef.current && rafIdRef.current === null) {
      scrollOffsetRef.current = timeToX(externalPosition)
      setDisplayPosition(externalPosition)
      setFrame(f => f + 1)
    }
  }, [externalPosition, autoSyncToPosition])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
      }
    }
  }, [])

  // --- Gesture handlers ---

  const handleTouchDown = useCallback(() => {
    if (rafIdRef.current !== null || animationRef.current !== null) {
      stopAnimation()
      stoppedMomentumRef.current = true
      onSeek(xToTime(scrollOffsetRef.current))
    } else {
      stoppedMomentumRef.current = false
    }
  }, [onSeek, stopAnimation])

  const handleTap = useCallback((x: number) => {
    if (stoppedMomentumRef.current) {
      stoppedMomentumRef.current = false
      return
    }

    const halfWidth = containerWidth / 2
    const offsetFromCenter = x - halfWidth
    const tappedTime = xToTime(scrollOffsetRef.current + offsetFromCenter)
    const clampedTime = clamp(tappedTime, 0, duration)

    animateToPosition(timeToX(clampedTime))
  }, [containerWidth, duration, animateToPosition])

  const onPanStart = useCallback(() => {
    isDraggingRef.current = true
    velocityRef.current = 0
    dragStartOffsetRef.current = scrollOffsetRef.current
    stopAnimation()
  }, [stopAnimation])

  const onPanUpdate = useCallback((translationX: number) => {
    scrollOffsetRef.current = clamp(
      dragStartOffsetRef.current - translationX,
      0,
      maxScrollOffset
    )
    setDisplayPosition(xToTime(scrollOffsetRef.current))
    setFrame(f => f + 1)
  }, [maxScrollOffset])

  const onPanEnd = useCallback((velocityX: number) => {
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
    .onStart(onPanStart)
    .onUpdate((event) => onPanUpdate(event.translationX))
    .onEnd((event) => onPanEnd(event.velocityX))

  const tapGesture = Gesture.Tap()
    .runOnJS(true)
    .onBegin(handleTouchDown)
    .onEnd((event) => handleTap(event.x))

  const gesture = Gesture.Race(panGesture, tapGesture)

  return {
    scrollOffsetRef,
    displayPosition,
    frame,
    gesture,
  }
}
