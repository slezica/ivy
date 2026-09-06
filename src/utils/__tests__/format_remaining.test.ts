import { formatRemaining, formatTime } from '..'

describe('formatRemaining', () => {
  it('ticks in lockstep with formatTime(position) for a fractional duration', () => {
    const duration = 100_400

    // Sweep sub-second positions: remaining may only change when current does
    let prev = { current: formatTime(0), remaining: formatRemaining(0, duration) }
    for (let position = 100; position <= duration; position += 100) {
      const next = { current: formatTime(position), remaining: formatRemaining(position, duration) }
      if (next.remaining !== prev.remaining) {
        expect(next.current).not.toBe(prev.current)
      }
      prev = next
    }
  })

  it('sums with the current label to the whole-second duration', () => {
    expect(formatTime(12_300)).toBe('0:12')
    expect(formatRemaining(12_300, 100_400)).toBe('1:28')
  })

  it('never goes negative', () => {
    expect(formatRemaining(101_000, 100_400)).toBe('0:00')
  })
})
