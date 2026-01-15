/**
 * PlaybackTimeline (exported as TimelineBar for backward compatibility)
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
 * The drawing logic is a plain function (`drawPlaybackTimeline`) that takes a
 * canvas and the current state, then imperatively draws rectangles. No
 * components, no JSX, no reconciliation.
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
 * Shared code (constants, utils, scroll physics) lives in this directory.
 * This file contains only the playback-specific drawing and component.
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
import { useStore } from '../../store'
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
  useScrollPhysics,
} from '.'

// =============================================================================
// Drawing - Playback mode (played/unplayed bar colors)
// =============================================================================

/**
 * Draw the playback timeline with played (gray) and unplayed (primary) bars.
 * The playhead position determines the split point.
 */
function drawPlaybackTimeline(
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
    let x = Math.floor(visibleStartX / SEGMENT_STEP) * SEGMENT_STEP
    while (x < timelineStartX) {
      const h = PLACEHOLDER_HEIGHT
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
      // Fully unplayed - draw primary
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
// PlaybackTimeline - Main component
// =============================================================================

interface PlaybackTimelineProps {
  showTime?: 'top' | 'bottom' | 'hidden'
}

function PlaybackTimeline({ showTime = 'bottom' }: PlaybackTimelineProps) {
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
    autoSyncToPosition: true,
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
          drawPlaybackTimeline(
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

  // Calculate playhead top offset based on time indicator position
  const playheadTop = showTime === 'top'
    ? 10 + TIME_INDICATORS_HEIGHT + TIME_INDICATORS_MARGIN
    : 10

  return (
    <GestureHandlerRootView style={styles.container}>
      {showTime === 'top' && (
        <TimeIndicators
          position={displayPosition}
          duration={player.duration}
          placement="top"
        />
      )}

      {/* Playhead indicator at center */}
      <View style={[styles.playheadContainer, { top: playheadTop }]} pointerEvents="none">
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

      {showTime === 'bottom' && (
        <TimeIndicators
          position={displayPosition}
          duration={player.duration}
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
    height: TIMELINE_HEIGHT,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  playheadContainer: {
    position: 'absolute',
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

// =============================================================================
// Exports
// =============================================================================

export { PlaybackTimeline }
export default PlaybackTimeline // Backward compatible default export
