/**
 * TimelineBarRaf
 *
 * An interactive audio timeline for scrubbing through audio files.
 *
 *
 * ## What You're Looking At
 *
 * Visually, this component displays:
 *
 *   - A horizontal row of vertical bars, like a waveform visualization
 *   - A thin vertical line (the "playhead") fixed at the center of the screen
 *   - Time indicators showing current position and total duration
 *
 * The bars represent segments of time. Each bar = 5 seconds of audio. A 1-hour
 * file has 720 bars; a 20-hour audiobook has 14,400. The varying bar heights
 * are decorative (a fake waveform pattern), not actual audio analysis.
 *
 * Bars to the LEFT of the playhead are "played" (gray). Bars to the RIGHT are
 * "unplayed" (colored). If a bar straddles the playhead, it's split-colored.
 *
 *
 * ## How Interaction Works
 *
 * The playhead stays fixed at center. When the user drags, the bars scroll
 * behind the playhead - like scrubbing a video timeline. This creates the
 * illusion of moving through time.
 *
 * Supported interactions:
 *   - **Drag** to scrub through the audio
 *   - **Flick** to scroll with momentum (gradually decelerates)
 *   - **Tap** to seek to that position (animates smoothly)
 *   - **Tap while scrolling** to stop the momentum
 *
 *
 * ## The Performance Challenge
 *
 * The naive React approach would create one <View> component per bar. With
 * 14,400 bars, that's 14,400 components. During playback or scrolling, many
 * would re-render every frame. This destroys performance and drains battery.
 *
 * Our solution: don't use React components for bars at all. Instead, we draw
 * directly to a GPU-accelerated canvas using react-native-skia. The entire
 * visible timeline is one draw operation, and we only draw the bars currently
 * on screen.
 *
 *
 * ## How Drawing Works
 *
 * We use Skia's "Picture" API. A Picture is a recorded sequence of drawing
 * commands that can be replayed efficiently. Each frame:
 *
 *   1. We figure out which bars are visible given the current scroll position
 *   2. We draw just those bars to a Picture (with appropriate colors)
 *   3. Skia renders the Picture to the screen
 *
 * The drawing logic is a plain function (`drawTimeline`) that takes a canvas
 * and the current state, then imperatively draws rectangles. No components,
 * no JSX, no reconciliation.
 *
 *
 * ## How Animation Works
 *
 * Smooth 60fps animation requires updating position every ~16ms. React state
 * updates are too slow for this - each setState schedules a re-render, and
 * the overhead adds up.
 *
 * Instead, we store animation values (scroll position, velocity) in refs.
 * Refs can be mutated instantly without scheduling anything. A
 * requestAnimationFrame loop updates these refs directly.
 *
 * But we still need React to re-render so we can rebuild the Picture. We use
 * a simple trick: a "frame" counter in state. When the animation loop wants
 * a redraw, it increments the counter. This triggers exactly one re-render,
 * which rebuilds the Picture using the current ref values.
 *
 *
 * ## Code Organization
 *
 * Reading top to bottom, you'll find:
 *
 *   1. **Constants** - Dimensions, timing, physics tuning values
 *
 *   2. **Utility functions** - Coordinate conversion, bar height calculation
 *
 *   3. **drawTimeline()** - The pure drawing function. Takes canvas + state,
 *      draws the visible bars. This is where the actual rendering happens.
 *
 *   4. **useScrollPhysics()** - Custom hook containing all the scroll logic:
 *      gesture handling, momentum physics, tap-to-seek animation, and the
 *      frame counter. Returns everything the component needs.
 *
 *   5. **TimelineBar** - The main component. Surprisingly small because
 *      useScrollPhysics does the heavy lifting. Just wires up the canvas,
 *      gestures, and layout.
 *
 *   6. **TimeIndicators** - Tiny subcomponent for the time display.
 *
 *   7. **Styles** - Standard React Native StyleSheet.
 */

import { useCallback, useMemo, useEffect, useState, useRef } from 'react'
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
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler'
import { useStore } from '../store'
import { Color } from '../theme'

// Layout constants
const SEGMENT_WIDTH = 4
const SEGMENT_GAP = 2
const SEGMENT_STEP = SEGMENT_WIDTH + SEGMENT_GAP
const SEGMENT_DURATION = 5000 // 5 seconds per segment
const TIMELINE_HEIGHT = 90
const PLAYHEAD_WIDTH = 2
const PLACEHOLDER_HEIGHT = 8 // Small height for virtual bars at ends

