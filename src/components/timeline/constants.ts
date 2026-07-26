/**
 * Shared constants for timeline components.
 */

// Layout
export const SEGMENT_WIDTH = 4
export const SEGMENT_GAP = 2
export const SEGMENT_DURATION = 1000 // 1 second per segment

// Zoom bounds (expressed as factor on SEGMENT_WIDTH)
export const MIN_ZOOM = 1             // SEGMENT_WIDTH * 1 = 4px
export const MAX_ZOOM = 16            // SEGMENT_WIDTH * 16 = 64px
export const TIMELINE_HEIGHT = 90
export const PLAYHEAD_WIDTH = 2
export const PLACEHOLDER_HEIGHT = 8
export const TIME_INDICATORS_HEIGHT = 24
export const TIME_INDICATORS_MARGIN = 8

// Selection handles ("external pin" design)
//
// Each handle is a vertical line with a pin on its external side — a short
// horizontal stub pointing away from the selection, ending in a small
// circle: o-| for the start handle, |-o for the end handle. Pins point away
// from each other, so handles tolerate a 0px gap without overlapping.
// Drawing (Timeline.tsx) and hit-testing (engine.ts) share these numbers.
export const HANDLE_LINE_WIDTH = 2
export const HANDLE_LINE_HEIGHT = 70                                 // px — vertical line, centered
export const HANDLE_PIN_STUB = 7                                     // px — horizontal stub length
export const HANDLE_PIN_RADIUS = 6                                   // px — pin circle radius
export const HANDLE_PIN_OFFSET = HANDLE_PIN_STUB + HANDLE_PIN_RADIUS // handle line → pin center
export const HANDLE_PIN_Y = TIMELINE_HEIGHT / 2                      // pin center, vertically centered
export const HANDLE_TOUCH_RADIUS = 24                                // px — hit-test radius around pin center

// Physics (frame-rate independent — all units are per-second)
//
// Momentum uses continuous exponential decay: v(t) = v0 * DECELERATION^t
// where t is in seconds. Each tick computes dt from the real elapsed time,
// so the motion feels identical on 60Hz, 120Hz, or variable refresh displays.
export const DECELERATION = 0.95 ** 60 // ≈ 0.046 — velocity multiplier per second
export const MIN_VELOCITY = 30          // px/s — stop momentum below this

// Animation
export const SCROLL_TO_DURATION = 200 // ms for tap-to-seek animation

// Playback follow (smooth scroll while audio plays)
//
// The engine advances the timeline itself at the playback rate; the periodic
// position events from the player act as drift correction, not motion source.
export const DRIFT_SNAP_THRESHOLD = 2000 // ms — larger drift means an external seek: snap
export const DRIFT_FOLD_WINDOW = 1000    // ms — ~95% of smaller drift folded in within this window

// Selection constraints
//
// Product sanity floor for clip length — decoupled from handle geometry:
// the external pins point away from each other, so handles tolerate a 0px
// gap without overlapping. This only guards against degenerate selections.
export const MIN_SELECTION_DURATION = 250
