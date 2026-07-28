/**
 * Shared utilities for timeline components.
 */

import { TIMELINE_HEIGHT } from './constants'

/** FNV-1a 32-bit string hash. */
function hashString(str: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Mulberry32 PRNG — deterministic [0, 1) sequence from a numeric seed. */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Build a decorative "waveform" height function for a seed (book id).
 * Layered sine waves plus pseudo-random variation; the seed drives each
 * layer's frequency and phase, so books get distinct (stable) shapes.
 */
export function createSegmentHeightFn(seed: string): (index: number) => number {
  const rand = mulberry32(hashString(seed))
  const f1 = 0.1 + rand() * 0.12
  const f2 = 0.3 + rand() * 0.25
  const f3 = 1.5 + rand() * 1.3
  const p1 = rand() * Math.PI * 2
  const p2 = rand() * Math.PI * 2
  const p3 = rand() * Math.PI * 2
  const noiseOffset = Math.floor(rand() * 1000)

  return (index: number) => {
    const baseHeight = TIMELINE_HEIGHT / 2
    const variation = TIMELINE_HEIGHT / 4

    let height = baseHeight
    height += Math.sin(index * f1 + p1) * variation
    height += Math.sin(index * f2 + p2) * (variation * 0.5)
    height += Math.sin(index * f3 + p3) * (variation * 0.3)
    height += (((index + noiseOffset) * 7919) % 100) / 100 * 8

    return Math.max(12, Math.min(TIMELINE_HEIGHT, height * 0.8))
  }
}

/**
 * Convert time (ms) to x coordinate in timeline space.
 */
export function timeToX(time: number, segmentDuration: number, segmentWidth: number, segmentGap: number): number {
  return (time / segmentDuration) * (segmentWidth + segmentGap)
}

/**
 * Convert x coordinate in timeline space to time (ms).
 */
export function xToTime(x: number, segmentDuration: number, segmentWidth: number, segmentGap: number): number {
  return (x / (segmentWidth + segmentGap)) * segmentDuration
}

/**
 * Clamp a value between min and max.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
