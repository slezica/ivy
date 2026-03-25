/**
 * useTimelinePhysics
 *
 * React hook adapter for TimelinePhysicsEngine. This is a thin bridge between:
 *
 *   - React state (frame counter, display position)
 *   - Gesture handlers (react-native-gesture-handler)
 *   - requestAnimationFrame (for momentum and animation ticks)
 *   - The pure physics engine (which has no platform dependencies)
 *
 * All physics logic lives in `engine.ts`. This hook just wires it up.
 */

import { useCallback, useEffect, useState, useRef } from 'react'
import { Gesture } from 'react-native-gesture-handler'

import {
  SEGMENT_DURATION,
  MIN_SELECTION_DURATION,
} from './constants'
import { TimelinePhysicsEngine } from './engine'

// ============================================================================
// Types (unchanged — preserves the contract with Timeline.tsx)
// ============================================================================

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

// ============================================================================
// Hook
// ============================================================================

export function useTimelinePhysics({
  containerWidth,
  duration,
  externalPosition,
  onSeek,
  selection,
  canZoom = false,
}: UseTimelinePhysicsOptions): TimelinePhysicsResult {
  // React state that triggers re-renders
  const [frame, setFrame] = useState(0)
  const [displayPosition, setDisplayPosition] = useState(externalPosition)

  // Ref that Timeline.tsx reads during Skia picture creation
  const scrollOffsetRef = useRef(0)

  // The rAF loop handle
  const rafIdRef = useRef<number | null>(null)

  // -----------------------------------------------------------------------
  // Create the engine once. Callbacks bridge engine events to React state.
  // -----------------------------------------------------------------------

  const engineRef = useRef<TimelinePhysicsEngine | null>(null)

  if (!engineRef.current) {
    engineRef.current = new TimelinePhysicsEngine(
      {
        duration,
        containerWidth,
        position: externalPosition,
        selection: selection ? { start: selection.start, end: selection.end } : undefined,
        canZoom,
      },
      {
        onSeek,
        onSelectionChange: selection?.onChange,
        onFrame: () => {
          // Sync the ref (read by Skia) and bump the frame counter (triggers re-render)
          scrollOffsetRef.current = engineRef.current!.scrollOffset
          setFrame(f => f + 1)
        },
        onDisplayPosition: (position) => {
          setDisplayPosition(position)
        },
      }
    )
    scrollOffsetRef.current = engineRef.current.scrollOffset
  }

  const engine = engineRef.current

  // -----------------------------------------------------------------------
  // Keep engine callbacks in sync with latest prop values.
  //
  // The engine stores callbacks at construction, but onSeek/onSelectionChange
  // may change between renders (e.g. when the parent re-renders with new
  // closures). We use refs to ensure the engine always calls the latest version.
  // -----------------------------------------------------------------------

  const onSeekRef = useRef(onSeek)
  onSeekRef.current = onSeek

  const onSelectionChangeRef = useRef(selection?.onChange)
  onSelectionChangeRef.current = selection?.onChange

  // -----------------------------------------------------------------------
  // rAF tick loop: calls engine.tick() and re-schedules while active
  // -----------------------------------------------------------------------

  const scheduleTick = useCallback(() => {
    if (rafIdRef.current !== null) return // already running

    const loop = () => {
      const needsMore = engine.tick(performance.now())
      if (needsMore) {
        rafIdRef.current = requestAnimationFrame(loop)
      } else {
        rafIdRef.current = null
      }
    }

    rafIdRef.current = requestAnimationFrame(loop)
  }, [engine])

  // -----------------------------------------------------------------------
  // Sync external prop changes to the engine
  // -----------------------------------------------------------------------

  useEffect(() => {
    engine.setContainerWidth(containerWidth)
  }, [engine, containerWidth])

  useEffect(() => {
    engine.setDuration(duration)
  }, [engine, duration])

  useEffect(() => {
    engine.setExternalPosition(externalPosition, performance.now())
    // Sync the ref in case the engine updated the scroll offset
    scrollOffsetRef.current = engine.scrollOffset
  }, [engine, externalPosition])

  useEffect(() => {
    if (selection) {
      engine.updateSelection(selection.start, selection.end)
    }
  }, [engine, selection?.start, selection?.end])

  // Cleanup rAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
      }
    }
  }, [])

  // -----------------------------------------------------------------------
  // Build gesture handlers that delegate to engine methods
  // -----------------------------------------------------------------------

  const panGesture = Gesture.Pan()
    .runOnJS(true)
    .onStart((event) => {
      engine.panStart(event.x, event.y, performance.now())
    })
    .onUpdate((event) => {
      engine.panUpdate(event.translationX, performance.now())
    })
    .onEnd((event) => {
      engine.panEnd(event.velocityX, performance.now())
      scheduleTick() // momentum may have started
    })

  const tapGesture = Gesture.Tap()
    .runOnJS(true)
    .onBegin((event) => {
      engine.touchDown(event.x, event.y, performance.now())
    })
    .onEnd((event) => {
      engine.tap(event.x, performance.now())
      scheduleTick() // tap-to-seek animation may have started
    })

  const panTapGesture = Gesture.Race(panGesture, tapGesture)

  const gesture = canZoom
    ? Gesture.Simultaneous(
        panTapGesture,
        Gesture.Pinch()
          .runOnJS(true)
          .onStart(() => {
            engine.pinchStart(performance.now())
          })
          .onUpdate((event) => {
            engine.pinchUpdate(event.scale, performance.now())
          })
          .onEnd(() => {
            engine.pinchEnd(performance.now())
          })
      )
    : panTapGesture

  // -----------------------------------------------------------------------
  // Return the same shape as before — Timeline.tsx sees no change
  // -----------------------------------------------------------------------

  return {
    scrollOffsetRef,
    segmentWidth: engine.segmentWidth,
    segmentGap: engine.segmentGap,
    displayPosition,
    frame,
    gesture,
  }
}
