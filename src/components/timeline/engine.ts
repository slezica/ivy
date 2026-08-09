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
  EMA_ALPHA,
  HANDLE_SHIFT,
  HANDLE_PIN_OFFSET,
  HANDLE_TOUCH_RADIUS,
} from './constants'
import { timeToX, xToTime, clamp } from './utils'

// ============================================================================
// Display throttling: avoid flooding React with re-renders
// ============================================================================

const DISPLAY_UPDATE_INTERVAL = 50 // ms between display position updates

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

  /** Diagnostic tracing (test builds only) — see trace.ts */
  onTrace?: (tag: string, detail: string) => void
}

// ============================================================================
// Interaction mode
//
// The one gesture-driven thing the engine is doing right now. A single
// discriminated union — not parallel booleans — so contradictory states
// (the old `_isDragging && _draggingHandle` leak) are unrepresentable, and
// per-mode data dies with its mode instead of lingering as stale globals.
//
// Two categories, with different lifetimes:
//
//   - Finger-held (scrollDrag, handleDrag): exist only while a finger is
//     down. Cleared by panEnd on a normal release, and unconditionally by
//     touchUp — the guaranteed finalizer — when a gesture is cancelled.
//   - Ballistic (momentum, animation): outlive the finger. panEnd/tap set
//     them right before touchUp fires (pan.onEnd precedes pan.onFinalize),
//     so touchUp must not clear them; they end in their tick's finalize or
//     when the next touchDown brakes them.
//
// Playback follow is NOT a mode: it's orthogonal continuous state
// (_playbackRate, _pendingDrift, _playheadTime) that composes with modes —
// detached follow runs during handleDrag, attached follow while idle.
// Pinch also stays outside: it runs Simultaneous with pan in the hook, so
// pinching during a scrollDrag is a legal combination, and its cooldown is
// a time-window predicate rather than an event-cleared state.
// ============================================================================

