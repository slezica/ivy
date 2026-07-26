/**
 * TimelinePhysicsEngine
 *
 * Pure physics engine for timeline scroll, momentum, tap-to-seek, playback
 * follow, selection handle dragging, and pinch-to-zoom.
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
  SCROLL_TO_DURATION,
  MIN_SELECTION_DURATION,
  MIN_ZOOM,
  MAX_ZOOM,
  DRIFT_SNAP_THRESHOLD,
  DRIFT_FOLD_WINDOW,
  HANDLE_SHIFT,
  HANDLE_PIN_OFFSET,
  HANDLE_PIN_Y,
  HANDLE_TOUCH_RADIUS,
} from './constants'
import { timeToX, xToTime, clamp } from './utils'

// ============================================================================
// Display throttling: avoid flooding React with re-renders
// ============================================================================

const DISPLAY_UPDATE_INTERVAL = 50 // ms between display position updates

// ============================================================================
// EMA velocity estimation: smooths noisy drag velocity so the transition
// to momentum is clean. Alpha controls responsiveness vs smoothness.
// ============================================================================

const EMA_ALPHA = 0.35              // lower = smoother, higher = more responsive

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
  /**
   * Linked selection: the playhead is solid — any playhead movement (drag,
   * momentum, tap animation, playback follow) pushes the selection anchors
   * outward: the start anchor backward, the end anchor forward. Shrinking
   * is reserved for the handles.
   */
  linked?: boolean
  canZoom?: boolean
  /**
   * When set, taps skip relative to the current position instead of seeking
   * to the tapped point: left half skips back, right half skips forward.
   */
  tapSkip?: { backward: number; forward: number }
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
  private _linked: boolean
  private _tapSkip: { backward: number; forward: number } | null

  // --- Scroll position ---
  private _scrollOffset: number
  private _velocity = 0           // px/s, used during momentum (frame-rate independent)
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
  private _lastTickTime = 0  // timestamp of previous tick, for computing dt

  // --- Playback follow ---
  //
  // While audio plays, the engine advances the scroll offset itself at the
  // playback rate (0 = paused), so motion is smooth at display refresh rate.
  // External position events become drift corrections: small drift is folded
  // in gradually over DRIFT_FOLD_WINDOW, large drift (an external seek) snaps.
  private _playbackRate = 0
  private _pendingDrift = 0  // ms of correction left to fold in

  // --- Touch state ---
  //
  // When the user touches down while momentum/animation is active, we stop
  // the animation and set this flag. The subsequent tap gesture checks this
  // flag and suppresses the tap-to-seek (the touch was meant to stop scrolling,
  // not to seek).
  private _stoppedMomentum = false

  // --- EMA velocity estimation ---
  //
  // Smooths drag velocity using an exponential moving average so the
  // transition from drag to momentum is clean. Raw gesture velocityX is
  // noisy near finger lift — EMA filters that out naturally.
  private _emaVelocity = 0
  private _lastDragSample: { time: number; offset: number } | null = null

  // --- Display position throttling ---
  //
  // Updating the display position triggers a React re-render (for the time
  // indicator text). We throttle updates to DISPLAY_UPDATE_INTERVAL to avoid
  // flooding React. The `force` flag bypasses throttling for important moments
  // like freeze-lock and seek-complete.
  private _lastDisplayUpdate = -DISPLAY_UPDATE_INTERVAL // no throttle on first update
  private _displayPosition: number

  // --- Linked selection emission throttling ---
  //
  // While linked, playback follow pushes the selection every frame. Like the
  // display position, emissions are throttled to avoid flooding React; the
  // engine's _selection stays authoritative in between, and motion endpoints
  // force an emit so React always converges to the final value.
  private _lastSelectionEmit = -DISPLAY_UPDATE_INTERVAL
  private _selectionDirty = false

  // =========================================================================
  // Construction
  // =========================================================================

  constructor(config: EngineConfig, callbacks: EngineCallbacks) {
    this._callbacks = callbacks
    this._duration = config.duration
    this._containerWidth = config.containerWidth
    this._canZoom = config.canZoom ?? false
    this._selection = config.selection ?? null
    this._linked = config.linked ?? false
    this._tapSkip = config.tapSkip ?? null

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
   * Authoritative selection. During handle drags and linked pushing the
   * engine mutates this every frame while emissions to React are throttled —
   * drawing code must read it from here (via onFrame), not from props.
   */
  get selection(): { start: number; end: number } | null { return this._selection }

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
   *
   * While playback follow is driving the scroll, small differences are treated
   * as drift and folded in gradually; only large ones (external seeks, e.g.
   * notification buttons) snap.
   */
  setExternalPosition(position: number, now: number): void {
    if (this.isActive) return

    if (this._isPlaybackFollowing()) {
      const drift = position - this._xt(this._scrollOffset)
      if (Math.abs(drift) <= DRIFT_SNAP_THRESHOLD) {
        this._pendingDrift = drift
        return
      }
      this._pendingDrift = 0
      // Fall through: drift too large, snap to the reported position
    }

    const prevTime = this._xt(this._scrollOffset)
    this._scrollOffset = this._tx(position)
    this._pushSelection(prevTime, position, now)
    this._emitSelection(now, true) // snap is a motion endpoint
    this._updateDisplayPosition(position, now, true)
    this._callbacks.onFrame()
  }

  /**
   * Set the playback rate driving the timeline's own motion (0 = paused).
   * The hook calls this when the playbackRate prop changes.
   */
  setPlaybackRate(rate: number, now: number): void {
    if (rate > 0 && this._playbackRate === 0) {
      this._lastTickTime = now // fresh dt baseline for the first playback tick
    }
    if (rate === 0) {
      this._pendingDrift = 0
      this._emitSelection(now, true) // pause is a motion endpoint
    }
    this._playbackRate = rate
  }

  /**
   * Sync selection from React props.
   *
   * Ignored while the engine itself may be mutating the selection (handle
   * drag, or linked pushing during any motion): prop updates then are stale
   * echoes of our own emissions, and applying one would drop an anchor out
   * of the playhead's swept path — sweep contact could never recover it.
   * Motion endpoints force-emit, so React converges to the final value.
   */
  updateSelection(start: number, end: number): void {
    if (this._selectionLocked()) return
    this._selection = { start, end }
  }

  setLinked(linked: boolean): void {
    this._linked = linked
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
      this._emitSelection(now, true) // motion stopped mid-flight
      this._callbacks.onSeek(this._xt(this._scrollOffset))
    } else {
      this._stoppedMomentum = false
    }
  }

  /**
   * Called when the touch sequence is fully finalized (gesture onFinalize,
   * which fires whether the gesture succeeded, failed, or was cancelled).
   *
   * A handle touch whose gesture neither completes as a tap nor activates as
   * a pan (e.g. held past the tap timeout and released without moving) would
   * leave `_draggingHandle` set forever — making `isActive` permanently true,
   * which blocks both playback follow and external position sync: audio keeps
   * playing but the timeline freezes. This guarantees the state is cleared.
   *
   * `_stoppedMomentum` is intentionally left alone: touchDown set it, and a
   * tap() may still run after this (gesture callback order isn't guaranteed),
   * relying on it for suppression.
   */
  touchUp(): void {
    this._draggingHandle = null
  }

  /**
   * Called when a tap gesture completes (finger down + up without dragging).
   *
   * If the touch was used to stop momentum, we suppress the tap. Otherwise,
   * we start an animated scroll — to the tapped position (seek mode), or to
   * the current position ± the skip amount (tapSkip mode, split by half).
   */
  tap(x: number, now: number): void {
    // Suppress tap if it was used to stop momentum, end a handle drag, or during pinch cooldown
    if (this._stoppedMomentum || this._draggingHandle || this._isPinchCooldown(now)) {
      this._stoppedMomentum = false
      this._draggingHandle = null
      return
    }

    const halfWidth = this._containerWidth / 2

    // Skip mode: left half skips back, right half skips forward
    if (this._tapSkip) {
      const currentTime = this._xt(this._scrollOffset)
      const delta = x < halfWidth ? -this._tapSkip.backward : this._tapSkip.forward
      const targetTime = clamp(currentTime + delta, 0, this._duration)

      this._animateToPosition(this._tx(targetTime), now)
      return
    }

    // Seek mode: convert screen x to a time position and animate there
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
    this._emaVelocity = 0
    this._stopAnimation()
  }

  /**
   * Pan gesture updates with new translation from the start point.
   *
   * For handle drags: update the selection bounds.
   * For scroll drags: update scroll offset and EMA velocity estimate.
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
        this._selection = { start: clampedStart, end: this._selection.end }
      } else {
        const minEnd = this._selection.start + MIN_SELECTION_DURATION
        const clampedEnd = clamp(newValue, minEnd, this._duration)
        this._selection = { start: this._selection.start, end: clampedEnd }
      }

      this._selectionDirty = true
      this._emitSelection(now)
      this._callbacks.onFrame()
      return
    }

    // --- Regular scroll mode ---

    // No drag in progress — panStart was blocked during pinch cooldown
    if (!this._isDragging) return

    const newOffset = clamp(
      this._dragStartOffset - translationX,
      0,
      this._maxOffset()
    )

    // Update EMA velocity estimate from drag samples
    const lastSample = this._lastDragSample

    if (lastSample) {
      const dt = (now - lastSample.time) / 1000 // seconds
      if (dt > 0) {
        const instantVelocity = (newOffset - lastSample.offset) / dt // px/s (signed)
        this._emaVelocity = EMA_ALPHA * instantVelocity + (1 - EMA_ALPHA) * this._emaVelocity
      }
    }

    this._lastDragSample = { time: now, offset: newOffset }
    const prevTime = this._xt(this._scrollOffset)
    this._scrollOffset = newOffset
    this._pushSelection(prevTime, this._xt(newOffset), now)

    this._updateDisplayPosition(this._xt(this._scrollOffset), now)
    this._callbacks.onFrame()
  }

  /**
   * Pan gesture ends. Either finalize handle drag or apply momentum
   * using the EMA-smoothed velocity.
   */
  panEnd(_velocityX: number, now: number): void {
    // Handle drag ends — clear state and flush the final selection
    if (this._draggingHandle) {
      this._draggingHandle = null
      this._emitSelection(now, true)
      return
    }

    // No drag in progress — panStart was blocked during pinch cooldown
    if (!this._isDragging) return

    this._isDragging = false

    // A pinch interrupted this drag — drop it without momentum or seek
    if (this._isPinchCooldown(now)) return

    // Use EMA-smoothed velocity for momentum (ignoring raw gesture velocityX)
    this._velocity = this._emaVelocity
    this._lastTickTime = now // dt baseline for momentum or playback follow

    if (Math.abs(this._velocity) > MIN_VELOCITY) {
      this._hasMomentum = true // momentum finalize will flush the selection
    } else {
      this._emitSelection(now, true)
      this._callbacks.onSeek(this._xt(this._scrollOffset))
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
    // Momentum and tap-to-seek take priority; when one finishes with playback
    // follow active, keep the loop alive so following resumes seamlessly.
    if (this._hasMomentum) {
      return this._tickMomentum(now) || this._isPlaybackFollowing()
    }

    if (this._animation) {
      return this._tickAnimation(now) || this._isPlaybackFollowing()
    }

    if (this._isPlaybackFollowing()) {
      return this._tickPlayback(now)
    }

    return false
  }

  // =========================================================================
  // Private: momentum tick (frame-rate independent)
  //
  // Uses real elapsed time (dt) instead of assuming a fixed frame rate.
  // The motion follows continuous exponential decay:
  //
  //   velocity(t) = v0 * DECELERATION^t     (DECELERATION is per-second)
  //   position(t) = v0 * (DECELERATION^t - 1) / ln(DECELERATION)
  //
  // Each tick computes dt from the wall clock, so a 120Hz display and a
  // 60Hz display produce the same motion curve — just sampled differently.
  // =========================================================================

  private _tickMomentum(now: number): boolean {
    // If the user started dragging during momentum, bail out
    if (this._isDragging || this._draggingHandle) {
      this._hasMomentum = false
      return false
    }

    // Compute real elapsed time since last tick
    const dt = Math.min((now - this._lastTickTime) / 1000, 0.1) // seconds, capped at 100ms
    this._lastTickTime = now

    if (Math.abs(this._velocity) > MIN_VELOCITY) {
      // Advance position by the exact displacement of the decay curve over
      // this time slice: ∫ v0 * D^t dt = v0 * (D^dt - 1) / ln(D)
      const decay = Math.pow(DECELERATION, dt)
      const prevTime = this._xt(this._scrollOffset)
      this._scrollOffset = clamp(
        this._scrollOffset + this._velocity * (decay - 1) / Math.log(DECELERATION),
        0,
        this._maxOffset()
      )
      this._pushSelection(prevTime, this._xt(this._scrollOffset), now)

      // Decay velocity: v *= DECELERATION^dt
      this._velocity *= decay

      this._updateDisplayPosition(this._xt(this._scrollOffset), now)
      this._callbacks.onFrame()
      return true // need another tick
    }

    // Momentum exhausted — finalize
    this._velocity = 0
    this._hasMomentum = false
    this._emitSelection(now, true)
    this._updateDisplayPosition(this._xt(this._scrollOffset), now, true)
    this._callbacks.onSeek(this._xt(this._scrollOffset))
    return false
  }

  // =========================================================================
  // Private: playback follow tick
  //
  // Advances the scroll offset at the playback rate using real elapsed time,
  // folding in a time-proportional share of any pending drift correction.
  // Never fires onSeek — the audio player is the source of truth here.
  // =========================================================================

  private _isPlaybackFollowing(): boolean {
    return this._playbackRate > 0
      && !this._isDragging
      && this._draggingHandle === null
      && !this._isPinching
  }

  private _tickPlayback(now: number): boolean {
    const dt = Math.min((now - this._lastTickTime) / 1000, 0.1) // seconds, capped at 100ms
    this._lastTickTime = now

    // Exponential fold: each slice absorbs a share of the remaining drift,
    // with time constant WINDOW/3 so ~95% is corrected within the window
    const fold = this._pendingDrift * Math.min(1, (dt * 3000) / DRIFT_FOLD_WINDOW)
    this._pendingDrift -= fold

    const prevTime = this._xt(this._scrollOffset)
    const position = prevTime + dt * 1000 * this._playbackRate + fold
    this._scrollOffset = clamp(this._tx(position), 0, this._maxOffset())
    this._pushSelection(prevTime, this._xt(this._scrollOffset), now)

    this._updateDisplayPosition(this._xt(this._scrollOffset), now)
    this._callbacks.onFrame()
    return true
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

    this._lastTickTime = now // keep the playback-follow dt baseline fresh

    const elapsed = now - this._animation.startTime
    const progress = Math.min(elapsed / SCROLL_TO_DURATION, 1)
    const easedProgress = easeOutCubic(progress)

    const { startOffset, targetOffset } = this._animation
    const prevTime = this._xt(this._scrollOffset)
    this._scrollOffset = startOffset + (targetOffset - startOffset) * easedProgress
    this._pushSelection(prevTime, this._xt(this._scrollOffset), now)

    this._updateDisplayPosition(this._xt(this._scrollOffset), now)
    this._callbacks.onFrame()

    if (progress < 1) {
      return true // need another tick
    }

    // Animation complete — finalize
    this._animation = null
    this._emitSelection(now, true)
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
  // Private: linked selection push
  //
  // Link down = the playhead is solid, and pushes are outward-only: the
  // start anchor can only be pushed backward, the end anchor only forward.
  // A movement sweeping over the eligible anchor carries it to the new
  // position; the reverse movement releases it — shrinking is what the
  // handles are for. (Symmetric pushing was tried first: once the playhead
  // contacted an anchor, every movement dragged it both ways and it could
  // never be let go.)
  //
  // The same rule applies to every motion source — drag, momentum, tap
  // animation, playback follow, external snap. Pushes only expand the
  // selection, so MIN_SELECTION_DURATION (a handle-drag constraint) can
  // never be violated here; scroll clamping bounds the pushes to
  // [0, duration].
  // =========================================================================

  private _pushSelection(prevTime: number, newTime: number, now: number): void {
    if (!this._linked || !this._selection) return
    if (this._draggingHandle !== null) return // handle drag owns the selection
    if (newTime === prevTime) return

    let { start, end } = this._selection

    if (newTime > prevTime) {
      // Forward sweep: carry the end anchor in [prevTime, newTime) forward
      if (end >= prevTime && end < newTime) end = newTime
    } else {
      // Backward sweep: carry the start anchor in (newTime, prevTime] backward
      if (start > newTime && start <= prevTime) start = newTime
    }

    if (start === this._selection.start && end === this._selection.end) return

    this._selection = { start, end }
    this._selectionDirty = true
    this._emitSelection(now)
  }

  /**
   * Emit the selection to React, throttled like the display position.
   * `force` is used at motion endpoints (pan end, momentum/animation
   * finalize, pause, snap) so React always converges to the final value.
   */
  private _emitSelection(now: number, force = false): void {
    if (!this._selectionDirty || !this._selection) return
    if (!force && now - this._lastSelectionEmit < DISPLAY_UPDATE_INTERVAL) return

    this._lastSelectionEmit = now
    this._selectionDirty = false
    this._callbacks.onSelectionChange?.(this._selection.start, this._selection.end)
  }

  /**
   * True while the engine itself may be mutating the selection — a handle
   * drag, or linked pushing during any motion. See updateSelection().
   */
  private _selectionLocked(): boolean {
    if (this._draggingHandle !== null) return true
    if (!this._linked || !this._selection) return false

    return this._isDragging
      || this._hasMomentum
      || this._animation !== null
      || this._playbackRate > 0
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
  // handle's pin circle to start dragging it. Pins sit on the external side
  // of each handle line (start: left, end: right), vertically centered —
  // same geometry Timeline.tsx draws (HANDLE_PIN_* constants).
  // =========================================================================

  private _getHandleAtPosition(touchX: number, touchY: number): 'start' | 'end' | null {
    if (!this._selection) return null

    const halfWidth = this._containerWidth / 2

    // Convert screen-space touch to timeline-space coordinate
    const timelineX = this._scrollOffset + (touchX - halfWidth)

    const startPinX = this._tx(this._selection.start) - HANDLE_SHIFT - HANDLE_PIN_OFFSET
    const endPinX = this._tx(this._selection.end) + HANDLE_SHIFT + HANDLE_PIN_OFFSET

    // Euclidean distance from touch to each pin center
    const distToStart = Math.sqrt(
      (timelineX - startPinX) ** 2 + (touchY - HANDLE_PIN_Y) ** 2
    )
    const distToEnd = Math.sqrt(
      (timelineX - endPinX) ** 2 + (touchY - HANDLE_PIN_Y) ** 2
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
