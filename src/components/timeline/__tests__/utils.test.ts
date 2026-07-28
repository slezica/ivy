import { createSegmentHeightFn } from '../utils'
import { TIMELINE_HEIGHT } from '../constants'

describe('createSegmentHeightFn', () => {
  it('is deterministic for the same seed', () => {
    const a = createSegmentHeightFn('book-1')
    const b = createSegmentHeightFn('book-1')
    for (let i = 0; i < 200; i++) {
      expect(a(i)).toBe(b(i))
    }
  })

  it('produces different shapes for different seeds', () => {
    const a = createSegmentHeightFn('book-1')
    const b = createSegmentHeightFn('book-2')
    let differing = 0
    for (let i = 0; i < 200; i++) {
      if (a(i) !== b(i)) differing++
    }
    expect(differing).toBeGreaterThan(150)
  })

  it('stays within bar height bounds', () => {
    const fn = createSegmentHeightFn('any-seed')
    for (let i = 0; i < 1000; i++) {
      const h = fn(i)
      expect(h).toBeGreaterThanOrEqual(12)
      expect(h).toBeLessThanOrEqual(TIMELINE_HEIGHT)
    }
  })
})
