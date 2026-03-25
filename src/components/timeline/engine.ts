/**
 * TimelinePhysicsEngine
 *
 * Pure physics engine for timeline scroll, momentum, tap-to-seek, selection
 * handle dragging, pinch-to-zoom, and freeze-on-slowdown.
 *
 * This class contains ALL the state and logic that was previously spread across
 * refs and callbacks in the useTimelinePhysics hook. It has:
 *
 *   - No React dependencies (no useState, useRef, useCallback, useEffect)
 *   - No platform dependencies (no requestAnimationFrame, performance.now)
 *   - No gesture handler dependencies (no Gesture.Pan, etc.)
 *
 * Instead, the caller (the hook adapter) is responsible for:
 *   - Passing timestamps via `now` parameters (deterministic in tests)
 *   - Calling `tick(now)` from a requestAnimationFrame loop
 *   - Wiring gesture events to the engine's input methods
 *   - Reacting to callbacks (onSeek, onFrame, etc.) to update React state
 */

import {
  SEGMENT_WIDTH,
  SEGMENT_GAP,
  SEGMENT_DURATION,
  DECELERATION,
  MIN_VELOCITY,
  VELOCITY_SCALE,
  SCROLL_TO_DURATION,
  MIN_SELECTION_DURATION,
  MIN_ZOOM,
  MAX_ZOOM,
  TIMELINE_HEIGHT,
} from './constants'
import { timeToX, xToTime, clamp } from './utils'

// ============================================================================
// Hit testing: how close a touch must be to a selection handle
// ============================================================================

const HANDLE_CIRCLE_RADIUS = 12
const HANDLE_TOUCH_RADIUS = 24

// ============================================================================
// Display throttling: avoid flooding React with re-renders
// ============================================================================

const DISPLAY_UPDATE_INTERVAL = 50 // ms between display position updates

// ============================================================================
// Freeze-on-slowdown: when the user's drag velocity drops below this
// threshold, we "freeze" the displayed position so that involuntary
// finger-lift movement doesn't cause visible jitter.
// ============================================================================

const FREEZE_VELOCITY = 80          // px/s — below this, user has "found their spot"
const VELOCITY_SAMPLE_INTERVAL = 16 // ms — how often we re-estimate drag velocity

// ============================================================================
// Pinch cooldown: after a pinch ends, ignore pan/tap for this window
// to prevent accidental gestures from residual finger movement
// ============================================================================

const PINCH_COOLDOWN = 200 // ms

// ============================================================================
// Types
// ============================================================================

export interface EngineConfig {
  duration: number
  containerWidth: number
  position: number
  selection?: { start: number; end: number }
  canZoom?: boolean
}

export interface EngineCallbacks {
  /** User finished seeking — commit position to playback */
  onSeek: (position: number) => void

  /** Selection handles moved */
  onSelectionChange?: (start: number, end: number) => void

  /** Visual state changed — the view should redraw */
  onFrame: () => void

  /** Display position changed — update the time indicator text */
  onDisplayPosition: (position: number) => void
}

// ============================================================================
// Engine
// ============================================================================

export class TimelinePhysicsEngine {
  // --- Callbacks (set once at construction) ---
  private readonly _callbacks: EngineCallbacks

  // --- Configuration (updatable) ---
  private _duration: number
  private _containerWidth: number
  private _canZoom: boolean
  private _selection: { start: number; end: number } | null

  // --- Scroll position ---
  private _scrollOffset: number
  private _velocity = 0           // px/frame, used during momentum
  private _isDragging = false
  private _dragStartOffset = 0    // scroll offset when pan began

  // --- Selection handle dragging ---
  private _draggingHandle: 'start' | 'end' | null = null
  private _handleDragStartValue = 0

  // --- Pinch-to-zoom ---
  private _isPinching = false
  private _pinchEndTime = -PINCH_COOLDOWN // no cooldown at construction
  private _pinchBaseZoom = 1
  private _zoomFactor = 1
  private _segmentWidth = SEGMENT_WIDTH
  private _segmentGap = SEGMENT_GAP

  // --- Tap-to-seek animation ---
  //
  // When the user taps a point on the timeline, we animate the scroll offset
  // from its current position to the tapped position using an ease-out curve.
  // The `tick()` method advances this animation each frame.
  private _animation: {
    startOffset: number
    targetOffset: number
    startTime: number
  } | null = null

