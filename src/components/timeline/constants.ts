/**
 * Shared constants for timeline components.
 */

// Layout
export const SEGMENT_WIDTH = 4
export const SEGMENT_GAP = 2
export const SEGMENT_STEP = SEGMENT_WIDTH + SEGMENT_GAP
export const SEGMENT_DURATION = 5000 // 5 seconds per segment
export const TIMELINE_HEIGHT = 90
export const PLAYHEAD_WIDTH = 2
export const PLACEHOLDER_HEIGHT = 8
export const TIME_INDICATORS_HEIGHT = 24
export const TIME_INDICATORS_MARGIN = 8

// Physics
export const DECELERATION = 0.95 // Velocity multiplier per frame
export const MIN_VELOCITY = 0.5 // Stop momentum below this
export const VELOCITY_SCALE = 1 / 60 // Convert gesture velocity (px/s) to px/frame

// Animation
export const SCROLL_TO_DURATION = 200 // ms for tap-to-seek animation

// Selection constraints
export const MIN_SELECTION_DURATION = 1000 // 1 second minimum between handles
