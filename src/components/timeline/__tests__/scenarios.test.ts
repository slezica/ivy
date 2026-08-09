/**
 * TimelinePhysicsEngine — Scenario Tests
 *
 * Where engine.test.ts asserts engine-internal expectations for isolated
 * gestures, these tests drive full interaction flows against a ground-truth
 * audio model: a simulated player advancing in real time, feeding the engine
 * the same 1 Hz, slightly-stale position events it gets in the app.
 *
 * Every scenario ends with the same universal invariants (`expectSettled`):
 *
 *   1. The engine returns to inactive once all gestures finalize and
 *      ballistic motion ends — no leaked interaction state.
 *   2. While audio plays, the scroll center converges back onto the
 *      ground-truth position — playback follow resumes and tracks.
 *
 * Scenarios marked `it.failing` encode known bugs (red until fixed): jest
 * passes them while they fail, and flags them the moment a fix makes them
 * pass — remove the `.failing` then.
 */

import { TimelinePhysicsEngine, EngineCallbacks } from '../engine'
import {
  SEGMENT_WIDTH,
  SEGMENT_GAP,
  SEGMENT_DURATION,
  HANDLE_SHIFT,
  HANDLE_PIN_OFFSET,
  HANDLE_PIN_Y,
} from '../constants'
import { timeToX, xToTime } from '../utils'

const WIDTH = 400
const DURATION = 600_000
const STEP = 16 // ms per simulated frame
const EVENT_INTERVAL = 1000 // ms between external position events (RNTP 1 Hz)
const EVENT_LATENCY = 100 // ms of staleness on each position event

function tx(time: number): number {
  return timeToX(time, SEGMENT_DURATION, SEGMENT_WIDTH, SEGMENT_GAP)
}

function xt(x: number): number {
  return xToTime(x, SEGMENT_DURATION, SEGMENT_WIDTH, SEGMENT_GAP)
}

// ============================================================================
// Scenario driver
//
// Wraps the engine with a ground-truth audio clock and gesture primitives
// expressed in screen coordinates, like the hook delivers them.
// ============================================================================

class Scenario {
  readonly engine: TimelinePhysicsEngine
  readonly seeks: Array<{ t: number; pos: number; audio: number }> = []

  audio: number // ground-truth player position (ms)
  t = 0 // wall clock (ms)

  private playing: boolean
  private lastTouchX = 0

  constructor(opts: {
    position: number
    selection?: { start: number; end: number }
    linked?: boolean
    playing?: boolean
  }) {
    this.audio = opts.position
    this.playing = opts.playing ?? true

    const callbacks: EngineCallbacks = {
      onSeek: (pos) => {
        this.seeks.push({ t: this.t, pos, audio: this.audio })
        this.audio = pos // the app seeks the player to engine positions
      },
      onSelectionChange: () => {},
      onFrame: () => {},
      onDisplayPosition: () => {},
    }

    this.engine = new TimelinePhysicsEngine(
      {
        duration: DURATION,
        containerWidth: WIDTH,
        position: opts.position,
        selection: opts.selection,
        linked: opts.linked ?? true,
      },
      callbacks
    )

    if (this.playing) this.engine.setPlaybackRate(1, 0)
  }

  /** Advance the world: audio clock, engine ticks, 1 Hz position events. */
  run(ms: number, perStep?: () => void): void {
    const until = this.t + ms
    while (this.t < until) {
      this.t += STEP
      if (this.playing) this.audio += STEP
      perStep?.()
      this.engine.tick(this.t)
      if (this.t % EVENT_INTERVAL < STEP) {
        this.engine.setExternalPosition(this.audio - EVENT_LATENCY, this.t)
      }
    }
  }

  /** Screen x of a handle pin center at the current scroll. */
  pinX(which: 'start' | 'end'): number {
    const sel = this.engine.selection!
    const outward = HANDLE_SHIFT + HANDLE_PIN_OFFSET
    const time = which === 'start' ? sel.start : sel.end
    const timelineX = tx(time) + (which === 'start' ? -outward : outward)
    return timelineX - this.engine.scrollOffset + WIDTH / 2
  }

  /** Finger down at screen x (tap gesture's onBegin → touchDown). */
  touchDown(x: number): void {
    this.lastTouchX = x
    this.engine.touchDown(x, HANDLE_PIN_Y, this.t)
  }

  /**
   * Pan activation after the finger travelled `travelPx` from touchDown.
   * RNGH activates pans at ~10px of travel, so panStart's x differs from
   * touchDown's — the two hit-test independently.
   */
  panActivate(travelPx: number): void {
    this.engine.panStart(this.lastTouchX + travelPx, HANDLE_PIN_Y, this.t)
  }