  // --- Momentum ---
  //
  // After a fast pan release (flick), velocity decays exponentially each tick.
  // `_hasMomentum` tracks whether the momentum loop is active so that `tick()`
  // knows which sub-tick to run.
  private _hasMomentum = false

  // --- Touch state ---
  //
  // When the user touches down while momentum/animation is active, we stop
  // the animation and set this flag. The subsequent tap gesture checks this
  // flag and suppresses the tap-to-seek (the touch was meant to stop scrolling,
  // not to seek).
  private _stoppedMomentum = false

  // --- Freeze-on-slowdown ---
  //
  // During a slow drag, the user's finger velocity drops near zero as they
  // find their target position. The last few pan events before finger lift
  // introduce jitter. To prevent this, we "freeze" the display once velocity
  // drops below FREEZE_VELOCITY. The internal scroll offset still tracks the
  // finger, but the *displayed* position stays locked. On release, we snap
  // the real offset back to the frozen position.
  private _lastDragSample: { time: number; offset: number } | null = null
  private _dragFrozen = false
  private _frozenOffset = 0

  // --- Display position throttling ---
  //
  // Updating the display position triggers a React re-render (for the time
  // indicator text). We throttle updates to DISPLAY_UPDATE_INTERVAL to avoid
  // flooding React. The `force` flag bypasses throttling for important moments
  // like freeze-lock and seek-complete.
  private _lastDisplayUpdate = -DISPLAY_UPDATE_INTERVAL // no throttle on first update
  private _displayPosition: number

  // =========================================================================
  // Construction
  // =========================================================================

  constructor(config: EngineConfig, callbacks: EngineCallbacks) {
    this._callbacks = callbacks
    this._duration = config.duration
    this._containerWidth = config.containerWidth
    this._canZoom = config.canZoom ?? false
    this._selection = config.selection ?? null

    // Initialize scroll to the provided position
    this._scrollOffset = this._tx(config.position)
    this._displayPosition = config.position
  }

  // =========================================================================
  // Readable state (used by the hook and the Skia drawing code)
  // =========================================================================

  get scrollOffset(): number { return this._scrollOffset }
  get segmentWidth(): number { return this._segmentWidth }
  get segmentGap(): number { return this._segmentGap }
  get displayPosition(): number { return this._displayPosition }
  get zoomFactor(): number { return this._zoomFactor }

  /**
   * True when the engine is busy — dragging, animating, or decelerating.
   * External position updates should be ignored while active.
   */
  get isActive(): boolean {
    return this._isDragging
      || this._hasMomentum
      || this._animation !== null
      || this._draggingHandle !== null
  }

  // =========================================================================
  // External updates (called by the hook when props change)
  // =========================================================================

  setContainerWidth(width: number): void {
    this._containerWidth = width
  }

  setDuration(duration: number): void {
    this._duration = duration
  }

  /**
   * Sync scroll position to an externally-provided playback position.
   * Only takes effect when the engine is idle (not dragging/animating).
   */
  setExternalPosition(position: number, now: number): void {
    if (this.isActive) return

    this._scrollOffset = this._tx(position)
    this._updateDisplayPosition(position, now, true)
    this._callbacks.onFrame()
  }

  updateSelection(start: number, end: number): void {
    this._selection = { start, end }
  }

  // =========================================================================
  // Gesture input: touch lifecycle
  // =========================================================================

  /**
   * Called when a finger first touches the timeline (tap onBegin).
   *
   * Two responsibilities:
   * 1. If touching a selection handle, start handle drag
   * 2. If momentum/animation is running, stop it (the touch was meant to
   *    brake, not to seek — we track this via _stoppedMomentum)
   */
  touchDown(x: number, y: number, now: number): void {
    // Check if touching a selection handle (skip during pinch cooldown)
    if (this._selection && !this._isPinchCooldown(now)) {
      const handle = this._getHandleAtPosition(x, y)
      if (handle) {
        this._draggingHandle = handle
        this._handleDragStartValue = handle === 'start'
          ? this._selection.start
          : this._selection.end
        this._stopAnimation()
        this._stoppedMomentum = true
        return
      }
    }

    // If momentum or animation is running, stop it
    if (this._hasMomentum || this._animation !== null) {
      this._stopAnimation()
      this._stoppedMomentum = true
      this._callbacks.onSeek(this._xt(this._scrollOffset))
    } else {
      this._stoppedMomentum = false
    }
  }

