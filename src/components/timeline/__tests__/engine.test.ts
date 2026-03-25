/**
 * TimelinePhysicsEngine — Unit Tests
 *
 * These tests exercise the pure physics engine in isolation. Because the engine
 * has no React, gesture handler, or platform dependencies, we can:
 *
 *   - Control time deterministically (pass `now` as a parameter)
 *   - Simulate gesture sequences with precise timing
 *   - Assert on exact positions, velocities, and callback invocations
 *
 * This lets us catch regressions in scroll physics, momentum, freeze behavior,
 * and zoom without manual on-device testing.
 */

import {
  TimelinePhysicsEngine,
  EngineConfig,
  EngineCallbacks,
} from '../engine'

import {
  SEGMENT_WIDTH,
  SEGMENT_GAP,
  SEGMENT_DURATION,
  DECELERATION,
  MIN_VELOCITY,
  VELOCITY_SCALE,
  SCROLL_TO_DURATION,
  MIN_SELECTION_DURATION,
} from '../constants'
import { timeToX } from '../utils'

// ============================================================================
// Test helpers
// ============================================================================

/** Default config for a 60-second timeline in a 400px-wide container */
const DEFAULT_CONFIG: EngineConfig = {
  duration: 60_000,
  containerWidth: 400,
  position: 0,
}

/** Shorthand: convert time to x using default (unzoomed) layout */
function tx(time: number): number {
  return timeToX(time, SEGMENT_DURATION, SEGMENT_WIDTH, SEGMENT_GAP)
}

/** Create an engine with mock callbacks and optional config overrides */
function createEngine(configOverrides?: Partial<EngineConfig>) {
  const callbacks: EngineCallbacks = {
    onSeek: jest.fn(),
    onSelectionChange: jest.fn(),
    onFrame: jest.fn(),
    onDisplayPosition: jest.fn(),
  }

  const config = { ...DEFAULT_CONFIG, ...configOverrides }
  const engine = new TimelinePhysicsEngine(config, callbacks)

  return { engine, callbacks }
}

/**
 * Simulate a pan (drag) gesture with controlled timing.
 *
 * Each step is a { translationX, now } pair. The gesture system reports
 * translationX as cumulative offset from the start point, not deltas.
 */
function simulatePan(
  engine: TimelinePhysicsEngine,
  steps: Array<{ translationX: number; now: number }>,
  options: {
    startX?: number
    startY?: number
    startNow?: number
    endVelocityX?: number
  } = {}
) {
  const startNow = options.startNow ?? steps[0]?.now ?? 0

  engine.panStart(
    options.startX ?? 200,
    options.startY ?? 45,
    startNow
  )

  for (const step of steps) {
    engine.panUpdate(step.translationX, step.now)
  }

  const endNow = steps[steps.length - 1]?.now ?? startNow
  engine.panEnd(options.endVelocityX ?? 0, endNow)
}

/**
 * Run the tick loop to completion with fixed time steps.
 * Returns the number of ticks executed.
 */
function runTicks(
  engine: TimelinePhysicsEngine,
  startTime: number,
  dt = 16,
  maxTicks = 1000
): number {
  let t = startTime
  let count = 0

  while (engine.tick(t) && count < maxTicks) {
    t += dt
    count++
  }
  // Run the final tick (the one that returns false) to trigger finalization
  engine.tick(t)

  return count
}

// ============================================================================
// Tests
// ============================================================================

