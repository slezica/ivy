/**
 * TimelineBarRaf
 *
 * RAF-based timeline with imperative Skia drawing and custom scroll physics.
 *
 * Architecture:
 * - Drawing: Imperative via Skia Picture API, no segment components
 * - Physics: Custom momentum/deceleration in RAF loop
 * - State: Pure refs for scroll/velocity (minimal React state)
 * - Gestures: Pan with velocity capture, tap detection
 */

import { useCallback, useMemo, useEffect, useState, useRef } from 'react'
import { View, StyleSheet, LayoutChangeEvent } from 'react-native'
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
import Animated from 'react-native-reanimated'
import { useStore } from '../store'
import { Color } from '../theme'

// Layout constants
const SEGMENT_WIDTH = 4
const SEGMENT_GAP = 2
const SEGMENT_STEP = SEGMENT_WIDTH + SEGMENT_GAP
const SEGMENT_DURATION = 5000 // 5 seconds per segment
const TIMELINE_HEIGHT = 60
const PLAYHEAD_WIDTH = 2
const PLACEHOLDER_HEIGHT = 4 // Small height for virtual bars at ends

// Physics constants
const DECELERATION = 0.95 // Velocity multiplier per frame
const MIN_VELOCITY = 0.5 // Stop momentum below this
const VELOCITY_SCALE = 1 / 60 // Convert gesture velocity (px/s) to px/frame

// Precompute segment heights
const MAX_PRECOMPUTED_SEGMENTS = 10000
const SEGMENT_HEIGHTS = new Float32Array(MAX_PRECOMPUTED_SEGMENTS)
for (let i = 0; i < MAX_PRECOMPUTED_SEGMENTS; i++) {
  SEGMENT_HEIGHTS[i] = computeSegmentHeight(i)
}