  /**
   * Called when a tap gesture completes (finger down + up without dragging).
   *
   * If the touch was used to stop momentum, we suppress the tap. Otherwise,
   * we start an animated scroll to the tapped position.
   */
  tap(x: number, now: number): void {
    // Suppress tap if it was used to stop momentum, end a handle drag, or during pinch cooldown
    if (this._stoppedMomentum || this._draggingHandle || this._isPinchCooldown(now)) {
      this._stoppedMomentum = false
      this._draggingHandle = null
      return
    }

    // Convert screen x to a time position and animate there
    const halfWidth = this._containerWidth / 2
    const offsetFromCenter = x - halfWidth
    const tappedTime = this._xt(this._scrollOffset + offsetFromCenter)
    const clampedTime = clamp(tappedTime, 0, this._duration)

    this._animateToPosition(this._tx(clampedTime), now)
  }

  // =========================================================================
  // Gesture input: pan (drag to scroll)
  // =========================================================================

  /**
   * Pan gesture begins. Either starts a handle drag or a scroll drag.
   */
  panStart(x: number, y: number, now: number): void {
    if (this._isPinchCooldown(now)) return

    // Check if starting on a selection handle
    if (this._selection) {
      const handle = this._getHandleAtPosition(x, y)
      if (handle) {
        this._draggingHandle = handle
        this._handleDragStartValue = handle === 'start'
          ? this._selection.start
          : this._selection.end
        this._stopAnimation()
        return
      }
    }

    // Start a regular scroll drag
    this._isDragging = true
    this._velocity = 0
    this._dragStartOffset = this._scrollOffset
    this._lastDragSample = null
    this._dragFrozen = false
    this._stopAnimation()
  }

  /**
   * Pan gesture updates with new translation from the start point.
   *
   * For handle drags: update the selection bounds.
   * For scroll drags: update scroll offset with freeze-on-slowdown logic.
   */
  panUpdate(translationX: number, now: number): void {
    if (this._isPinchCooldown(now)) return

    // --- Handle drag mode ---
    if (this._draggingHandle && this._selection) {
      const deltaTime = this._xt(translationX)
      const newValue = this._handleDragStartValue + deltaTime

      if (this._draggingHandle === 'start') {
        const maxStart = this._selection.end - MIN_SELECTION_DURATION
        const clampedStart = clamp(newValue, 0, maxStart)
        this._callbacks.onSelectionChange?.(clampedStart, this._selection.end)
      } else {
        const minEnd = this._selection.start + MIN_SELECTION_DURATION
        const clampedEnd = clamp(newValue, minEnd, this._duration)
        this._callbacks.onSelectionChange?.(this._selection.start, clampedEnd)
      }

      this._callbacks.onFrame()
      return
    }

    // --- Regular scroll mode ---

    // Compute new scroll offset from drag translation
    const newOffset = clamp(
      this._dragStartOffset - translationX,
      0,
      this._maxOffset()
    )

    // Estimate drag velocity for freeze-on-slowdown detection.
    // We sample at VELOCITY_SAMPLE_INTERVAL intervals to smooth out noise.
    const lastSample = this._lastDragSample

    if (lastSample && now - lastSample.time >= VELOCITY_SAMPLE_INTERVAL) {
      const dt = (now - lastSample.time) / 1000 // seconds
      const dragVelocity = Math.abs(newOffset - lastSample.offset) / dt // px/s

      if (dragVelocity < FREEZE_VELOCITY) {
        // Velocity dropped below threshold — freeze display at current position.
        // The internal _scrollOffset continues tracking the finger, but the
        // view stays locked here. This prevents finger-lift jitter from reaching
        // the screen.
        if (!this._dragFrozen) {
          this._dragFrozen = true
          this._frozenOffset = this._scrollOffset
          this._updateDisplayPosition(this._xt(this._scrollOffset), now, true)
        }
      } else {
        // Finger is moving fast enough — unfreeze (or stay unfrozen)
        this._dragFrozen = false
      }

      this._lastDragSample = { time: now, offset: newOffset }
    } else if (!lastSample) {
      // First sample — just record, can't estimate velocity yet
      this._lastDragSample = { time: now, offset: newOffset }
    }

    this._scrollOffset = newOffset

    // Only update the view if we're not frozen
    if (!this._dragFrozen) {
      this._updateDisplayPosition(this._xt(this._scrollOffset), now)
      this._callbacks.onFrame()
    }
  }