// Physics constants
const DECELERATION = 0.95 // Velocity multiplier per frame
const MIN_VELOCITY = 0.5 // Stop momentum below this
const VELOCITY_SCALE = 1 / 60 // Convert gesture velocity (px/s) to px/frame

// Animation constants
const SCROLL_TO_DURATION = 200 // ms for tap-to-seek animation

// Precompute segment heights
const MAX_PRECOMPUTED_SEGMENTS = 10000
const SEGMENT_HEIGHTS = new Float32Array(MAX_PRECOMPUTED_SEGMENTS)
for (let i = 0; i < MAX_PRECOMPUTED_SEGMENTS; i++) {
  SEGMENT_HEIGHTS[i] = computeSegmentHeight(i)
}

function computeSegmentHeight(index: number): number {
  const baseHeight = TIMELINE_HEIGHT / 2
  const variation = TIMELINE_HEIGHT / 4

  let height = baseHeight
  height += Math.sin(index * 0.15) * variation
  height += Math.sin(index * 0.4) * (variation * 0.5)
  height += Math.sin(index * 2) * (variation * 0.3)
  height += ((index * 7919) % 100) / 100 * 8

  return Math.max(12, Math.min(TIMELINE_HEIGHT, height))
}

function getSegmentHeight(index: number): number {
  if (index >= 0 && index < MAX_PRECOMPUTED_SEGMENTS) {
    return SEGMENT_HEIGHTS[index]
  }
  return computeSegmentHeight(index)
}

function timeToX(time: number): number {
  return (time / SEGMENT_DURATION) * SEGMENT_STEP
}

function xToTime(x: number): number {
  return (x / SEGMENT_STEP) * SEGMENT_DURATION
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

// Imperative drawing function - draws visible segments to canvas
function drawTimeline(
  canvas: SkCanvas,
  scrollOffset: number,
  containerWidth: number,
  totalSegments: number
) {
  // Create paints fresh each draw (Skia context safety)
  const played = Skia.Paint()
  played.setColor(Skia.Color(Color.GRAY))

  const unplayed = Skia.Paint()
  unplayed.setColor(Skia.Color(Color.PRIMARY))

  const placeholder = Skia.Paint()
  placeholder.setColor(Skia.Color(Color.GRAY))

  const halfWidth = containerWidth / 2
  // The playhead is at center of screen, which corresponds to scrollOffset in timeline coordinates
  const playheadX = scrollOffset

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
    // Draw from visible start to timeline start
    let x = Math.floor(visibleStartX / SEGMENT_STEP) * SEGMENT_STEP
    while (x < timelineStartX) {
      const h = PLACEHOLDER_HEIGHT // - (Math.cos(x * 3 + 3) + 1) * (PLACEHOLDER_HEIGHT / 4)
      const y = (TIMELINE_HEIGHT - h) / 2
      canvas.drawRRect(
        Skia.RRectXY(Skia.XYWHRect(x, y, SEGMENT_WIDTH, h), 2, 2),
        placeholder
      )
      x += SEGMENT_STEP
    }
  }

  // Draw real segments
  for (let i = startSegment; i < endSegment; i++) {
    const x = i * SEGMENT_STEP
    const segmentEnd = x + SEGMENT_WIDTH
    const height = getSegmentHeight(i)
    const y = (TIMELINE_HEIGHT - height) / 2

    if (segmentEnd <= playheadX) {
      // Fully played - draw gray
      canvas.drawRRect(
        Skia.RRectXY(Skia.XYWHRect(x, y, SEGMENT_WIDTH, height), 2, 2),
        played
      )
    } else if (x >= playheadX) {
      // Fully unplayed - draw cyan
      canvas.drawRRect(
        Skia.RRectXY(Skia.XYWHRect(x, y, SEGMENT_WIDTH, height), 2, 2),
        unplayed
      )
    } else {
      // Segment straddles playhead - draw split
      const playedWidth = playheadX - x
      const unplayedWidth = segmentEnd - playheadX

      // Played portion (left side) - clip to left of playhead
      canvas.save()
      canvas.clipRect(Skia.XYWHRect(x, y, playedWidth, height), ClipOp.Intersect, true)
      canvas.drawRRect(
        Skia.RRectXY(Skia.XYWHRect(x, y, SEGMENT_WIDTH, height), 2, 2),
        played
      )
      canvas.restore()

      // Unplayed portion (right side) - clip to right of playhead
      canvas.save()
      canvas.clipRect(Skia.XYWHRect(playheadX, y, unplayedWidth, height), ClipOp.Intersect, true)
      canvas.drawRRect(
        Skia.RRectXY(Skia.XYWHRect(x, y, SEGMENT_WIDTH, height), 2, 2),
        unplayed
      )
      canvas.restore()
    }
  }

  // Draw placeholder bars on the RIGHT (after timeline end)
  if (visibleEndX > timelineEndX) {
    const placeholderY = (TIMELINE_HEIGHT - PLACEHOLDER_HEIGHT) / 2
    // Draw from timeline end to visible end
    let x = timelineEndX
    while (x < visibleEndX) {
      canvas.drawRRect(
        Skia.RRectXY(Skia.XYWHRect(x, placeholderY, SEGMENT_WIDTH, PLACEHOLDER_HEIGHT), 2, 2),
        placeholder
      )
      x += SEGMENT_STEP
    }
  }

  canvas.restore()
}