function computeSegmentHeight(index: number): number {
  const baseHeight = 30
  const variation = 15
  const wave1 = Math.sin(index * 0.15) * variation
  const wave2 = Math.sin(index * 0.4) * (variation * 0.5)
  const wave3 = Math.sin(index * 0.08) * (variation * 0.3)
  const noise = ((index * 7919) % 100) / 100 * 8
  const height = baseHeight + wave1 + wave2 + wave3 + noise
  return Math.max(12, Math.min(50, height))
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
    const placeholderY = (TIMELINE_HEIGHT - PLACEHOLDER_HEIGHT) / 2
    // Draw from visible start to timeline start
    let x = Math.floor(visibleStartX / SEGMENT_STEP) * SEGMENT_STEP
    while (x < timelineStartX) {
      canvas.drawRRect(
        Skia.RRectXY(Skia.XYWHRect(x, placeholderY, SEGMENT_WIDTH, PLACEHOLDER_HEIGHT), 2, 2),
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

export default function TimelineBarRaf() {
  const { playback, seek } = useStore()

  // Layout state
  const [containerWidth, setContainerWidth] = useState(0)

  // Frame counter - incrementing this triggers picture rebuild
  const [frame, setFrame] = useState(0)

  // Physics state (refs to avoid re-renders)
  const scrollOffsetRef = useRef(0)
  const velocityRef = useRef(0)
  const isDraggingRef = useRef(false)
  const dragStartOffsetRef = useRef(0)
  const rafIdRef = useRef<number | null>(null)

  // Display position for time indicator
  const [displayPosition, setDisplayPosition] = useState(playback.position)

  // Computed values
  const totalSegments = Math.ceil(playback.duration / SEGMENT_DURATION)
  const maxScrollOffset = timeToX(playback.duration)

  // RAF loop for momentum physics
  const startMomentumLoop = useCallback(() => {
    const tick = () => {
      if (isDraggingRef.current) {
        // Stop loop if user started dragging again
        rafIdRef.current = null
        return
      }

      if (Math.abs(velocityRef.current) > MIN_VELOCITY) {
        // Apply velocity
        scrollOffsetRef.current = clamp(
          scrollOffsetRef.current + velocityRef.current,
          0,
          maxScrollOffset
        )

        // Apply deceleration
        velocityRef.current *= DECELERATION

        // Update display
        setDisplayPosition(xToTime(scrollOffsetRef.current))

        // Trigger redraw
        setFrame(f => f + 1)

        // Continue loop
        rafIdRef.current = requestAnimationFrame(tick)
      } else {
        // Momentum finished - seek to final position
        velocityRef.current = 0
        rafIdRef.current = null
        seek(xToTime(scrollOffsetRef.current))
      }
    }

    // Cancel any existing loop
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
    }

    rafIdRef.current = requestAnimationFrame(tick)
  }, [maxScrollOffset, seek])

  // Sync to playback position when not interacting
  useEffect(() => {
    if (!isDraggingRef.current && rafIdRef.current === null) {
      scrollOffsetRef.current = timeToX(playback.position)
      setDisplayPosition(playback.position)
      setFrame(f => f + 1)
    }
  }, [playback.position])

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
      }
    }
  }, [])

  // Tap handler (coordinates available, no-op for now)
  const handleTap = useCallback((x: number, y: number) => {
    // Convert tap position to timeline position
    const halfWidth = containerWidth / 2
    const offsetFromCenter = x - halfWidth
    const tappedTime = xToTime(scrollOffsetRef.current + offsetFromCenter)
    const clampedTime = clamp(tappedTime, 0, playback.duration)

    // TODO: Tap handling logic here
    // For now, just seek to tapped position
    scrollOffsetRef.current = timeToX(clampedTime)
    setDisplayPosition(clampedTime)
    setFrame(f => f + 1)
    seek(clampedTime)
  }, [containerWidth, playback.duration, seek])

  // Gesture callbacks (run on JS thread)
  const onPanStart = useCallback(() => {
    isDraggingRef.current = true
    velocityRef.current = 0
    dragStartOffsetRef.current = scrollOffsetRef.current

    // Stop any momentum loop
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
  }, [])

  const onPanUpdate = useCallback((translationX: number) => {
    const delta = -translationX
    scrollOffsetRef.current = clamp(
      dragStartOffsetRef.current + delta,
      0,
      maxScrollOffset
    )

    setDisplayPosition(xToTime(scrollOffsetRef.current))
    setFrame(f => f + 1)
  }, [maxScrollOffset])

  const onPanEnd = useCallback((velocityX: number) => {
    isDraggingRef.current = false

    // Capture velocity for momentum
    velocityRef.current = -velocityX * VELOCITY_SCALE

    if (Math.abs(velocityRef.current) > MIN_VELOCITY) {
      // Start momentum animation
      startMomentumLoop()
    } else {
      // No momentum - seek immediately
      seek(xToTime(scrollOffsetRef.current))
    }
  }, [startMomentumLoop, seek])

  // Pan gesture with velocity capture - runs on JS thread
  const panGesture = Gesture.Pan()
    .runOnJS(true)
    .onStart(onPanStart)
    .onUpdate((event) => onPanUpdate(event.translationX))
    .onEnd((event) => onPanEnd(event.velocityX))

  // Tap gesture - runs on JS thread
  const tapGesture = Gesture.Tap()
    .runOnJS(true)
    .onEnd((event) => {
      handleTap(event.x, event.y)
    })

  // Compose gestures - pan takes priority
  const composedGesture = Gesture.Race(panGesture, tapGesture)

  // Layout handler
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width
    setContainerWidth(width)
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
      <GestureDetector gesture={composedGesture}>
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
      <TimeIndicators position={displayPosition} duration={playback.duration} />
    </GestureHandlerRootView>
  )
}

// Time display component
function TimeIndicators({
  position,
  duration
}: {
  position: number
  duration: number
}) {
  return (
    <View style={styles.timeContainer}>
      <View style={styles.timeSpacer} />
      <Animated.Text style={styles.timeCurrent}>
        {formatTime(position)}
      </Animated.Text>
      <Animated.Text style={styles.timeTotal}>
        {formatTime(duration)}
      </Animated.Text>
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
