/**
 * AudioPlayerService fade tests. TrackPlayer is mocked — these cover the
 * fade state machine (ramp, completion, cancellation), not native playback.
 */

jest.mock('react-native-track-player', () => ({
  __esModule: true,
  default: {
    setVolume: jest.fn(async () => {}),
  },
  Capability: {},
  Event: {},
  State: {},
  AppKilledPlaybackBehavior: {},
}))

import TrackPlayer from 'react-native-track-player'
import { AudioPlayerService } from '../player'

const setVolume = TrackPlayer.setVolume as jest.Mock


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
