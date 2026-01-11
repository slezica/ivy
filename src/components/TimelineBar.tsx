/**
 * TimelineBar
 *
 * Unified playback control with absolute-duration segments.
 * Each segment represents 5 seconds, displayed as an 8px vertical bar.
 * Current position is at the center of the screen with a playhead indicator.
 */

import { useRef, useEffect, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  GestureResponderEvent,
} from 'react-native'
import { useStore } from '../store'
import { Color } from '../theme'

const SEGMENT_WIDTH = 4 // pixels
const SEGMENT_GAP = 2 // pixels - gap between segments
const SEGMENT_DURATION = 5000 // milliseconds (5 seconds)
const SEGMENT_HEIGHT = 40
const END_SEGMENT_HEIGHT = 8 // smaller bars at the end
const MARKER_SIZE = 16 // pixels - clip marker diameter
const TIMELINE_HEIGHT = 60 // pixels - timeline container height

export default function TimelineBar() {
  const { playback, seek, clips } = useStore()

  const scrollViewRef = useRef<ScrollView>(null)
  const scrollX = useRef(0)
  const isScrolling = useRef(false)
  const isTapScrolling = useRef(false) // Track if scroll is from tap vs drag
  const tapAnimationTimeout = useRef<NodeJS.Timeout | null>(null) // Track timeout for clearing

  // Container width as state so component re-renders when measured
  const [containerWidth, setContainerWidth] = useState(0)

  // Display position (follows scroll while dragging, playback position otherwise)
  const [displayPosition, setDisplayPosition] = useState(playback.position)

  // Calculate number of segments
  const totalSegments = Math.ceil(playback.duration / SEGMENT_DURATION)

  // Number of initial/end placeholder segments - fill half screen width each
  const halfScreenSegments = containerWidth > 0 ? Math.ceil((containerWidth / 2) / (SEGMENT_WIDTH + SEGMENT_GAP)) : 0

  // Calculate which segment index corresponds to current playback position
  const currentSegmentIndex = Math.floor(playback.position / SEGMENT_DURATION)

  // Convert clips object to array
  const clipsArray = Object.values(clips)

  // Auto-scroll to keep current position at center during playback
  useEffect(() => {
    if (!isScrolling.current && scrollViewRef.current && containerWidth > 0) {
      // Position current time at center by offsetting by half container width
      // Account for initial placeholder offset
      const placeholderOffset = halfScreenSegments * (SEGMENT_WIDTH + SEGMENT_GAP)
      const scrollToPosition = placeholderOffset + timeToScroll(playback.position) - (containerWidth / 2)
      scrollViewRef.current.scrollTo({ x: Math.max(0, scrollToPosition), animated: false })
      scrollX.current = Math.max(0, scrollToPosition)
    }

    // Update display position when not scrolling
    if (!isScrolling.current) {
      setDisplayPosition(playback.position)
    }
  }, [playback.position, containerWidth, halfScreenSegments])

  const handleTouchEnd = async (event: GestureResponderEvent) => {
    if (containerWidth === 0) return

    // Clear any pending animation timeout from previous taps
    if (tapAnimationTimeout.current) {
      clearTimeout(tapAnimationTimeout.current)
    }

    // Calculate which position was tapped in the timeline content
    const tappedX = event.nativeEvent.locationX

    // Subtract the initial placeholder offset to get actual audio position
    const placeholderOffset = halfScreenSegments * (SEGMENT_WIDTH + SEGMENT_GAP)
    const adjustedTappedX = tappedX - placeholderOffset

    // Convert to timestamp and seek to that position
    const tappedTime = scrollToTime(adjustedTappedX)
    const finalSeekPosition = Math.max(0, Math.min(tappedTime, playback.duration))

    // Mark this as a tap-initiated scroll (not user drag)
    isScrolling.current = true
    isTapScrolling.current = true

    // Animate scroll to target position
    const targetScrollPosition = placeholderOffset + timeToScroll(finalSeekPosition) - (containerWidth / 2)
    scrollViewRef.current?.scrollTo({ x: Math.max(0, targetScrollPosition), animated: true })

    // Update scroll position ref
    scrollX.current = Math.max(0, targetScrollPosition)

    // Seek audio immediately (no audio delay)
    await seek(finalSeekPosition)

    // Clear scrolling flags after animation completes (typical animation is ~300ms)
    tapAnimationTimeout.current = setTimeout(() => {
      isScrolling.current = false
      isTapScrolling.current = false
      tapAnimationTimeout.current = null
    }, 350)
  }

  const handleScrollBeginDrag = () => {
    isScrolling.current = true
  }

  const handleScroll = (event: any) => {
    scrollX.current = event.nativeEvent.contentOffset.x

    // Update display position based on scroll - center of screen is current position
    // Account for initial placeholder offset
    const placeholderOffset = halfScreenSegments * (SEGMENT_WIDTH + SEGMENT_GAP)
    const centerScrollX = scrollX.current + (containerWidth / 2)
    const scrollPosition = scrollToTime(centerScrollX - placeholderOffset)
    setDisplayPosition(Math.max(0, Math.min(scrollPosition, playback.duration)))
  }

  const handleMomentumScrollEnd = (event: any) => {
    // Don't seek if this was a tap-initiated scroll (already seeked)
    if (!isTapScrolling.current) {
      const finalScrollX = event.nativeEvent.contentOffset.x
      // Center of screen determines current position
      // Account for initial placeholder offset
      const placeholderOffset = halfScreenSegments * (SEGMENT_WIDTH + SEGMENT_GAP)
      const centerScrollX = finalScrollX + (containerWidth / 2)
      const newPosition = scrollToTime(centerScrollX - placeholderOffset)
      seek(Math.max(0, Math.min(newPosition, playback.duration)))
    }

    // Only clear scrolling flag after all momentum has stopped
    isScrolling.current = false
    isTapScrolling.current = false
  }

  return (
    <View style={styles.container}>
      {/* Playhead indicator at center */}
      <View style={styles.playheadContainer} pointerEvents="none">
        <View style={styles.playhead} />
      </View>

      {/* Scrollable segments */}
      <View
        style={styles.timelineContainer}
        onLayout={(e) => {
          setContainerWidth(e.nativeEvent.layout.width)
        }}
      >
        <ScrollView
          ref={scrollViewRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          onScrollBeginDrag={handleScrollBeginDrag}
          onScroll={handleScroll}
          onTouchEnd={handleTouchEnd}
          onMomentumScrollEnd={handleMomentumScrollEnd}
          scrollEventThrottle={16}
        >
          <View style={styles.segmentsContainer}>
            {/* Initial placeholder segments (left half) */}
            {Array.from({ length: halfScreenSegments }).map((_, index) => (
              <SegmentBar key={`start-${index}`} isEndSegment={true} />
            ))}

            {/* Main segments */}
            {Array.from({ length: totalSegments }).map((_, index) => (
              <SegmentBar
                key={`segment-${index}`}
                isEndSegment={false}
                isPlayed={index <= currentSegmentIndex}
                height={getSegmentHeight(index)}
              />
            ))}

            {/* End placeholder segments (right half) */}
            {Array.from({ length: halfScreenSegments }).map((_, index) => (
              <SegmentBar key={`end-${index}`} isEndSegment={true} />
            ))}

            {/* Clip markers */}
            {clipsArray.map((clip) => (
              <ClipMarker key={clip.id} position={clip.start} initialOffset={halfScreenSegments} />
            ))}
          </View>
        </ScrollView>
      </View>

      <TimeIndicators current={displayPosition} total={playback.duration} />
    </View>
  )
}

// ============================================================================
// Subcomponents
// ============================================================================

interface SegmentBarProps {
  isEndSegment: boolean
  isPlayed?: boolean
  height?: number
}

function SegmentBar({ isEndSegment, isPlayed = false, height }: SegmentBarProps) {
  const segmentHeight = height || (isEndSegment ? END_SEGMENT_HEIGHT : SEGMENT_HEIGHT)

  // Use gray for end segments and played segments, blue for unplayed segments
  const segmentStyle = isEndSegment || isPlayed ? styles.endSegment : styles.segment

  return (
    <View
      pointerEvents="none"
      style={[
        segmentStyle,
        { height: segmentHeight },
      ]}
    />
  )
}

interface TimeIndicatorsProps {
  current: number
  total: number
}

function TimeIndicators({ current, total }: TimeIndicatorsProps) {
  return (
    <View style={styles.timeContainer}>
      <View style={styles.timeSpacer} />
      <Text style={styles.timeCurrent}>{formatTime(current)}</Text>
      <Text style={styles.timeTotal}>{formatTime(total)}</Text>
    </View>
  )
}

interface ClipMarkerProps {
  position: number // position in milliseconds
  initialOffset: number // number of initial placeholder segments
}

function ClipMarker({ position, initialOffset }: ClipMarkerProps) {
  const timePosition = timeToScroll(position)
  const placeholderOffset = initialOffset * (SEGMENT_WIDTH + SEGMENT_GAP)
  const leftPosition = placeholderOffset + timePosition

  return (
    <View
      pointerEvents="none"
      style={[
        styles.clipMarker,
        { left: leftPosition - MARKER_SIZE / 2 }
      ]}
    />
  )
}

// ============================================================================
// Utilities
// ============================================================================

function scrollToTime(scrollX: number): number {
  return (scrollX / (SEGMENT_WIDTH + SEGMENT_GAP)) * SEGMENT_DURATION
}

function timeToScroll(time: number): number {
  return (time / SEGMENT_DURATION) * (SEGMENT_WIDTH + SEGMENT_GAP)
}

function getSegmentHeight(index: number): number {
  // Create waveform-like variation using sine waves and pseudo-random noise
  const baseHeight = 30
  const variation = 15

  // Mix multiple sine waves for organic, smooth variation
  const wave1 = Math.sin(index * 0.15) * variation
  const wave2 = Math.sin(index * 0.4) * (variation * 0.5)
  const wave3 = Math.sin(index * 0.08) * (variation * 0.3)

  // Add some pseudo-random noise for texture
  const noise = ((index * 7919) % 100) / 100 * 8

  const height = baseHeight + wave1 + wave2 + wave3 + noise

  // Clamp between min and max heights
  return Math.max(12, Math.min(50, height))
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

// ============================================================================
// Styles
// ============================================================================

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  timelineContainer: {
    height: TIMELINE_HEIGHT,
    justifyContent: 'center',
    marginBottom: 8,
  },
  segmentsContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  segment: {
    width: SEGMENT_WIDTH,
    backgroundColor: Color.PRIMARY,
    borderRadius: 2,
  },
  endSegment: {
    width: SEGMENT_WIDTH,
    backgroundColor: Color.GRAY,
    borderRadius: 2,
  },
  clipMarker: {
    position: 'absolute',
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    backgroundColor: Color.SECONDARY,
    borderRadius: MARKER_SIZE / 2,
    top: (TIMELINE_HEIGHT - MARKER_SIZE) / 2,
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
    width: 2,
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
    color: Color.GRAY_DARK,
    fontWeight: '600',
  },
  timeTotal: {
    fontSize: 16,
    color: Color.GRAY_DARK,
    textAlign: 'right',
    flex: 1,
  },
})
