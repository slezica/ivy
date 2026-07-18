import { createSkipForward } from '../skip_forward'
import { createSkipBackward } from '../skip_backward'
import { SKIP_FORWARD_MS, SKIP_BACKWARD_MS } from '../constants'


describe('skip actions', () => {
  it('skips forward by +SKIP_FORWARD_MS', async () => {
    const audio = { skip: jest.fn(async () => {}) }

    await createSkipForward({ audio: audio as any })()

    // Direction matters: forward must be positive (a sign flip is a real bug)
    expect(audio.skip).toHaveBeenCalledWith(SKIP_FORWARD_MS)
    expect(SKIP_FORWARD_MS).toBeGreaterThan(0)
  })

  it('skips backward by -SKIP_BACKWARD_MS', async () => {
    const audio = { skip: jest.fn(async () => {}) }

    await createSkipBackward({ audio: audio as any })()

    expect(audio.skip).toHaveBeenCalledWith(-SKIP_BACKWARD_MS)
  })
})
