/**
 * Base64 conversion helpers
 *
 * The chunked conversion must stay byte-exact with the platform encoding for
 * every length, including sizes around and across the chunk boundary.
 */

import { uint8ArrayToBase64, base64ToUint8Array } from '../sync'

/** Deterministic pseudo-random bytes (seeded LCG, no test flakiness). */
function pseudoRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  let state = 0x12345678
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    bytes[i] = state & 0xff
  }
  return bytes
}

describe('base64 helpers', () => {
  it.each([0, 1, 2, 3, 4, 5])('round-trips a %d-byte buffer', (length) => {
    const bytes = pseudoRandomBytes(length)
    const encoded = uint8ArrayToBase64(bytes)

    expect(encoded).toBe(Buffer.from(bytes).toString('base64'))
    expect(base64ToUint8Array(encoded)).toEqual(bytes)
  })

  it.each([8191, 8192, 8193])('round-trips a buffer of %d bytes (chunk boundary)', (length) => {
    const bytes = pseudoRandomBytes(length)
    const encoded = uint8ArrayToBase64(bytes)

    expect(encoded).toBe(Buffer.from(bytes).toString('base64'))
    expect(base64ToUint8Array(encoded)).toEqual(bytes)
  })

  it('round-trips a multi-megabyte buffer', () => {
    const bytes = pseudoRandomBytes(3 * 1024 * 1024 + 1) // odd size on purpose
    const encoded = uint8ArrayToBase64(bytes)

    expect(encoded).toBe(Buffer.from(bytes).toString('base64'))
    expect(base64ToUint8Array(encoded)).toEqual(bytes)
  })

  it('encodes all byte values correctly', () => {
    const bytes = new Uint8Array(256)
    for (let i = 0; i < 256; i++) bytes[i] = i
    const encoded = uint8ArrayToBase64(bytes)

    expect(encoded).toBe(Buffer.from(bytes).toString('base64'))
    expect(base64ToUint8Array(encoded)).toEqual(bytes)
  })
})