  /** Drag by `px` over `ms`, cumulative translation like RNGH reports it. */
  drag(px: number, ms: number, fromTranslation = 0): void {
    const start = this.t
    this.run(ms, () => {
      const progress = Math.min(1, (this.t - start) / ms)
      this.engine.panUpdate(fromTranslation + px * progress, this.t)
    })
  }

  /** Finger up: pan end (velocity per EMA) then the guaranteed finalizer. */
  release(): void {
    this.engine.panEnd(0, this.t)
    this.engine.touchUp()
  }

  /** Full tap gesture at screen x. */
  tap(x: number): void {
    this.engine.touchDown(x, HANDLE_PIN_Y, this.t)
    this.engine.tap(x, this.t)
    this.engine.touchUp()
  }

  scrollCenterTime(): number {
    return xt(this.engine.scrollOffset)
  }

  /**
   * Universal invariants after a hands-off settling period:
   * no leaked interaction state, and (while playing) follow re-converges
   * onto ground truth.
   */
  expectSettled(): void {
    this.run(4000)
    expect(this.engine.isActive).toBe(false)
    if (this.playing) {
      expect(Math.abs(this.scrollCenterTime() - this.audio)).toBeLessThan(400)
      expect(Math.abs(this.engine.playheadTime - this.audio)).toBeLessThan(400)
    }
  }
}

// ============================================================================
// Green scenarios: complete flows that must keep working
// ============================================================================

describe('scenarios: clean interaction flows', () => {
  it('scrub while playing: drag, release, seek near release point, follow resumes', () => {
    const s = new Scenario({ position: 100_000 })
    s.run(2000)

    s.touchDown(WIDTH / 2)
    s.panActivate(10)
    s.drag(80, 300) // scrub backward in time (bars dragged right)
    s.drag(0, 200, 80) // hold still so the EMA velocity dies (no momentum)
    const centerAtRelease = s.scrollCenterTime()
    s.release()

    s.run(200)
    expect(s.seeks).toHaveLength(1)
    expect(Math.abs(s.seeks[0].pos - centerAtRelease)).toBeLessThan(500)
    s.expectSettled()
  })

  it('fling while playing: momentum runs out, single seek, follow resumes', () => {
    const s = new Scenario({ position: 100_000 })
    s.run(2000)

    s.touchDown(WIDTH / 2)
    s.panActivate(10)
    // Fast swipe: enough velocity for momentum
    s.drag(-150, 100)
    s.release()

    s.run(3000)
    expect(s.seeks).toHaveLength(1)
    s.expectSettled()
  })

  it('tap-to-seek while playing: animation completes, seeks the tapped time', () => {
    const s = new Scenario({ position: 100_000 })
    s.run(2000)

    const targetTime = xt(s.engine.scrollOffset + 100) // 100px right of center
    s.tap(WIDTH / 2 + 100)

    s.run(1000)
    expect(s.seeks).toHaveLength(1)
    expect(Math.abs(s.seeks[0].pos - targetTime)).toBeLessThan(200)
    s.expectSettled()
  })

  it('handle drag by the pin while playing: detach, glide back, never seeks', () => {
    const s = new Scenario({
      position: 105_000,
      selection: { start: 100_000, end: 110_000 },
    })
    s.run(2000)

    s.touchDown(s.pinX('start'))
    s.panActivate(-10) // outward travel: stays inside the hit column
    const frozen = s.engine.scrollOffset
    s.drag(-30, 3000, -10)
    expect(s.engine.scrollOffset).toBe(frozen) // scroll froze for the drag
    expect(s.engine.playheadTime).toBeGreaterThan(xt(frozen)) // playhead detached
    s.release()

    expect(s.seeks).toHaveLength(0)
    s.expectSettled()
    expect(s.seeks).toHaveLength(0)
  })

  it('handle touch that never becomes a tap or pan: finalizer recovers', () => {
    const s = new Scenario({
      position: 105_000,
      selection: { start: 100_000, end: 110_000 },
    })
    s.run(2000)

    s.touchDown(s.pinX('start'))
    s.run(700) // held past the tap timeout, no movement
    s.engine.touchUp() // only the finalizer fires

    s.expectSettled()
  })

  it('paused scrub: drag seeks and nothing moves afterwards', () => {
    const s = new Scenario({ position: 100_000, playing: false })

    s.touchDown(WIDTH / 2)
    s.panActivate(10)
    s.drag(60, 300)
    s.drag(0, 200, 60) // hold still so the EMA velocity dies (no momentum)
    s.release()

    s.run(500)
    expect(s.seeks).toHaveLength(1)
    const rest = s.engine.playheadTime
    s.run(2000)
    expect(s.engine.playheadTime).toBe(rest)
    expect(s.engine.isActive).toBe(false)
  })
})