// =============================================================================
// useScrollPhysics - Custom hook for scroll momentum and tap-to-seek animation
// =============================================================================

interface UseScrollPhysicsOptions {
  maxScrollOffset: number
  containerWidth: number
  duration: number
  externalPosition: number
  onSeek: (position: number) => void
}

function useScrollPhysics({
  maxScrollOffset,
  containerWidth,
  duration,
  externalPosition,
  onSeek,
}: UseScrollPhysicsOptions) {
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

  // Ease-out function for smooth animation
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

  // Sync to external playback position when idle
  useEffect(() => {
    if (!isDraggingRef.current && rafIdRef.current === null) {
      scrollOffsetRef.current = timeToX(externalPosition)
      setDisplayPosition(externalPosition)
      setFrame(f => f + 1)
    }
  }, [externalPosition])

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

// =============================================================================
// TimelineBar - Main component
// =============================================================================

export default function TimelineBar() {
  const { player, seek } = useStore()
  const [containerWidth, setContainerWidth] = useState(0)

  const totalSegments = Math.ceil(player.duration / SEGMENT_DURATION)
  const maxScrollOffset = timeToX(player.duration)

  const { scrollOffsetRef, displayPosition, frame, gesture } = useScrollPhysics({
    maxScrollOffset,
    containerWidth,
    duration: player.duration,
    externalPosition: player.position,
    onSeek: seek,
  })

  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    setContainerWidth(event.nativeEvent.layout.width)
  }, [])

  // Create picture imperatively - rebuilt when frame changes
  const picture = useMemo(() => {
    if (containerWidth === 0 || totalSegments === 0) return null

    try {
      return createPicture(
        (canvas) => {
          drawTimeline(
            canvas,
            scrollOffsetRef.current,
            containerWidth,
            totalSegments
          )
        },
        { width: containerWidth, height: TIMELINE_HEIGHT }
      )
    } catch (error) {
      console.error('Error creating picture:', error)
      return null
    }
  }, [frame, containerWidth, totalSegments])

  return (
    <GestureHandlerRootView style={styles.container}>
      {/* Playhead indicator at center */}
      <View style={styles.playheadContainer} pointerEvents="none">
        <View style={styles.playhead} />
      </View>

      {/* Timeline with gesture handling */}
      <GestureDetector gesture={gesture}>
        <View style={styles.timelineContainer} onLayout={handleLayout}>
          {/* Skia Canvas with imperative Picture - only render when ready */}
          {containerWidth > 0 && (
            <Canvas style={{ width: containerWidth, height: TIMELINE_HEIGHT }}>
              {picture && <Picture picture={picture} />}
            </Canvas>
          )}
        </View>
      </GestureDetector>

      {/* Time indicators */}
      <TimeIndicators position={displayPosition} duration={player.duration} />
    </GestureHandlerRootView>
  )
}

function TimeIndicators({ position, duration }: { position: number; duration: number }) {
  return (
    <View style={styles.timeContainer}>
      <View style={styles.timeSpacer} />
      <Text style={styles.timeCurrent}>{formatTime(position)}</Text>
      <Text style={styles.timeTotal}>{formatTime(duration)}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  timelineContainer: {
    height: TIMELINE_HEIGHT,
    justifyContent: 'center',
    marginBottom: 8,
    overflow: 'hidden',
  },
  playheadContainer: {
    position: 'absolute',
    top: 10,
    left: 0,
    right: 0,
    height: TIMELINE_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
  },
  playhead: {
    width: PLAYHEAD_WIDTH,
    height: TIMELINE_HEIGHT,
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
