/**
 * AudioPlayerService tests. TrackPlayer is mocked — these cover the fade
 * state machine (ramp, completion, cancellation) and what load() hands the
 * media session, not native playback.
 */

import TrackPlayer from 'react-native-track-player'
import { AudioPlayerService } from '../player'

// jest.mock calls are hoisted above the imports
jest.mock('react-native-track-player', () => ({
  __esModule: true,
  default: {
    setVolume: jest.fn(async () => {}),
    setupPlayer: jest.fn(async () => {}),
    updateOptions: jest.fn(async () => {}),
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
    reset: jest.fn(async () => {}),
    add: jest.fn(async () => {}),
    getProgress: jest.fn(async () => ({ duration: 60 })),
  },
  Capability: {},
  Event: {},
  State: {},
  AppKilledPlaybackBehavior: {},
}))

const setVolume = TrackPlayer.setVolume as jest.Mock
const add = TrackPlayer.add as jest.Mock


describe('AudioPlayerService fade', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    setVolume.mockClear()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('ramps volume down and resolves true on completion', async () => {
    const audio = new AudioPlayerService()

    const fade = audio.fadeOut(1_000)
    await jest.advanceTimersByTimeAsync(0)
    expect(setVolume).toHaveBeenCalledWith(1)  // fade starts from full volume

    await jest.advanceTimersByTimeAsync(250)
    expect(setVolume).toHaveBeenLastCalledWith(0.75)

    await jest.advanceTimersByTimeAsync(250)
    expect(setVolume).toHaveBeenLastCalledWith(0.5)

    await jest.advanceTimersByTimeAsync(500)
    await expect(fade).resolves.toBe(true)
    expect(setVolume).toHaveBeenLastCalledWith(0)
  })

  it('resetVolume cancels a running fade and restores full volume', async () => {
    const audio = new AudioPlayerService()

    const fade = audio.fadeOut(1_000)
    await jest.advanceTimersByTimeAsync(500)

    await audio.resetVolume()
    await expect(fade).resolves.toBe(false)
    expect(setVolume).toHaveBeenLastCalledWith(1)

    // No further ramp ticks after cancellation
    setVolume.mockClear()
    await jest.advanceTimersByTimeAsync(2_000)
    expect(setVolume).not.toHaveBeenCalled()
  })

  it('starting a new fade cancels the previous one', async () => {
    const audio = new AudioPlayerService()

    const first = audio.fadeOut(1_000)
    await jest.advanceTimersByTimeAsync(500)

    const second = audio.fadeOut(1_000)
    await expect(first).resolves.toBe(false)

    await jest.advanceTimersByTimeAsync(1_000)
    await expect(second).resolves.toBe(true)
    expect(setVolume).toHaveBeenLastCalledWith(0)
  })

  it('resetVolume without a running fade just restores volume', async () => {
    const audio = new AudioPlayerService()

    await audio.resetVolume()
    expect(setVolume).toHaveBeenCalledWith(1)
  })
})


describe('AudioPlayerService load artwork', () => {
  const COVER = 'file:///docs/artwork/book-1.abcd.jpg'

  beforeEach(() => {
    add.mockClear()
  })

  it('hands the media session the cover file URI as is', async () => {
    await new AudioPlayerService().load('file:///book.m4a', { title: 'Book', artist: 'Author', artwork: COVER })

    expect(add).toHaveBeenCalledWith(expect.objectContaining({ artwork: COVER }))
  })

  it('never hands the media session a data URI', async () => {
    const dataUri = 'data:image/jpeg;base64,AAAA'

    await expect(new AudioPlayerService().load('file:///book.m4a', { title: 'Book', artwork: dataUri }))
      .resolves.toBe(60_000)

    const track = add.mock.calls[0][0]
    expect(track.artwork).toBeUndefined()
    expect(JSON.stringify(track)).not.toContain('data:')
  })

  it('loads without a cover when the book has none', async () => {
    await new AudioPlayerService().load('file:///book.m4a', { title: 'Book', artwork: null })

    expect(add).toHaveBeenCalledWith(expect.objectContaining({ artwork: undefined }))
  })
})