// ============================================================================
// Red scenarios: today's bug (touchDown/panStart hit-test disagreement)
//
// touchDown grabs the handle, but the pan activates after enough finger
// travel to land outside the hit column — panStart misses and starts a
// scroll drag. Both `_draggingHandle` and `_isDragging` are set; panEnd's
// handle branch returns early and `_isDragging` leaks true forever. The
// engine stays active: follow and external sync are blocked (frozen
// timeline), and the next scrub seeks to the stale frozen position —
// audio teleports back in time.
// ============================================================================

describe('scenarios: handle grab where pan activation misses the hit column', () => {
  /**
   * Grab the START handle by its line (16px inside the pin center — a hit),
   * then activate the pan after 10px of inward travel (26px from the pin —
   * a miss). Shrink-drags grabbed by the line always look like this: the
   * inward hit-column budget (24 − 16 = 8px) is smaller than the pan
   * activation distance (~10px).
   */
  function leakedHandleDrag(s: Scenario): void {
    s.touchDown(s.pinX('start') + HANDLE_PIN_OFFSET) // on the handle line
    s.panActivate(10) // inward: leaves the hit column
    s.drag(20, 3000, 10) // shrink the selection a bit
    s.release()
  }

  it('engine settles and follow resumes after the drag', () => {
    const s = new Scenario({
      position: 105_000,
      selection: { start: 100_000, end: 110_000 },
    })
    s.run(2000)

    leakedHandleDrag(s)

    s.expectSettled()
  })

  it('a later scrub does not teleport audio back in time', () => {
    const s = new Scenario({
      position: 105_000,
      selection: { start: 100_000, end: 110_000 },
    })
    s.run(2000)

    leakedHandleDrag(s)
    s.run(5000) // user listens on; leaked state has frozen the timeline

    // A small scrub near the center — the user pokes the timeline
    s.touchDown(WIDTH / 2 + 100)
    s.panActivate(10)
    s.drag(-5, 200, 10)
    s.release()
    s.run(200)

    // The seek must land near the live position, not seconds in the past
    expect(s.seeks).toHaveLength(1)
    expect(Math.abs(s.seeks[0].pos - s.seeks[0].audio)).toBeLessThan(1500)
  })

  it('re-grabbing a handle mid-glide settles cleanly', () => {
    const s = new Scenario({
      position: 105_000,
      selection: { start: 100_000, end: 110_000 },
    })
    s.run(2000)

    // First adjustment: clean pin grab, long enough to open a wide gap
    s.touchDown(s.pinX('start'))
    s.panActivate(-10)
    s.drag(-30, 4000, -10)
    s.release()

    // Re-grab during the glide: touchDown hits the pin, but the scroll is
    // moving fast — by pan activation the pin has scrolled away
    s.run(150)
    s.touchDown(s.pinX('start'))
    s.run(100) // glide keeps moving? (scroll freezes on touchDown if grabbed)
    s.panActivate(30) // travel lands outside the (frozen or moved) column
    s.drag(15, 1000, 30)
    s.release()

    s.expectSettled()
  })
})

// ============================================================================
// Fuzz: seeded random interleavings must always settle
//
// Random gesture fragments — including handle grabs at random offsets and
// pans activating after random travel — chained without waiting for the
// engine to settle in between. After each burst the universal invariants
// must hold. Deterministic via a seeded PRNG.
// ============================================================================

describe('scenarios: fuzzed interleavings', () => {
  function lcg(seed: number): () => number {
    let state = seed >>> 0
    return () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 0xffffffff
    }
  }

  it('every random gesture burst settles back to following', () => {
    const rand = lcg(20260809)

    for (let round = 0; round < 30; round++) {
      const s = new Scenario({
        position: 105_000,
        selection: { start: 100_000, end: 110_000 },
      })
      s.run(1000 + Math.floor(rand() * 2000))

      const gestures = 1 + Math.floor(rand() * 3)
      for (let g = 0; g < gestures; g++) {
        const x = rand() < 0.5
          ? s.pinX(rand() < 0.5 ? 'start' : 'end') + (rand() * 80 - 40)
          : rand() * WIDTH
        s.touchDown(x)

        const kind = rand()
        if (kind < 0.25) {
          // Tap or abandoned touch
          if (rand() < 0.5) s.engine.tap(x, s.t)
          s.engine.touchUp()
        } else {
          // Pan with random activation travel and drag
          s.panActivate(rand() * 40 - 20)
          s.drag(rand() * 160 - 80, 100 + rand() * 1500)
          s.release()
        }
        s.run(rand() * 800)
      }

      s.expectSettled()
    }
  })
})