type InteractionMode =
  | { kind: 'idle' }
  | {
      kind: 'scrollDrag'
      startOffset: number     // scroll offset when the pan began
      // EMA-smoothed velocity estimate (px/s): raw gesture velocityX is
      // noisy near finger lift, so momentum launches from this instead
      emaVelocity: number
      lastSample: { time: number; offset: number } | null
    }
  | {
      kind: 'handleDrag'
      handle: 'start' | 'end'
      startValue: number      // anchor time at grab; translations add to it
    }
  | {
      kind: 'momentum'
      velocity: number        // px/s, decays exponentially per tick
    }
  | {
      kind: 'animation'       // tap-to-seek ease-out scroll
      startOffset: number
      targetOffset: number
      startTime: number
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

  // --- Interaction mode (see the union above) ---
  private _mode: InteractionMode = { kind: 'idle' }

  // --- Playhead time ---
  //
  // The playhead's position in time. Attached motion (drag, momentum, tap
  // animation, playback follow, external snap) keeps it equal to the scroll
  // center. It detaches during a handle drag while audio plays: the scroll
  // freezes but the playhead keeps advancing across the frozen bars. After
  // release, playback follow decays the gap so the playhead glides back to
  // center. Linked pushes are driven by this value, not by the scroll.
  private _playheadTime: number

  /** Minimal-diff view of the mode for handle-aware code paths. */
  private get _draggingHandle(): 'start' | 'end' | null {
    return this._mode.kind === 'handleDrag' ? this._mode.handle : null
  }

  // --- Pinch-to-zoom ---
  private _isPinching = false
  private _pinchEndTime = -PINCH_COOLDOWN // no cooldown at construction
  private _pinchBaseZoom = 1
  private _zoomFactor = 1
  private _segmentWidth = SEGMENT_WIDTH
  private _segmentGap = SEGMENT_GAP

  // --- Tick clock ---
  private _lastTickTime = 0  // timestamp of previous tick, for computing dt

  // --- Playback follow ---
  //
  // While audio plays, the engine advances the scroll offset itself at the
  // playback rate (0 = paused), so motion is smooth at display refresh rate.
  // External position events become drift corrections: small drift is folded
  // in gradually over DRIFT_FOLD_WINDOW, large drift (an external seek) snaps.
  private _playbackRate = 0
  private _pendingDrift = 0  // ms of correction left to fold in

  // --- Trace throttling (tracing itself must not perturb timing) ---
  private _lastPanTrace = -Infinity
  private _lastStateTrace = -Infinity

  // --- Tap suppression ---
  //
  // A memo about the intent of the current touch: it was a brake (stopping
  // momentum/animation) or a handle grab, so a tap() completing from the
  // same touch must not seek. Not part of the mode: it coexists with idle
  // (post-brake) and must survive touchUp (gesture callback order between
  // tap.onEnd and pan.onFinalize isn't guaranteed). Self-healing: every
  // touchDown rewrites it, so it can never outlive the next touch.
  private _suppressTap = false

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
    this._playheadTime = config.position
    this._displayPosition = config.position
  }

  // =========================================================================
  // Tracing (no-ops unless the hook wired onTrace — test builds only)
  // =========================================================================

  private _trace(tag: string, detail = ''): void {
    this._callbacks.onTrace?.(tag, detail)
  }

  /**
   * The single funnel for interaction-mode transitions: every assignment
   * goes through here so the trace stream shows each transition and why.
   */
  private _setMode(next: InteractionMode, cause: string): void {
    if (this._callbacks.onTrace && this._mode.kind !== next.kind) {
      this._trace('mode', `${this._mode.kind}->${next.kind} (${cause}) center=${this._xt(this._scrollOffset).toFixed(0)} playhead=${this._playheadTime.toFixed(0)}`)
    }
    this._mode = next
  }

  /** The single funnel for onSeek, so every audio seek is traced with cause. */
  private _seek(position: number, cause: string): void {
    this._trace('onSeek', `${position.toFixed(0)} (${cause})`)
    this._callbacks.onSeek(position)
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
   * The playhead's time position. Equal to the scroll center except while
   * detached (handle drag with audio playing) or catching up after one.
   */
  get playheadTime(): number { return this._playheadTime }

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
    return this._mode.kind !== 'idle'
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
    if (this.isActive) {
      this._trace('extPos', `${position.toFixed(0)} ignored (mode=${this._mode.kind})`)
      return
    }

    if (this._isPlaybackFollowing()) {
      const drift = position - this._playheadTime
      if (Math.abs(drift) <= DRIFT_SNAP_THRESHOLD) {
        this._trace('extPos', `${position.toFixed(0)} fold drift=${drift.toFixed(0)}`)
        this._pendingDrift = drift
        return
      }
      this._trace('extPos', `${position.toFixed(0)} SNAP drift=${drift.toFixed(0)}`)
      this._pendingDrift = 0
      // Fall through: drift too large, snap to the reported position
    } else {
      this._trace('extPos', `${position.toFixed(0)} snap (idle, playhead=${this._playheadTime.toFixed(0)})`)
    }

    const prevTime = this._playheadTime
    this._scrollTo(this._tx(position))
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
    if (rate !== this._playbackRate) {
      this._trace('playbackRate', `${this._playbackRate}->${rate} mode=${this._mode.kind}`)
    }
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
  touchDown(x: number, _y: number, now: number): void {
    this._trace('touchDown', `x=${x.toFixed(1)} mode=${this._mode.kind}`)

    // Check if touching a selection handle (skip during pinch cooldown).
    // Arming the drag here — not at pan activation — is what makes the grab
    // decision single: panStart honors this mode instead of re-hit-testing.
    if (this._selection && !this._isPinchCooldown(now)) {
      const handle = this._getHandleAtPosition(x)
      if (handle) {
        // Stopping ballistic motion commits, same as the brake branch below:
        // an uncommitted fling leaves the timeline ahead of the audio for the
        // whole drag, and the first post-release position event snaps it back
        const interrupted = this._mode.kind === 'momentum' || this._mode.kind === 'animation'

        this._setMode({
          kind: 'handleDrag',
          handle,
          startValue: handle === 'start' ? this._selection.start : this._selection.end,
        }, `touchDown grab ${handle}`)
        this._suppressTap = true // a handle touch is never a seek-tap

        if (interrupted) {
          this._emitSelection(now, true)
          this._seek(this._xt(this._scrollOffset), 'brake (handle grab)')
        }
        return
      }
    }

    // If momentum or animation is running, stop it
    if (this._mode.kind === 'momentum' || this._mode.kind === 'animation') {
      this._setMode({ kind: 'idle' }, 'touchDown brake')
      this._suppressTap = true
      this._emitSelection(now, true) // motion stopped mid-flight
      this._seek(this._xt(this._scrollOffset), 'brake')
    } else {
      this._suppressTap = false
    }
  }

  /**
   * Called when the touch sequence is fully finalized (gesture onFinalize,
   * which fires whether the gesture succeeded, failed, or was cancelled).
   *
   * A finger-held mode that never reaches panEnd would stay armed forever —
   * making `isActive` permanently true, which blocks both playback follow and
   * external position sync: audio keeps playing but the timeline freezes.
   * Two ways there: a handle touch that neither completes as a tap nor
   * activates as a pan (held past the tap timeout, released without moving),
   * and an activated pan that gets cancelled (onFinalize fires without
   * onEnd). This clears both, and flushes any throttled selection edit the
   * dropped gesture left pending — React would otherwise hold a stale
   * selection until some unrelated motion endpoint.
   *
   * Ballistic modes (momentum, animation) are deliberately left running:
   * panEnd/tap set them right before this fires on a normal release.
   *
   * `_suppressTap` is intentionally left alone: touchDown set it, and a
   * tap() may still run after this (gesture callback order isn't guaranteed),
   * relying on it for suppression.
   */
  touchUp(now: number): void {
    this._trace('touchUp', `mode=${this._mode.kind}`)
    if (this._mode.kind === 'handleDrag' || this._mode.kind === 'scrollDrag') {
      this._setMode({ kind: 'idle' }, 'touchUp finalizer')
      this._emitSelection(now, true)
    }
  }

  /**
   * Called when a tap gesture completes (finger down + up without dragging).
   *
   * If the touch was used to stop momentum, we suppress the tap. Otherwise,
   * we start an animated scroll — to the tapped position (seek mode), or to
   * the current position ± the skip amount (tapSkip mode, split by half).
   */
  tap(x: number, now: number): void {
    this._trace('tap', `x=${x.toFixed(1)} mode=${this._mode.kind} suppress=${this._suppressTap}`)

    // Suppress tap if it was used to stop momentum, end a handle drag, or during pinch cooldown
    if (this._suppressTap || this._mode.kind === 'handleDrag' || this._isPinchCooldown(now)) {
      this._suppressTap = false
      if (this._mode.kind === 'handleDrag') this._setMode({ kind: 'idle' }, 'tap ended handle touch')
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
   * Pan gesture begins. Either continues a handle drag armed at touchDown,
   * or starts one, or starts a scroll drag.
   */
  panStart(x: number, _y: number, now: number): void {
    this._trace('panStart', `x=${x.toFixed(1)} mode=${this._mode.kind}${this._isPinchCooldown(now) ? ' (cooldown)' : ''}`)
    if (this._isPinchCooldown(now)) return

    // A handle drag armed at touchDown wins — never re-hit-test here. The
    // pan activates ~10px of finger travel after the touch, so this x can
    // sit outside the hit column even though the grab was legitimate; a
    // re-hit-test would degrade the grab into a scroll drag mid-gesture.
    // touchDown's startValue is still exact: the dragged anchor cannot move
    // between touchDown and panStart (prop echoes are locked out and linked
    // pushes exempt the dragged anchor), and RNGH translations are measured
    // from the activation point, so they pair with any capture taken while
    // the anchor was stationary.
    if (this._mode.kind === 'handleDrag') return

    // Check if starting on a selection handle (a pan can also begin one
    // without touchDown — tests drive panStart directly)
    if (this._selection) {
      const handle = this._getHandleAtPosition(x)
      if (handle) {
        this._setMode({
          kind: 'handleDrag',
          handle,
          startValue: handle === 'start' ? this._selection.start : this._selection.end,
        }, `panStart grab ${handle}`)
        return
      }
    }

    // Start a regular scroll drag
    this._setMode({
      kind: 'scrollDrag',
      startOffset: this._scrollOffset,
      emaVelocity: 0,
      lastSample: null,
    }, 'panStart scroll')
  }

  /**
   * Pan gesture updates with new translation from the start point.
   *
   * For handle drags: update the selection bounds.
   * For scroll drags: update scroll offset and EMA velocity estimate.
   */
  panUpdate(translationX: number, now: number): void {
    if (this._callbacks.onTrace && now - this._lastPanTrace >= 50) { // throttled: full rate would perturb timing
      this._lastPanTrace = now
      this._trace('panUpdate', `tx=${translationX.toFixed(1)} mode=${this._mode.kind}`)
    }
    if (this._isPinchCooldown(now)) return

    const mode = this._mode

    // --- Handle drag mode ---
    if (mode.kind === 'handleDrag' && this._selection) {
      const deltaTime = this._xt(translationX)
      const newValue = mode.startValue + deltaTime

      if (mode.handle === 'start') {
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
    if (mode.kind !== 'scrollDrag') return

    const newOffset = clamp(
      mode.startOffset - translationX,
      0,
      this._maxOffset()
    )

    // Update EMA velocity estimate from drag samples
    const lastSample = mode.lastSample

    if (lastSample) {
      const dt = (now - lastSample.time) / 1000 // seconds
      if (dt > 0) {
        const instantVelocity = (newOffset - lastSample.offset) / dt // px/s (signed)
        mode.emaVelocity = EMA_ALPHA * instantVelocity + (1 - EMA_ALPHA) * mode.emaVelocity
      }
    }

    mode.lastSample = { time: now, offset: newOffset }
    const prevTime = this._playheadTime
    this._scrollTo(newOffset)
    this._pushSelection(prevTime, this._playheadTime, now)

    this._updateDisplayPosition(this._xt(this._scrollOffset), now)
    this._callbacks.onFrame()
  }

  /**
   * Pan gesture ends. Either finalize handle drag or apply momentum
   * using the EMA-smoothed velocity.
   */
  panEnd(_velocityX: number, now: number): void {
    const mode = this._mode
    this._trace('panEnd', `mode=${mode.kind}${mode.kind === 'scrollDrag' ? ` ema=${mode.emaVelocity.toFixed(0)}` : ''}`)

    // Handle drag ends — clear state and flush the final selection
    if (mode.kind === 'handleDrag') {
      this._setMode({ kind: 'idle' }, 'panEnd handle release')
      this._emitSelection(now, true)
      return
    }

    // No drag in progress — panStart was blocked during pinch cooldown
    if (mode.kind !== 'scrollDrag') return

    this._setMode({ kind: 'idle' }, 'panEnd scroll release')

    // A pinch interrupted this drag — drop it without momentum or seek,
    // but flush any linked push the drag left pending in the throttle
    if (this._isPinchCooldown(now)) {
      this._emitSelection(now, true)
      return
    }

    this._lastTickTime = now // dt baseline for momentum or playback follow

    // Use EMA-smoothed velocity for momentum (ignoring raw gesture velocityX)
    if (Math.abs(mode.emaVelocity) > MIN_VELOCITY) {
      // Momentum finalize will flush the selection
      this._setMode({ kind: 'momentum', velocity: mode.emaVelocity }, 'panEnd fling')
    } else {
      this._emitSelection(now, true)
      this._seek(this._xt(this._scrollOffset), 'scrub release')
    }
  }

  // =========================================================================
  // Gesture input: pinch-to-zoom
  // =========================================================================

  pinchStart(now: number): void {
    this._trace('pinchStart', `mode=${this._mode.kind}`)
    this._isPinching = true
    this._pinchBaseZoom = this._zoomFactor
    // Stop ballistic motion; a live drag stays (pinch runs Simultaneous
    // with pan, so pinching mid-drag is a legal combination)
    if (this._mode.kind === 'momentum' || this._mode.kind === 'animation') {
      this._setMode({ kind: 'idle' }, 'pinchStart')
    }
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
    this._trace('pinchEnd', `zoom=${this._zoomFactor}`)
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
    // Low-rate state sample: the continuous side of the trace stream
    if (this._callbacks.onTrace && now - this._lastStateTrace >= 500) {
      this._lastStateTrace = now
      this._trace('state', `mode=${this._mode.kind} center=${this._xt(this._scrollOffset).toFixed(0)} playhead=${this._playheadTime.toFixed(0)} rate=${this._playbackRate} drift=${this._pendingDrift.toFixed(0)}`)
    }

    // Ballistic modes drive their own motion; when one finishes with playback
    // follow active, the `||` tail sees the finalized (idle) mode and keeps
    // the loop alive so following resumes seamlessly.
    switch (this._mode.kind) {
      case 'momentum':
        return this._tickMomentum(now, this._mode) || this._isPlaybackFollowing()
      case 'animation':
        return this._tickAnimation(now, this._mode) || this._isPlaybackFollowing()
      case 'handleDrag':
        return this._isDetachedFollowing() ? this._tickPlayback(now) : false
      case 'scrollDrag':
        return false // the gesture drives frames, not the loop
      case 'idle':
        return this._isPlaybackFollowing() ? this._tickPlayback(now) : false
    }
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

  private _tickMomentum(now: number, mode: { velocity: number }): boolean {
    // Compute real elapsed time since last tick
    const dt = Math.min((now - this._lastTickTime) / 1000, 0.1) // seconds, capped at 100ms
    this._lastTickTime = now

    if (Math.abs(mode.velocity) > MIN_VELOCITY) {
      // Advance position by the exact displacement of the decay curve over
      // this time slice: ∫ v0 * D^t dt = v0 * (D^dt - 1) / ln(D)
      const decay = Math.pow(DECELERATION, dt)
      const prevTime = this._playheadTime
      this._scrollTo(clamp(
        this._scrollOffset + mode.velocity * (decay - 1) / Math.log(DECELERATION),
        0,
        this._maxOffset()
      ))
      this._pushSelection(prevTime, this._playheadTime, now)

      // Decay velocity: v *= DECELERATION^dt
      mode.velocity *= decay

      this._updateDisplayPosition(this._xt(this._scrollOffset), now)
      this._callbacks.onFrame()
      return true // need another tick
    }

    // Momentum exhausted — finalize
    this._setMode({ kind: 'idle' }, 'momentum exhausted')
    this._emitSelection(now, true)
    this._updateDisplayPosition(this._xt(this._scrollOffset), now, true)
    this._seek(this._xt(this._scrollOffset), 'momentum finalize')
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
      && this._mode.kind === 'idle'
      && !this._isPinching
  }

  /**
   * Detached follow: a handle drag froze the scroll, but audio keeps playing —
   * the playhead alone advances across the frozen bars.
   */
  private _isDetachedFollowing(): boolean {
    return this._playbackRate > 0 && this._mode.kind === 'handleDrag'
  }

  private _tickPlayback(now: number): boolean {
    const dt = Math.min((now - this._lastTickTime) / 1000, 0.1) // seconds, capped at 100ms
    this._lastTickTime = now

    // Exponential fold: each slice absorbs a share of the remaining drift,
    // with time constant WINDOW/3 so ~95% is corrected within the window
    const foldShare = Math.min(1, (dt * 3000) / DRIFT_FOLD_WINDOW)
    const fold = this._pendingDrift * foldShare
    this._pendingDrift -= fold

    const prevTime = this._playheadTime
    this._playheadTime = clamp(prevTime + dt * 1000 * this._playbackRate + fold, 0, this._duration)
    this._pushSelection(prevTime, this._playheadTime, now)

    // Scroll follows the playhead — except during a handle drag, which freezes
    // it (the playhead detaches). Any playhead↔center gap left behind by a
    // drag decays with the drift fold's time constant, so the playhead glides
    // back to center after release. The gap is measured before this tick's
    // advance, so an attached playhead stays exactly centered.
    if (this._draggingHandle === null) {
      const gap = prevTime - this._xt(this._scrollOffset)
      const newGap = Math.abs(gap) < 1 ? 0 : gap * (1 - foldShare)
      this._scrollOffset = clamp(this._tx(this._playheadTime - newGap), 0, this._maxOffset())
    }

    this._updateDisplayPosition(this._playheadTime, now)
    this._callbacks.onFrame()
    return true
  }

  // =========================================================================
  // Private: tap-to-seek animation tick
  //
  // Smoothly scrolls from startOffset to targetOffset over SCROLL_TO_DURATION
  // milliseconds using an ease-out cubic curve.
  // =========================================================================

  private _tickAnimation(
    now: number,
    mode: { startOffset: number; targetOffset: number; startTime: number }
  ): boolean {
    this._lastTickTime = now // keep the playback-follow dt baseline fresh

    const elapsed = now - mode.startTime
    const progress = Math.min(elapsed / SCROLL_TO_DURATION, 1)
    const easedProgress = easeOutCubic(progress)

    const prevTime = this._playheadTime
    this._scrollTo(mode.startOffset + (mode.targetOffset - mode.startOffset) * easedProgress)
    this._pushSelection(prevTime, this._playheadTime, now)

    this._updateDisplayPosition(this._xt(this._scrollOffset), now)
    this._callbacks.onFrame()

    if (progress < 1) {
      return true // need another tick
    }

    // Animation complete — finalize
    this._setMode({ kind: 'idle' }, 'animation complete')
    this._emitSelection(now, true)
    this._updateDisplayPosition(this._xt(this._scrollOffset), now, true)
    this._seek(this._xt(this._scrollOffset), 'tap-seek finalize')
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

  /** Attached motion: move the scroll with the playhead riding the center. */
  private _scrollTo(offset: number): void {
    this._scrollOffset = offset
    this._playheadTime = this._xt(offset)
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

  private _animateToPosition(targetOffset: number, now: number): void {
    this._setMode({
      kind: 'animation',
      startOffset: this._scrollOffset,
      targetOffset: clamp(targetOffset, 0, this._maxOffset()),
      startTime: now,
    }, `tap-seek to ${this._xt(targetOffset).toFixed(0)}`)
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
  // animation, playback follow (attached or detached), external snap. Pushes
  // only expand the selection, so MIN_SELECTION_DURATION (a handle-drag
  // constraint) can never be violated here; playhead clamping bounds the
  // pushes to [0, duration].
  //
  // Sweeps are playhead movements. During a handle drag the detached playhead
  // still pushes, but never the anchor under the user's finger — the finger
  // wins.
  // =========================================================================

  private _pushSelection(prevTime: number, newTime: number, now: number): void {
    if (!this._linked || !this._selection) return
    if (newTime === prevTime) return

    let { start, end } = this._selection

    if (newTime > prevTime) {
      // Forward sweep: carry the end anchor in [prevTime, newTime) forward
      if (this._draggingHandle !== 'end' && end >= prevTime && end < newTime) end = newTime
    } else {
      // Backward sweep: carry the start anchor in (newTime, prevTime] backward
      if (this._draggingHandle !== 'start' && start > newTime && start <= prevTime) start = newTime
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
    if (this._callbacks.onTrace) {
      this._trace('emitSelection', `${this._selection.start.toFixed(0)}..${this._selection.end.toFixed(0)}${force ? ' (forced)' : ''}`)
    }
    this._callbacks.onSelectionChange?.(this._selection.start, this._selection.end)
  }

  /**
   * True while the engine itself may be mutating the selection — a handle
   * drag, or linked pushing during any motion. See updateSelection().
   */
  private _selectionLocked(): boolean {
    if (this._mode.kind === 'handleDrag') return true
    if (!this._linked || !this._selection) return false

    return this._mode.kind !== 'idle' || this._playbackRate > 0
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
  // Checks if a touch point (in screen coordinates) lands in a handle's hit
  // column: full timeline height, HANDLE_TOUCH_RADIUS to each side of the pin
  // center. The whole visual handle is grabbable — the line sits within the
  // column (HANDLE_PIN_OFFSET < HANDLE_TOUCH_RADIUS). Pins sit on the
  // external side of each handle line (start: left, end: right) — same
  // geometry Timeline.tsx draws (HANDLE_PIN_* constants).
  // =========================================================================

  private _getHandleAtPosition(touchX: number): 'start' | 'end' | null {
    if (!this._selection) return null

    const halfWidth = this._containerWidth / 2

    // Convert screen-space touch to timeline-space coordinate
    const timelineX = this._scrollOffset + (touchX - halfWidth)

    const startPinX = this._tx(this._selection.start) - HANDLE_SHIFT - HANDLE_PIN_OFFSET
    const endPinX = this._tx(this._selection.end) + HANDLE_SHIFT + HANDLE_PIN_OFFSET

    const distToStart = Math.abs(timelineX - startPinX)
    const distToEnd = Math.abs(timelineX - endPinX)

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