describe('TimelinePhysicsEngine', () => {
  // --------------------------------------------------------------------------
  // 1. Finger-lift precision (freeze-on-slowdown)
  // --------------------------------------------------------------------------

  describe('finger-lift precision', () => {
    it('freezes display when drag velocity drops below threshold', () => {
      const { engine, callbacks } = createEngine()

      // Start a drag at the center of the container
      engine.panStart(200, 45, 0)

      // Fast drag: move -100px over 100ms (1000 px/s — well above freeze threshold)
      engine.panUpdate(-100, 50)
      engine.panUpdate(-100, 100)
      expect(callbacks.onFrame).toHaveBeenCalled()
      callbacks.onFrame.mockClear()

      // Slow down to near-zero: tiny movement over 20ms (~15 px/s — below 80 px/s threshold)
      engine.panUpdate(-100.3, 120)

      // Display should be frozen — no more onFrame calls
      engine.panUpdate(-100.4, 140)
      engine.panUpdate(-100.4, 160)
      expect(callbacks.onFrame).not.toHaveBeenCalled()
    })

    it('seeks to the frozen position on release, not the jittery final position', () => {
      const { engine, callbacks } = createEngine()

      engine.panStart(200, 45, 0)

      // Fast drag
      engine.panUpdate(-100, 50)
      engine.panUpdate(-100, 100)

      // Record scroll offset just before freeze
      const preFreeze = engine.scrollOffset

      // Slow down to trigger freeze
      engine.panUpdate(-100.3, 120)

      // More jitter after freeze (simulates finger-lift noise)
      engine.panUpdate(-102, 140)
      engine.panUpdate(-103, 160)

      // Release with low velocity
      engine.panEnd(5, 170)

      // Should have seeked to the frozen position, not the final jittery one
      const seekPosition = (callbacks.onSeek as jest.Mock).mock.calls[0][0]
      expect(Math.abs(engine.scrollOffset - preFreeze)).toBeLessThan(1)
      expect(seekPosition).toBeCloseTo(
        (preFreeze / (SEGMENT_WIDTH + SEGMENT_GAP)) * SEGMENT_DURATION,
        0
      )
    })
  })

  // --------------------------------------------------------------------------
  // 2. Freeze / unfreeze transitions
  // --------------------------------------------------------------------------

  describe('freeze/unfreeze transitions', () => {
    it('unfreezes when velocity picks up again', () => {
      const { engine, callbacks } = createEngine()

      engine.panStart(200, 45, 0)

      // Fast movement
      engine.panUpdate(-50, 20)

      // Slow down to trigger freeze
      engine.panUpdate(-50.2, 40)
      callbacks.onFrame.mockClear()

      // Verify frozen
      engine.panUpdate(-50.3, 60)
      expect(callbacks.onFrame).not.toHaveBeenCalled()

      // Speed up again — large movement in short time
      engine.panUpdate(-120, 80)

      // Should be unfrozen — onFrame called again
      expect(callbacks.onFrame).toHaveBeenCalled()
    })

    it('triggers momentum after unfreeze + fast release', () => {
      const { engine, callbacks } = createEngine()

      engine.panStart(200, 45, 0)

      // Slow → freeze
      engine.panUpdate(-1, 20)
      engine.panUpdate(-1.1, 40)

      // Fast → unfreeze
      engine.panUpdate(-80, 60)

      // Fast release
      engine.panEnd(-2000, 80)

      // Momentum should be active — tick should return true
      expect(engine.tick(96)).toBe(true)
    })
  })

  // --------------------------------------------------------------------------
  // 3. Momentum decay
  // --------------------------------------------------------------------------

  describe('momentum', () => {
    it('decays velocity exponentially and stops at MIN_VELOCITY', () => {
      const { engine, callbacks } = createEngine()

      // Start a flick: panEnd with high velocity
      engine.panStart(200, 45, 0)
      engine.panUpdate(-10, 16)
      engine.panEnd(-3000, 32) // 3000 px/s flick

      const initialVelocity = 3000 * VELOCITY_SCALE // px/frame

      // Tick once and verify decay
      const offsetBefore = engine.scrollOffset
      engine.tick(48)
      const offsetAfter = engine.scrollOffset

      // Should have moved by approximately the initial velocity
      const moved = Math.abs(offsetAfter - offsetBefore)
      expect(moved).toBeCloseTo(initialVelocity, 0)

      // Run to completion
      const ticks = runTicks(engine, 64)

      // Should have called onSeek exactly once (at the end)
      expect(callbacks.onSeek).toHaveBeenCalledTimes(1)

      // Should take a reasonable number of ticks to stop
      // (exponential decay with 0.95 factor from ~50 px/frame takes ~70-90 ticks)
      expect(ticks).toBeGreaterThan(30)
      expect(ticks).toBeLessThan(200)
    })

    it('clamps scroll offset to bounds during momentum', () => {
      const { engine } = createEngine({ duration: 10_000 })

      // Position near the end
      engine.setExternalPosition(9500, 0)

      // Flick forward (positive direction in timeline = negative translationX)
      engine.panStart(200, 45, 100)
      engine.panUpdate(-10, 116)
      engine.panEnd(-5000, 132)

      // Run momentum to completion
      runTicks(engine, 148)

      // Should not exceed max offset
      const maxOffset = tx(10_000)
      expect(engine.scrollOffset).toBeLessThanOrEqual(maxOffset)
    })
  })

  // --------------------------------------------------------------------------
  // 4. Tap-to-seek animation
  // --------------------------------------------------------------------------

  describe('tap-to-seek', () => {
    it('animates to the tapped position with correct timing', () => {
      const { engine, callbacks } = createEngine({ position: 30_000 })

      // Tap to the right of center (200 = center of 400px container)
      // Tapping at x=300 means 100px to the right of the playhead
      engine.touchDown(300, 45, 0)
      engine.tap(300, 0)

      // Should have started an animation
      expect(engine.tick(0)).toBe(true)

      // At SCROLL_TO_DURATION / 2 = 100ms, should be partway through
      engine.tick(100)
      const midOffset = engine.scrollOffset
      const startOffset = tx(30_000)
      const targetOffset = startOffset + 100 // tapped 100px to the right

      // Should be between start and target (easeOutCubic at t=0.5 ≈ 0.875)
      expect(midOffset).toBeGreaterThan(startOffset)
      expect(midOffset).toBeLessThanOrEqual(targetOffset)

      // At SCROLL_TO_DURATION = 200ms, animation should complete
      engine.tick(200)

      // onSeek should fire with the target time
      expect(callbacks.onSeek).toHaveBeenCalledTimes(1)
    })

    it('clamps tap position to duration bounds', () => {
      const { engine, callbacks } = createEngine({ duration: 5_000, position: 4_500 })

      // Tap far to the right (beyond the end of the timeline)
      engine.touchDown(380, 45, 0)
      engine.tap(380, 0)

      // Run animation to completion
      runTicks(engine, 16)

      // Seek should be clamped to duration
      const seekPos = (callbacks.onSeek as jest.Mock).mock.calls[0][0]
      expect(seekPos).toBeLessThanOrEqual(5_000)
    })
  })

  // --------------------------------------------------------------------------
  // 5. Tap-stops-momentum
  // --------------------------------------------------------------------------

  describe('tap-stops-momentum', () => {
    it('stops momentum on touch and suppresses the subsequent tap', () => {
      const { engine, callbacks } = createEngine()

      // Start momentum with a flick
      engine.panStart(200, 45, 0)
      engine.panUpdate(-10, 16)
      engine.panEnd(-3000, 32)

      // Verify momentum is active
      expect(engine.tick(48)).toBe(true)
      callbacks.onSeek.mockClear()

      // Touch down while momentum is active — should stop it
      engine.touchDown(200, 45, 64)

      // Momentum should be stopped, onSeek called to commit current position
      expect(callbacks.onSeek).toHaveBeenCalledTimes(1)

      // The subsequent tap should be suppressed (it was a "stop" touch, not a "seek" touch)
      callbacks.onSeek.mockClear()
      callbacks.onFrame.mockClear()
      engine.tap(200, 80)

      // No animation should start, no seek should fire
      expect(engine.tick(96)).toBe(false)
      expect(callbacks.onSeek).not.toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------------------
  // 6. Zoom position invariant
  // --------------------------------------------------------------------------

  describe('zoom', () => {
    it('preserves time position across zoom changes', () => {
      const { engine } = createEngine({ position: 30_000 })

      // Read time before zoom
      const timeBefore = 30_000

      // Pinch to zoom in 2x
      engine.pinchStart(0)
      engine.pinchUpdate(2.0, 16)

      // After zoom, the scroll offset in pixels will differ (more zoomed in),
      // but converting back to time should give the same position.
      // Use the engine's segmentWidth to convert back.
      const segStep = engine.segmentWidth + engine.segmentGap
      const timeAfter = (engine.scrollOffset / segStep) * SEGMENT_DURATION

      expect(timeAfter).toBeCloseTo(timeBefore, 0)
    })

    it('updates segmentWidth on zoom', () => {
      const { engine } = createEngine()

      expect(engine.segmentWidth).toBe(SEGMENT_WIDTH) // baseline

      engine.pinchStart(0)
      // Scale of ~1.59 with exponent 1.5 gives factor ~2.0, snapped to nearest 0.05
      engine.pinchUpdate(1.59, 16)

      expect(engine.segmentWidth).toBeGreaterThan(SEGMENT_WIDTH)
    })
  })

  // --------------------------------------------------------------------------
  // 7. Zoom bounds
  // --------------------------------------------------------------------------

  describe('zoom bounds', () => {
    it('clamps zoom factor at MAX_ZOOM', () => {
      const { engine } = createEngine()

      engine.pinchStart(0)
      engine.pinchUpdate(100, 16) // extreme scale

      // segmentWidth should not exceed SEGMENT_WIDTH * MAX_ZOOM
      expect(engine.segmentWidth).toBeLessThanOrEqual(SEGMENT_WIDTH * 16)
    })

    it('clamps zoom factor at MIN_ZOOM', () => {
      const { engine } = createEngine()

      engine.pinchStart(0)
      engine.pinchUpdate(0.01, 16) // extreme pinch-in

      // segmentWidth should not go below SEGMENT_WIDTH * MIN_ZOOM
      expect(engine.segmentWidth).toBeGreaterThanOrEqual(SEGMENT_WIDTH * 1)
    })
  })

  // --------------------------------------------------------------------------
  // 8. Pinch cooldown
  // --------------------------------------------------------------------------

  describe('pinch cooldown', () => {
    it('ignores pan gestures within 200ms of pinch end', () => {
      const { engine, callbacks } = createEngine({ position: 10_000 })

      // Pinch and release
      engine.pinchStart(0)
      engine.pinchEnd(100)

      // Try to pan within cooldown (at time 200, which is < 100 + 200)
      const offsetBefore = engine.scrollOffset
      engine.panStart(200, 45, 200)
      engine.panUpdate(-50, 216)
      engine.panEnd(0, 232)

      // Scroll offset should not have changed
      expect(engine.scrollOffset).toBe(offsetBefore)
      expect(callbacks.onSeek).not.toHaveBeenCalled()
    })

    it('accepts pan gestures after cooldown expires', () => {
      const { engine, callbacks } = createEngine({ position: 10_000 })

      engine.pinchStart(0)
      engine.pinchEnd(100)

      // Pan after cooldown (100 + 200 = 300, start at 301)
      const offsetBefore = engine.scrollOffset
      engine.panStart(200, 45, 301)
      engine.panUpdate(-50, 320)
      engine.panEnd(0, 340)

      // Should have moved
      expect(engine.scrollOffset).not.toBe(offsetBefore)
    })
  })

  // --------------------------------------------------------------------------
  // 9. Selection handle dragging
  // --------------------------------------------------------------------------

  describe('selection handles', () => {
    // Helper: compute where a handle appears in screen-space, given
    // the engine's scroll offset and container width
    function handleScreenX(engine: TimelinePhysicsEngine, time: number): number {
      const handleTimelineX = tx(time)
      const halfWidth = 200 // container is 400px
      return handleTimelineX - engine.scrollOffset + halfWidth
    }

    it('drags the start handle and calls onSelectionChange', () => {
      const { engine, callbacks } = createEngine({
        position: 15_000,
        selection: { start: 10_000, end: 20_000 },
      })

      // Touch near the start handle (y at bottom where circles are)
      const startX = handleScreenX(engine, 10_000)
      const handleY = 90 - 10 + 12 // TIMELINE_HEIGHT - 10 + HANDLE_CIRCLE_RADIUS

      engine.panStart(startX, handleY, 0)

      // Drag left by 30px (moving start earlier)
      engine.panUpdate(-30, 16)

      expect(callbacks.onSelectionChange).toHaveBeenCalled()
      const [newStart, newEnd] = (callbacks.onSelectionChange as jest.Mock).mock.calls[0]
      expect(newStart).toBeLessThan(10_000) // moved earlier
      expect(newEnd).toBe(20_000) // end unchanged
    })

    it('clamps start handle to not exceed end minus MIN_SELECTION_DURATION', () => {
      const { engine, callbacks } = createEngine({
        position: 15_000,
        selection: { start: 19_500, end: 20_000 },
      })

      // Touch near the start handle
      const startX = handleScreenX(engine, 19_500)
      const handleY = 90 - 10 + 12

      engine.panStart(startX, handleY, 0)

      // Drag right, trying to push start past end
      engine.panUpdate(100, 16)

      const [newStart] = (callbacks.onSelectionChange as jest.Mock).mock.calls[0]
      expect(newStart).toBeLessThanOrEqual(20_000 - MIN_SELECTION_DURATION)
    })
  })

  // --------------------------------------------------------------------------
  // 10. External position sync
  // --------------------------------------------------------------------------

  describe('external position sync', () => {
    it('updates scroll offset when idle', () => {
      const { engine } = createEngine({ position: 0 })

      engine.setExternalPosition(30_000, 100)

      expect(engine.scrollOffset).toBeCloseTo(tx(30_000), 1)
    })

    it('ignores external position during drag', () => {
      const { engine } = createEngine({ position: 0 })

      engine.panStart(200, 45, 0)

      const offsetDuringDrag = engine.scrollOffset
      engine.setExternalPosition(30_000, 50)

      // Should not have moved — engine is active
      expect(engine.scrollOffset).toBe(offsetDuringDrag)
    })

    it('ignores external position during momentum', () => {
      const { engine } = createEngine({ position: 0 })

      // Start momentum
      engine.panStart(200, 45, 0)
      engine.panUpdate(-10, 16)
      engine.panEnd(-2000, 32)

      const offsetDuringMomentum = engine.scrollOffset
      engine.setExternalPosition(50_000, 48)

      // Should be ignored — engine is active
      expect(engine.scrollOffset).toBe(offsetDuringMomentum)
    })
  })

  // --------------------------------------------------------------------------
  // 11. Edge clamping
  // --------------------------------------------------------------------------

  describe('edge clamping', () => {
    it('clamps scroll offset to 0 when dragging past the start', () => {
      const { engine } = createEngine({ position: 1_000 })

      engine.panStart(200, 45, 0)
      engine.panUpdate(500, 16) // drag right = scroll left, past the start

      expect(engine.scrollOffset).toBe(0)
    })

    it('clamps scroll offset to maxOffset when dragging past the end', () => {
      const { engine } = createEngine({ duration: 10_000, position: 9_000 })

      engine.panStart(200, 45, 0)
      engine.panUpdate(-500, 16) // drag left = scroll right, past the end

      expect(engine.scrollOffset).toBe(tx(10_000))
    })
  })

  // --------------------------------------------------------------------------
  // 12. Display position throttling
  // --------------------------------------------------------------------------

  describe('display throttling', () => {
    it('throttles display updates to 50ms intervals', () => {
      const { engine, callbacks } = createEngine()

      engine.panStart(200, 45, 0)

      // Rapid updates within 50ms — only the first should trigger onDisplayPosition
      engine.panUpdate(-10, 10)
      engine.panUpdate(-20, 20)
      engine.panUpdate(-30, 30)

      // First call at t=10, then throttled until t >= 60
      expect(callbacks.onDisplayPosition).toHaveBeenCalledTimes(1)
    })

    it('allows forced updates to bypass throttling', () => {
      const { engine, callbacks } = createEngine()

      // Trigger a freeze (which does a forced display update)
      engine.panStart(200, 45, 0)
      engine.panUpdate(-50, 10) // fast, triggers a normal display update
      callbacks.onDisplayPosition.mockClear()

      // Slow down to trigger freeze — freeze does a forced update
      engine.panUpdate(-50.1, 30) // only 20ms later, but forced
      expect(callbacks.onDisplayPosition).toHaveBeenCalledTimes(1)
    })
  })

  // --------------------------------------------------------------------------
  // isActive state
  // --------------------------------------------------------------------------

  describe('isActive', () => {
    it('is false when idle', () => {
      const { engine } = createEngine()
      expect(engine.isActive).toBe(false)
    })

    it('is true during drag', () => {
      const { engine } = createEngine()
      engine.panStart(200, 45, 0)
      expect(engine.isActive).toBe(true)
    })

    it('is true during momentum', () => {
      const { engine } = createEngine()
      engine.panStart(200, 45, 0)
      engine.panUpdate(-10, 16)
      engine.panEnd(-2000, 32)
      expect(engine.isActive).toBe(true)
    })

    it('returns to false after momentum completes', () => {
      const { engine } = createEngine()
      engine.panStart(200, 45, 0)
      engine.panUpdate(-10, 16)
      engine.panEnd(-2000, 32)

      runTicks(engine, 48)
      expect(engine.isActive).toBe(false)
    })
  })
})
