/**
 * Shared utilities for timeline components.
 */

import { SEGMENT_STEP, SEGMENT_DURATION, TIMELINE_HEIGHT } from './constants'

/**
 * Compute a decorative "waveform" height for a segment.
 * Uses layered sine waves plus pseudo-random variation.
 */
export function getSegmentHeight(index: number): number {
  const baseHeight = TIMELINE_HEIGHT / 2
  const variation = TIMELINE_HEIGHT / 4

  let height = baseHeight
  height += Math.sin(index * 0.15) * variation
  height += Math.sin(index * 0.4) * (variation * 0.5)
  height += Math.sin(index * 2) * (variation * 0.3)
  height += ((index * 7919) % 100) / 100 * 8

  return Math.max(12, Math.min(TIMELINE_HEIGHT, height * 0.8))
}

/**
 * Convert time (ms) to x coordinate in timeline space.
 */
export function timeToX(time: number): number {
  return (time / SEGMENT_DURATION) * SEGMENT_STEP
}

/**
 * Convert x coordinate in timeline space to time (ms).
 */
export function xToTime(x: number): number {
  return (x / SEGMENT_STEP) * SEGMENT_DURATION
}

/**
 * Clamp a value between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
