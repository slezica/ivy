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

import { useCallback, useEffect, useRef, useState } from 'react'
import { Gesture } from 'react-native-gesture-handler'

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
  /** Called on every visual frame — use to push picture imperatively */
  onFrame?: () => void
  selection?: SelectionConfig
  /** Playhead movement pushes selection anchors (see engine linked mode) */
  linkedSelection?: boolean
  canZoom?: boolean
  /** Tap skips ±ms from current position instead of seeking to the tapped point */
  tapSkip?: { backward: number; forward: number }
  /**
   * Playback rate driving smooth timeline motion (0 = paused).
   * While > 0 the engine advances the scroll itself each frame and treats
   * externalPosition updates as drift corrections.
   */
  playbackRate?: number
}

export interface TimelinePhysicsResult {
  scrollOffsetRef: React.MutableRefObject<number>
  /**
   * The engine's authoritative selection, updated every frame. Drawing code
   * must read this instead of the selection props: during handle drags and
   * linked pushing the engine mutates the selection at frame rate while
   * emissions to React state are throttled.
   */
  selectionRef: React.MutableRefObject<{ start: number; end: number } | null>
  /** Current zoom-scaled segment width */
  segmentWidth: number
  /** Current zoom-scaled segment gap */
  segmentGap: number
  displayPosition: number
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
  onFrame,
  selection,
  linkedSelection = false,
  canZoom = false,
  tapSkip,
  playbackRate = 0,
}: UseTimelinePhysicsOptions): TimelinePhysicsResult {
  // React state that triggers re-renders (only for time indicator text)
  const [displayPosition, setDisplayPosition] = useState(externalPosition)

  // Refs that Timeline.tsx reads during Skia picture creation
  const scrollOffsetRef = useRef(0)
  const selectionRef = useRef<{ start: number; end: number } | null>(null)

  // The rAF loop handle
  const rafIdRef = useRef<number | null>(null)

  // -----------------------------------------------------------------------
  // Stable refs for callbacks that may change between renders.
  //
  // The engine is created once and stores its callbacks permanently. But
  // onSeek/onSelectionChange are closures from the parent that capture
  // state (e.g. the current book URI). If we pass them directly at
  // construction, the engine would call stale versions forever.
  //
  // Solution: pass thin wrappers that dereference these refs, so the
  // engine always calls the latest closure.
  // -----------------------------------------------------------------------

  const onSeekRef = useRef(onSeek)
  onSeekRef.current = onSeek

  const onFrameRef = useRef(onFrame)
  onFrameRef.current = onFrame

  const onSelectionChangeRef = useRef(selection?.onChange)
  onSelectionChangeRef.current = selection?.onChange

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
        linked: linkedSelection,
        canZoom,
        tapSkip,
      },
      {
        onSeek: (pos) => onSeekRef.current(pos),
        onSelectionChange: (start, end) => onSelectionChangeRef.current?.(start, end),
        onFrame: () => {
          scrollOffsetRef.current = engineRef.current!.scrollOffset
          selectionRef.current = engineRef.current!.selection
          onFrameRef.current?.()
        },
        onDisplayPosition: (position) => {
          setDisplayPosition(position)
        },
      }
    )
    scrollOffsetRef.current = engineRef.current.scrollOffset
    selectionRef.current = engineRef.current.selection
  }

  const engine = engineRef.current

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
      selectionRef.current = engine.selection
    }
  }, [engine, selection?.start, selection?.end])

  useEffect(() => {
    engine.setLinked(linkedSelection)
  }, [engine, linkedSelection])

  useEffect(() => {
    engine.setPlaybackRate(playbackRate, performance.now())
    if (playbackRate > 0) {
      scheduleTick() // start the playback-follow loop (no-op if already running)
    }
  }, [engine, playbackRate, scheduleTick])

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
    // Fires for success, failure, and cancellation alike — the pan gesture
    // reaches a terminal state on every touch, so this guarantees leaked
    // handle-drag state is cleared and playback follow can resume even when
    // neither tap.onEnd nor pan.onEnd fired (e.g. a held-then-released touch).
    .onFinalize(() => {
      engine.touchUp()
      scheduleTick() // resume playback follow if the touch had blocked it
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
    selectionRef,
    segmentWidth: engine.segmentWidth,
    segmentGap: engine.segmentGap,
    displayPosition,
    gesture,
  }
}
