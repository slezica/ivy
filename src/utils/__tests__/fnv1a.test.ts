import { fnv1a } from '..'

describe('fnv1a', () => {
  it('matches the reference FNV-1a 32-bit vectors', () => {
    expect(fnv1a('')).toBe(0x811c9dc5)
    expect(fnv1a('a')).toBe(0xe40c292c)
    expect(fnv1a('foobar')).toBe(0xbf9cf968)
  })

  it('is unsigned', () => {
    expect(fnv1a('foobar')).toBeGreaterThan(0)
  })
})
