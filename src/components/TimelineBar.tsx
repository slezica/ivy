/**
 * TimelineBar
 *
 * Unified playback control with absolute-duration segments.
 * Each segment represents 5 seconds, displayed as a 16px vertical bar.
 * Current position is at the left edge of the visible area.
 */

import { useRef, useEffect, useState } from 'react'
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Animated,
  GestureResponderEvent,
  ViewStyle,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useStore } from '../store'

const SEGMENT_WIDTH = 8 // pixels
const SEGMENT_GAP = 2 // pixels - gap between segments
const SEGMENT_DURATION = 5000 // milliseconds (5 seconds)
const SEGMENT_HEIGHT = 40
const END_SEGMENT_HEIGHT = 20 // smaller bars at the end
const MARKER_SIZE = 16 // pixels - clip marker diameter

export default function TimelineBar() {
  const { playback, seek, play, pause, skipForward, skipBackward, clips } = useStore()

  const scrollViewRef = useRef<ScrollView>(null)
  const scrollX = useRef(0)
  const isScrolling = useRef(false)

  // Hint animations
  const hintOpacity = useRef(new Animated.Value(1)).current
  const [showHint, setShowHint] = useState(true)
  const leftIconFlash = useRef(new Animated.Value(0)).current
  const centerIconFlash = useRef(new Animated.Value(0)).current
  const rightIconFlash = useRef(new Animated.Value(0)).current

  // Container width as state so component re-renders when measured
  const [containerWidth, setContainerWidth] = useState(0)

  // Display position (follows scroll while dragging, playback position otherwise)
  const [displayPosition, setDisplayPosition] = useState(playback.position)

  // Calculate number of segments
  const totalSegments = Math.ceil(playback.duration / SEGMENT_DURATION)

  // Number of end indicator segments - fill at least one screen width
  const endSegments = containerWidth > 0 ? Math.ceil(containerWidth / (SEGMENT_WIDTH + SEGMENT_GAP)) : 0

  // Convert clips object to array
  const clipsArray = Object.values(clips)

  // Fade in/out hints on mount
  useEffect(() => {
    Animated.sequence([
      Animated.delay(500),
      Animated.timing(hintOpacity, {
        toValue: 0,
        duration: 2000,
        useNativeDriver: true,
      }),
    ]).start(() => setShowHint(false))
  }, [])

  // Flash icon animation
  const flashIcon = (animatedValue: Animated.Value) => {
    Animated.sequence([
      Animated.timing(animatedValue, {
        toValue: 1,
        duration: 100,
        useNativeDriver: true,
      }),
      Animated.timing(animatedValue, {
        toValue: 0,
        duration: 300,
        useNativeDriver: true,
      }),
    ]).start()
  }

  // Auto-scroll to keep current position at left edge during playback
  useEffect(() => {
    if (!isScrolling.current && scrollViewRef.current) {
      const scrollToPosition = timeToScroll(playback.position)
      scrollViewRef.current.scrollTo({ x: scrollToPosition, animated: false })
      scrollX.current = scrollToPosition
    }

    // Update display position when not scrolling
    if (!isScrolling.current) {
      setDisplayPosition(playback.position)
    }
  }, [playback.position])

  const handleTouchEnd = async (event: GestureResponderEvent) => {
    if (containerWidth === 0) return

    // Calculate on-screen location based on current scroll offset
    const x = event.nativeEvent.locationX - scrollX.current

    if (x < 1/3 * containerWidth) {
      flashIcon(leftIconFlash)
      await skipBackward()

    } else if (x > 2/3 * containerWidth) {
      flashIcon(rightIconFlash)
      await skipForward()

    } else {
      flashIcon(centerIconFlash)
      if (playback.isPlaying) {
        await pause()
      } else {
        await play()
      }
    }
  }

  const handleScrollBeginDrag = () => {
    isScrolling.current = true
  }

  const handleScroll = (event: any) => {
    scrollX.current = event.nativeEvent.contentOffset.x

    // Update display position based on scroll
    const scrollPosition = scrollToTime(scrollX.current)
    setDisplayPosition(Math.min(scrollPosition, playback.duration))
  }

  const handleMomentumScrollEnd = (event: any) => {
    const finalScrollX = event.nativeEvent.contentOffset.x
    const newPosition = scrollToTime(finalScrollX)
    seek(Math.min(newPosition, playback.duration))

    // Only clear scrolling flag after all momentum has stopped
    isScrolling.current = false
  }

  return (
    <View style={styles.container}>
      {/* Hint icons overlay */}
      {showHint && (
        <Animated.View style={[styles.hintsContainer, { opacity: hintOpacity }]} pointerEvents="none">
          <Ionicons name="play-skip-back" size={28} color="#666" style={{ opacity: 0.5 }} />
          <Ionicons name={playback.isPlaying ? 'pause' : 'play'} size={28} color="#666" style={{ opacity: 0.5 }} />
          <Ionicons name="play-skip-forward" size={28} color="#666" style={{ opacity: 0.5 }} />
        </Animated.View>
      )}

      {/* Flash icons */}
      <FlashIcon opacity={leftIconFlash} position={styles.flashIconLeft} iconName="play-skip-back" />
      <FlashIcon opacity={centerIconFlash} position={styles.flashIconCenter} iconName={playback.isPlaying ? 'pause' : 'play'} />
      <FlashIcon opacity={rightIconFlash} position={styles.flashIconRight} iconName="play-skip-forward" />

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
          onMomentumScrollEnd={handleMomentumScrollEnd}
          onTouchEnd={handleTouchEnd}
          scrollEventThrottle={16}
        >
          <View style={styles.segmentsContainer}>
            {/* Main segments */}
            {Array.from({ length: totalSegments }).map((_, index) => (
              <SegmentBar key={`segment-${index}`} isEndSegment={false} />
            ))}
            {/* End indicator segments */}
            {Array.from({ length: endSegments }).map((_, index) => (
              <SegmentBar key={`end-${index}`} isEndSegment={true} />
            ))}

            {/* Clip markers */}
            {clipsArray.map((clip) => (
              <ClipMarker key={clip.id} position={clip.start} />
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

interface FlashIconProps {
  opacity: Animated.Value
  position: ViewStyle
  iconName: keyof typeof Ionicons.glyphMap
}

function FlashIcon({ opacity, position, iconName }: FlashIconProps) {
  return (
    <Animated.View style={[styles.flashIcon, position, { opacity }]} pointerEvents="none">
      <Ionicons name={iconName} size={28} color="#666" style={{ opacity: 0.5 }} />
    </Animated.View>
  )
}

interface SegmentBarProps {
  isEndSegment: boolean
}

function SegmentBar({ isEndSegment }: SegmentBarProps) {
  return (
    <View
      pointerEvents="none"
      style={[
        isEndSegment ? styles.endSegment : styles.segment,
        { height: isEndSegment ? END_SEGMENT_HEIGHT : SEGMENT_HEIGHT },
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
      <Text style={styles.time}>{formatTime(current)}</Text>
      <Text style={styles.time}>{formatTime(total)}</Text>
    </View>
  )
}

interface ClipMarkerProps {
  position: number // position in milliseconds
}

function ClipMarker({ position }: ClipMarkerProps) {
  const leftPosition = timeToScroll(position)

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
    height: 60,
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
    backgroundColor: '#007AFF',
    borderRadius: 2,
  },
  endSegment: {
    width: SEGMENT_WIDTH,
    backgroundColor: '#aaa',
    borderRadius: 2,
  },
  clipMarker: {
    position: 'absolute',
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    backgroundColor: '#FF6B6B',
    borderRadius: MARKER_SIZE / 2,
    top: (SEGMENT_HEIGHT - MARKER_SIZE) / 2,
  },
  timeContainer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  time: {
    fontSize: 16,
    color: '#666',
  },
  hintsContainer: {
    position: 'absolute',
    top: 28,
    left: 20,
    right: 20,
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: 20,
    zIndex: 10,
  },
  flashIcon: {
    position: 'absolute',
    zIndex: 5,
  },
  flashIconLeft: {
    left: 50,
    top: 28,
  },
  flashIconCenter: {
    left: '50%',
    marginLeft: -12,
    top: 28,
  },
  flashIconRight: {
    right: 50,
    top: 28,
  },
})