  /**
   * Pan gesture ends. Either finalize handle drag, apply momentum, or
   * snap to frozen position.
   */
  panEnd(velocityX: number, now: number): void {
    if (this._isPinchCooldown(now)) return

    // Handle drag ends — just clear state
    if (this._draggingHandle) {
      this._draggingHandle = null
      return
    }

    this._isDragging = false

    if (this._dragFrozen) {
      // Display was frozen — snap to the frozen position, discarding any
      // finger-lift noise that accumulated after the freeze point
      this._scrollOffset = this._frozenOffset
      this._dragFrozen = false
      this._updateDisplayPosition(this._xt(this._scrollOffset), now, true)
      this._callbacks.onSeek(this._xt(this._scrollOffset))
    } else {
      // Normal release — convert gesture velocity to per-frame velocity
      // and start momentum if fast enough
      this._velocity = -velocityX * VELOCITY_SCALE

      if (Math.abs(this._velocity) > MIN_VELOCITY) {
        this._hasMomentum = true
      } else {
        this._callbacks.onSeek(this._xt(this._scrollOffset))
      }
    }
  }

  // =========================================================================
  // Gesture input: pinch-to-zoom
  // =========================================================================

  pinchStart(now: number): void {
    this._isPinching = true
    this._pinchBaseZoom = this._zoomFactor
    this._stopAnimation()
  }

  pinchUpdate(scale: number, now: number): void {
    // Apply non-linear scaling (exponent 1.5) for natural feel,
    // then snap to 1/20 increments to reduce jitter
    const rawZoom = this._pinchBaseZoom * (scale ** 1.5)
    const newZoom = clamp(Math.round(rawZoom * 20) / 20, MIN_ZOOM, MAX_ZOOM)
    if (newZoom === this._zoomFactor) return

    // Preserve the current time position across the zoom change:
    // read time at current offset → apply new zoom → recompute offset for same time
    const currentTime = this._xt(this._scrollOffset)
    this._applyZoom(newZoom)
    this._scrollOffset = this._tx(currentTime)

    this._callbacks.onFrame()
  }

  pinchEnd(now: number): void {
    this._isPinching = false
    this._pinchEndTime = now
  }

  // =========================================================================
  // Animation tick
  //
  // Called by the hook from a requestAnimationFrame loop. Advances whichever
  // animation is currently active (momentum or tap-to-seek).
  //
  // Returns true if another tick is needed, false if the engine is idle.
  // =========================================================================

  tick(now: number): boolean {
    if (this._hasMomentum) {
      return this._tickMomentum(now)
    }

    if (this._animation) {
      return this._tickAnimation(now)
    }

    return false
  }

  // =========================================================================
  // Private: momentum tick
  //
  // Each frame, the scroll offset advances by the current velocity, then
  // velocity decays by DECELERATION (0.95). This creates exponential
  // slow-down. When velocity drops below MIN_VELOCITY, we stop and seek.
  // =========================================================================

  private _tickMomentum(now: number): boolean {
    // If the user started dragging during momentum, bail out
    if (this._isDragging || this._draggingHandle) {
      this._hasMomentum = false
      return false
    }

    if (Math.abs(this._velocity) > MIN_VELOCITY) {
      this._scrollOffset = clamp(
        this._scrollOffset + this._velocity,
        0,
        this._maxOffset()
      )
      this._velocity *= DECELERATION

      this._updateDisplayPosition(this._xt(this._scrollOffset), now)
      this._callbacks.onFrame()
      return true // need another tick
    }

    // Momentum exhausted — finalize
    this._velocity = 0
    this._hasMomentum = false
    this._updateDisplayPosition(this._xt(this._scrollOffset), now, true)
    this._callbacks.onSeek(this._xt(this._scrollOffset))
    return false
  }

  // =========================================================================
  // Private: tap-to-seek animation tick
  //
  // Smoothly scrolls from startOffset to targetOffset over SCROLL_TO_DURATION
  // milliseconds using an ease-out cubic curve.
  // =========================================================================

