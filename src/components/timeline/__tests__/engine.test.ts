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
 * This lets us catch regressions in scroll physics, momentum, velocity
 * estimation, and zoom without manual on-device testing.
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
  SCROLL_TO_DURATION,
  MIN_SELECTION_DURATION,
} from '../constants'
import { timeToX } from '../utils'

// ============================================================================
// Test helpers
// ============================================================================

/** Default config for a 10-minute timeline in a 400px-wide container */
const DEFAULT_CONFIG: EngineConfig = {
  duration: 600_000,
  containerWidth: 400,
  position: 0,
}

/** Shorthand: convert time to x using default (unzoomed) layout */
function tx(time: number): number {
  return timeToX(time, SEGMENT_DURATION, SEGMENT_WIDTH, SEGMENT_GAP)
}

/** Create an engine with mock callbacks and optional config overrides */
function createEngine(configOverrides?: Partial<EngineConfig>) {
  const callbacks = {
    onSeek: jest.fn(),
    onSelectionChange: jest.fn(),
    onFrame: jest.fn(),
    onDisplayPosition: jest.fn(),
  } satisfies EngineCallbacks

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
  // 1. EMA velocity estimation
  // --------------------------------------------------------------------------

  describe('EMA velocity estimation', () => {
    it('uses smoothed velocity for momentum, not raw gesture velocity', () => {
      const { engine, callbacks } = createEngine()

      // Drag at a consistent speed: 100px over 100ms = 1000 px/s
      engine.panStart(200, 45, 0)
      engine.panUpdate(-20, 20)
      engine.panUpdate(-40, 40)
      engine.panUpdate(-60, 60)
      engine.panUpdate(-80, 80)
      engine.panUpdate(-100, 100)

      // Release — panEnd's velocityX is ignored, EMA velocity is used
      engine.panEnd(0, 100) // raw velocity = 0, but EMA should be ~1000 px/s

      // Momentum should have started from the EMA estimate, not the raw 0
      expect(engine.tick(116)).toBe(true)
    })

    it('smooths out noisy finger-lift velocity', () => {
      // Two engines: one with clean release, one with jittery last samples
      function flingAndGetMomentumOffset(jitter: boolean): number {
        const { engine } = createEngine()

        engine.panStart(200, 45, 0)
        engine.panUpdate(-50, 20)
        engine.panUpdate(-100, 40)
        engine.panUpdate(-150, 60)
        engine.panUpdate(-200, 80)

        if (jitter) {
          // Simulate finger-lift noise: small erratic movements
          engine.panUpdate(-198, 90)
          engine.panUpdate(-201, 95)
          engine.panUpdate(-199, 100)
        }

        engine.panEnd(0, jitter ? 100 : 80)

        // Run a few momentum ticks
        let t = jitter ? 116 : 96
        for (let i = 0; i < 5; i++) {
          engine.tick(t)
          t += 16
        }
        return engine.scrollOffset
      }

      const cleanOffset = flingAndGetMomentumOffset(false)
      const jitteryOffset = flingAndGetMomentumOffset(true)

      // Both should produce momentum in the same direction (positive offset).
      // The jittery version will be slower due to EMA dampening the noise,
      // but should still move forward — not backwards from noise.
      expect(cleanOffset).toBeGreaterThan(200)
      expect(jitteryOffset).toBeGreaterThan(150)
    })

    it('always follows the finger during drag (no freezing)', () => {
      const { engine, callbacks } = createEngine()

      engine.panStart(200, 45, 0)

      // Fast drag
      engine.panUpdate(-100, 50)
      engine.panUpdate(-100, 100)
      callbacks.onFrame.mockClear()

      // Slow down to near-zero velocity
      engine.panUpdate(-100.3, 120)
      engine.panUpdate(-100.4, 140)
      engine.panUpdate(-100.4, 160)

      // onFrame should still be called — always follow the finger
      expect(callbacks.onFrame).toHaveBeenCalled()
    })
  })

  // --------------------------------------------------------------------------
  // 3. Momentum decay
  // --------------------------------------------------------------------------

  describe('momentum', () => {
    it('decays velocity exponentially and stops at MIN_VELOCITY', () => {
      const { engine, callbacks } = createEngine()

      // Build up EMA velocity with a fast consistent drag (~2500 px/s)
      engine.panStart(200, 45, 0)
      engine.panUpdate(-40, 16)
      engine.panUpdate(-80, 32)
      engine.panUpdate(-120, 48)
      engine.panUpdate(-160, 64)
      engine.panEnd(0, 64)

      // EMA velocity should be substantial — momentum should be active
      const offsetBefore = engine.scrollOffset
      engine.tick(80) // first momentum tick
      const offsetAfter = engine.scrollOffset

      // Should have moved forward
      expect(offsetAfter).toBeGreaterThan(offsetBefore)

      // Run to completion
      const ticks = runTicks(engine, 96)

      // Should have called onSeek exactly once (at the end)
      expect(callbacks.onSeek).toHaveBeenCalledTimes(1)

      // Should take a reasonable number of ticks at 16ms intervals to stop
      expect(ticks).toBeGreaterThan(10)
      expect(ticks).toBeLessThan(500)
    })

    it('clamps scroll offset to bounds during momentum', () => {
      const { engine } = createEngine({ duration: 10_000 })

      // Position near the end
      engine.setExternalPosition(9500, 0)

      // Fast drag forward to build EMA velocity
      engine.panStart(200, 45, 100)
      engine.panUpdate(-50, 116)
      engine.panUpdate(-100, 132)
      engine.panUpdate(-150, 148)
      engine.panUpdate(-200, 164)
      engine.panEnd(0, 164)

      // Run momentum to completion
      runTicks(engine, 148)

      // Should not exceed max offset
      const maxOffset = tx(10_000)
      expect(engine.scrollOffset).toBeLessThanOrEqual(maxOffset)
    })

    it('produces the same final position regardless of frame rate', () => {
      // Simulate the same flick at 60Hz and 120Hz — final position should match.
      // This is the core property of frame-rate independent physics.

      function flingAndRun(dt: number): number {
        const { engine } = createEngine()
        // Build consistent EMA velocity
        engine.panStart(200, 45, 0)
        engine.panUpdate(-40, 16)
        engine.panUpdate(-80, 32)
        engine.panUpdate(-120, 48)
        engine.panUpdate(-160, 64)
        engine.panEnd(0, 64)

        // Run ticks at the given interval until momentum stops
        let t = 64
        while (engine.tick(t += dt)) { /* advance */ }
        engine.tick(t) // finalize

        return engine.scrollOffset
      }

      const at60Hz = flingAndRun(1000 / 60)   // ~16.67ms per frame
      const at120Hz = flingAndRun(1000 / 120)  // ~8.33ms per frame
      const at30Hz = flingAndRun(1000 / 30)    // ~33.33ms per frame

      // All three should land at approximately the same position.
      // Small differences are expected from discrete sampling, but should be
      // well under 1% of the total distance traveled.
      expect(Math.abs(at60Hz - at120Hz)).toBeLessThan(at60Hz * 0.01)
      expect(Math.abs(at60Hz - at30Hz)).toBeLessThan(at60Hz * 0.01)
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

  describe('tap-to-skip', () => {
    const TAP_SKIP = { backward: 30_000, forward: 25_000 }

    it('skips backward on left-half tap', () => {
      const { engine, callbacks } = createEngine({ position: 60_000, tapSkip: TAP_SKIP })

      engine.touchDown(100, 45, 0)
      engine.tap(100, 0)
      runTicks(engine, 16)

      expect(callbacks.onSeek).toHaveBeenCalledTimes(1)
      const seekPos = (callbacks.onSeek as jest.Mock).mock.calls[0][0]
      expect(seekPos).toBeCloseTo(30_000, 0)
    })

    it('skips forward on right-half tap', () => {
      const { engine, callbacks } = createEngine({ position: 60_000, tapSkip: TAP_SKIP })

      engine.touchDown(300, 45, 0)
      engine.tap(300, 0)
      runTicks(engine, 16)

      const seekPos = (callbacks.onSeek as jest.Mock).mock.calls[0][0]
      expect(seekPos).toBeCloseTo(85_000, 0)
    })

    it('clamps skips to timeline bounds', () => {
      const { engine, callbacks } = createEngine({
        duration: 40_000,
        position: 10_000,
        tapSkip: TAP_SKIP,
      })

      // Backward past the start clamps to 0
      engine.touchDown(100, 45, 0)
      engine.tap(100, 0)
      runTicks(engine, 16)
      expect((callbacks.onSeek as jest.Mock).mock.calls[0][0]).toBeCloseTo(0, 0)

      // Forward past the end clamps to duration
      engine.setExternalPosition(30_000, 1000)
      engine.touchDown(300, 45, 1000)
      engine.tap(300, 1000)
      runTicks(engine, 1016)
      expect((callbacks.onSeek as jest.Mock).mock.calls[1][0]).toBeCloseTo(40_000, 0)
    })
  })

  // --------------------------------------------------------------------------
  // 5. Tap-stops-momentum
  // --------------------------------------------------------------------------

  describe('tap-stops-momentum', () => {
    it('stops momentum on touch and suppresses the subsequent tap', () => {
      const { engine, callbacks } = createEngine()

      // Build up EMA velocity with a fast drag, then release for momentum
      engine.panStart(200, 45, 0)
      engine.panUpdate(-40, 16)
      engine.panUpdate(-80, 32)
      engine.panUpdate(-120, 48)
      engine.panUpdate(-160, 64)
      engine.panEnd(0, 64)

      // Verify momentum is active
      expect(engine.tick(80)).toBe(true)
      callbacks.onSeek.mockClear()

      // Touch down while momentum is active — should stop it
      engine.touchDown(200, 45, 96)

      // Momentum should be stopped, onSeek called to commit current position
      expect(callbacks.onSeek).toHaveBeenCalledTimes(1)

      // The subsequent tap should be suppressed (it was a "stop" touch, not a "seek" touch)
      callbacks.onSeek.mockClear()
      callbacks.onFrame.mockClear()
      engine.tap(200, 112)

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

    it('clears drag state when pan ends during pinch cooldown', () => {
      const { engine } = createEngine({ position: 10_000 })

      // One-finger drag activates a pan
      engine.panStart(200, 45, 0)
      engine.panUpdate(-50, 16)

      // Second finger down — pinch begins mid-pan, then both fingers lift.
      // panEnd lands inside the 200ms cooldown after pinchEnd.
      engine.pinchStart(32)
      engine.pinchEnd(48)
      engine.panEnd(0, 64)

      // Drag state must not leak — the engine returns to idle
      expect(engine.isActive).toBe(false)

      // External position updates work again
      engine.setExternalPosition(30_000, 300)
      expect(engine.scrollOffset).toBeCloseTo(tx(30_000), 1)

      // Tap-to-seek survives its first tick (not cancelled by a stale drag)
      engine.touchDown(300, 45, 300)
      engine.tap(300, 300)
      expect(engine.tick(316)).toBe(true)
    })

    it('ignores pan updates when panStart was blocked during cooldown', () => {
      const { engine, callbacks } = createEngine({ position: 10_000 })

      // A previous pan leaves a stale drag start offset behind
      engine.panStart(200, 45, 0)
      engine.panUpdate(-50, 16)
      engine.panEnd(0, 16)
      callbacks.onSeek.mockClear()

      // Pinch, then a pan begins inside the cooldown — panStart is blocked
      engine.pinchStart(100)
      engine.pinchEnd(150)
      engine.panStart(200, 45, 200)

      // The finger keeps moving past the end of the cooldown — updates must
      // not resume against the stale drag start offset (no offset jump)
      const offsetBefore = engine.scrollOffset
      engine.panUpdate(-80, 400)
      expect(engine.scrollOffset).toBe(offsetBefore)

      // Releasing must not trigger momentum or a spurious seek
      engine.panEnd(0, 420)
      expect(engine.isActive).toBe(false)
      expect(callbacks.onSeek).not.toHaveBeenCalled()
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

      // Build up EMA velocity with a fast drag
      engine.panStart(200, 45, 0)
      engine.panUpdate(-40, 16)
      engine.panUpdate(-80, 32)
      engine.panUpdate(-120, 48)
      engine.panUpdate(-160, 64)
      engine.panEnd(0, 64)

      const offsetAfterRelease = engine.scrollOffset
      engine.setExternalPosition(50_000, 80)

      // Should be ignored — engine is active (momentum)
      expect(engine.scrollOffset).toBe(offsetAfterRelease)
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

    it('updates display after throttle interval elapses', () => {
      const { engine, callbacks } = createEngine()

      engine.panStart(200, 45, 0)
      engine.panUpdate(-10, 10) // triggers first display update
      callbacks.onDisplayPosition.mockClear()

      // These should be throttled (within 50ms window)
      engine.panUpdate(-20, 20)
      engine.panUpdate(-30, 30)
      expect(callbacks.onDisplayPosition).not.toHaveBeenCalled()

      // This should go through (60ms > 50ms interval)
      engine.panUpdate(-40, 70)
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
      engine.panUpdate(-40, 16)
      engine.panUpdate(-80, 32)
      engine.panUpdate(-120, 48)
      engine.panUpdate(-160, 64)
      engine.panEnd(0, 64)
      expect(engine.isActive).toBe(true)
    })

    it('returns to false after momentum completes', () => {
      const { engine } = createEngine()
      engine.panStart(200, 45, 0)
      engine.panUpdate(-40, 16)
      engine.panUpdate(-80, 32)
      engine.panUpdate(-120, 48)
      engine.panUpdate(-160, 64)
      engine.panEnd(0, 64)

      runTicks(engine, 80)
      expect(engine.isActive).toBe(false)
    })
  })

  // --------------------------------------------------------------------------
  // 14. Playback follow
  // --------------------------------------------------------------------------

  describe('playback follow', () => {
    /** Tick the engine over a span at fixed dt (playback ticks never end) */
    function tickSpan(engine: TimelinePhysicsEngine, from: number, to: number, dt = 16) {
      for (let t = from; t <= to; t += dt) {
        engine.tick(t)
      }
    }

    it('does not tick when rate is 0', () => {
      const { engine } = createEngine({ position: 0 })
      expect(engine.tick(16)).toBe(false)
      expect(engine.scrollOffset).toBe(0)
    })

    it('advances at the playback rate', () => {
      const { engine } = createEngine({ position: 0 })
      engine.setPlaybackRate(1, 0)

      tickSpan(engine, 16, 1000)

      // After ~1s of ticks the timeline should have advanced ~1000ms
      expect(engine.scrollOffset).toBeCloseTo(tx(1000), 0)
    })

    it('scales advancement with rate', () => {
      const { engine } = createEngine({ position: 0 })
      engine.setPlaybackRate(2, 0)

      tickSpan(engine, 16, 1000)

      expect(engine.scrollOffset).toBeCloseTo(tx(2000), 0)
    })

    it('stops advancing when rate returns to 0', () => {
      const { engine } = createEngine({ position: 0 })
      engine.setPlaybackRate(1, 0)
      tickSpan(engine, 16, 496)

      engine.setPlaybackRate(0, 500)
      const offsetAtPause = engine.scrollOffset

      expect(engine.tick(516)).toBe(false)
      expect(engine.scrollOffset).toBe(offsetAtPause)
    })

    it('folds small drift in gradually instead of snapping', () => {
      const { engine } = createEngine({ position: 0 })
      engine.setPlaybackRate(1, 0)
      tickSpan(engine, 16, 1000)

      // Player reports 500ms ahead of where we are — within snap threshold
      const reported = engine.displayPosition + 500
      engine.setExternalPosition(reported, 1000)

      // No immediate jump
      expect(engine.scrollOffset).toBeCloseTo(tx(1000), 0)

      // After the fold window passes, position ≈ reported + elapsed since report
      tickSpan(engine, 1016, 2000)
      expect(engine.scrollOffset).toBeCloseTo(tx(reported + 1000), 0)
    })

    it('snaps on drift larger than the threshold (external seek)', () => {
      const { engine } = createEngine({ position: 0 })
      engine.setPlaybackRate(1, 0)
      tickSpan(engine, 16, 1000)

      engine.setExternalPosition(60_000, 1000)

      expect(engine.scrollOffset).toBeCloseTo(tx(60_000), 1)
    })

    it('snaps external positions when paused (rate 0)', () => {
      const { engine } = createEngine({ position: 0 })

      engine.setExternalPosition(30_000, 100)

      expect(engine.scrollOffset).toBeCloseTo(tx(30_000), 1)
    })

    it('suspends while dragging and resumes after release', () => {
      const { engine } = createEngine({ position: 0 })
      engine.setPlaybackRate(1, 0)
      tickSpan(engine, 16, 496)

      engine.panStart(200, 45, 500)
      expect(engine.tick(516)).toBe(false) // gesture drives frames, not the loop

      engine.panUpdate(-60, 550)
      engine.panEnd(0, 600) // slow release: no momentum, commits a seek

      // Loop restarts (hook calls scheduleTick on panEnd) and follows again
      expect(engine.tick(616)).toBe(true)
      const before = engine.scrollOffset
      engine.tick(716)
      expect(engine.scrollOffset).toBeGreaterThan(before)
    })

    it('keeps the tick loop alive when momentum ends during playback', () => {
      const { engine, callbacks } = createEngine({ position: 0 })
      engine.setPlaybackRate(1, 0)

      // Fling to start momentum
      engine.panStart(200, 45, 0)
      engine.panUpdate(-40, 16)
      engine.panUpdate(-80, 32)
      engine.panUpdate(-120, 48)
      engine.panUpdate(-160, 64)
      engine.panEnd(0, 64)
      expect(engine.isActive).toBe(true)

      // Run until momentum exhausts — tick must keep returning true throughout
      let t = 80
      while (engine.isActive && t < 20_000) {
        expect(engine.tick(t)).toBe(true)
        t += 16
      }
      expect(engine.isActive).toBe(false)
      expect(callbacks.onSeek).toHaveBeenCalledTimes(1) // momentum-end seek

      // And playback follow continues advancing
      const before = engine.scrollOffset
      engine.tick(t + 16)
      expect(engine.scrollOffset).toBeGreaterThan(before)
    })

    it('clamps at the end of the timeline', () => {
      const { engine } = createEngine({ duration: 10_000, position: 9_900 })
      engine.setPlaybackRate(1, 0)

      tickSpan(engine, 16, 2000)

      expect(engine.scrollOffset).toBe(tx(10_000))
    })

    it('never fires onSeek from playback follow', () => {
      const { engine, callbacks } = createEngine({ position: 0 })
      engine.setPlaybackRate(1, 0)

      tickSpan(engine, 16, 2000)

      expect(callbacks.onSeek).not.toHaveBeenCalled()
    })
  })
})