  private _tickAnimation(now: number): boolean {
    if (!this._animation) return false

    // Cancel if the user started interacting
    if (this._isDragging || this._draggingHandle) {
      this._animation = null
      return false
    }

    const elapsed = now - this._animation.startTime
    const progress = Math.min(elapsed / SCROLL_TO_DURATION, 1)
    const easedProgress = easeOutCubic(progress)

    const { startOffset, targetOffset } = this._animation
    this._scrollOffset = startOffset + (targetOffset - startOffset) * easedProgress

    this._updateDisplayPosition(this._xt(this._scrollOffset), now)
    this._callbacks.onFrame()

    if (progress < 1) {
      return true // need another tick
    }

    // Animation complete — finalize
    this._animation = null
    this._updateDisplayPosition(this._xt(this._scrollOffset), now, true)
    this._callbacks.onSeek(this._xt(this._scrollOffset))
    return false
  }

  // =========================================================================
  // Private: coordinate conversion helpers
  //
  // These wrap the pure timeToX/xToTime functions with the engine's current
  // zoom-scaled segment dimensions.
  // =========================================================================

  private _tx(time: number): number {
    return timeToX(time, SEGMENT_DURATION, this._segmentWidth, this._segmentGap)
  }

  private _xt(x: number): number {
    return xToTime(x, SEGMENT_DURATION, this._segmentWidth, this._segmentGap)
  }

  private _maxOffset(): number {
    return this._tx(this._duration)
  }

  // =========================================================================
  // Private: zoom
  // =========================================================================

  private _applyZoom(factor: number): void {
    this._zoomFactor = factor
    this._segmentWidth = SEGMENT_WIDTH * factor
    this._segmentGap = SEGMENT_GAP // gap stays constant across zoom levels
  }

  // =========================================================================
  // Private: animation control
  // =========================================================================

  private _stopAnimation(): void {
    this._velocity = 0
    this._hasMomentum = false
    this._animation = null
  }

  private _animateToPosition(targetOffset: number, now: number): void {
    this._stopAnimation()

    this._animation = {
      startOffset: this._scrollOffset,
      targetOffset: clamp(targetOffset, 0, this._maxOffset()),
      startTime: now,
    }
  }

  // =========================================================================
  // Private: display position with throttling
  //
  // Updating the display position triggers a React re-render (time indicator).
  // We throttle to DISPLAY_UPDATE_INTERVAL ms unless `force` is true.
  // Force is used at critical moments: freeze-lock, seek-complete, etc.
  // =========================================================================

  private _updateDisplayPosition(position: number, now: number, force = false): void {
    if (force || now - this._lastDisplayUpdate >= DISPLAY_UPDATE_INTERVAL) {
      this._lastDisplayUpdate = now
      this._displayPosition = position
      this._callbacks.onDisplayPosition(position)
    }
  }

  // =========================================================================
  // Private: pinch cooldown
  //
  // After a pinch ends, residual finger movement can trigger accidental
  // pan/tap gestures. We ignore them for PINCH_COOLDOWN ms.
  // =========================================================================

  private _isPinchCooldown(now: number): boolean {
    return this._isPinching || now - this._pinchEndTime < PINCH_COOLDOWN
  }

  // =========================================================================
  // Private: selection handle hit testing
  //
  // Checks if a touch point (in screen coordinates) is close enough to a
  // selection handle circle to start dragging it.
  // =========================================================================

  private _getHandleAtPosition(touchX: number, touchY: number): 'start' | 'end' | null {
    if (!this._selection) return null

    const halfWidth = this._containerWidth / 2

    // The handle circles sit at the bottom of the timeline
    const circleY = TIMELINE_HEIGHT - 10 + HANDLE_CIRCLE_RADIUS

    // Convert screen-space touch to timeline-space coordinate
    const timelineX = this._scrollOffset + (touchX - halfWidth)

    const startHandleX = this._tx(this._selection.start)
    const endHandleX = this._tx(this._selection.end)

    // Euclidean distance from touch to each handle center
    const distToStart = Math.sqrt(
      (timelineX - startHandleX) ** 2 + (touchY - circleY) ** 2
    )
    const distToEnd = Math.sqrt(
      (timelineX - endHandleX) ** 2 + (touchY - circleY) ** 2
    )

    // Prefer the closer handle if both are within touch radius
    if (distToStart <= HANDLE_TOUCH_RADIUS && distToStart <= distToEnd) {
      return 'start'
    }
    if (distToEnd <= HANDLE_TOUCH_RADIUS) {
      return 'end'
    }

    return null
  }
}

// ============================================================================
// Easing
// ============================================================================

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}
