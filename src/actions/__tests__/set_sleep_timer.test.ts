import { createSetSleepTimer } from '../set_sleep_timer'
import { SLEEP_TIMER_FADE_MS } from '../constants'
import { createMockState, createImmerSet, createMockAudio } from './helpers'


describe('setSleepTimer', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  function setup() {
    const state = createMockState()
    const set = createImmerSet(state)
    const audio = createMockAudio()
    const pause = jest.fn(async () => {})
    const setSleepTimer = createSetSleepTimer({ audio, pause, set })
    return { state, set, audio, pause, setSleepTimer }
  }

  it('stores endsAt and duration', async () => {
    const { state, setSleepTimer } = setup()
    jest.setSystemTime(1_000)

    await setSleepTimer(600_000)

    expect(state.playback.sleepTimer).toEqual({ endsAt: 601_000, duration: 600_000 })
  })

  it('fades out, pauses and clears on expiry', async () => {
    const { state, setSleepTimer, audio, pause } = setup()

    await setSleepTimer(600_000)
    await jest.advanceTimersByTimeAsync(600_000 - SLEEP_TIMER_FADE_MS)

    expect(audio.fadeOut).toHaveBeenCalledWith(SLEEP_TIMER_FADE_MS)
    expect(pause).toHaveBeenCalled()
    expect(audio.resetVolume).toHaveBeenCalled()
    expect(state.playback.sleepTimer).toBeNull()
  })

  it('turning off clears state and cancels the scheduled expiry', async () => {
    const { state, setSleepTimer, audio, pause } = setup()

    await setSleepTimer(600_000)
    await setSleepTimer(null)

    expect(state.playback.sleepTimer).toBeNull()
    expect(audio.resetVolume).toHaveBeenCalled()

    await jest.advanceTimersByTimeAsync(600_000)
    expect(audio.fadeOut).not.toHaveBeenCalled()
    expect(pause).not.toHaveBeenCalled()
  })

  it('does not pause when the fade was cancelled', async () => {
    const { state, setSleepTimer, audio, pause } = setup()
    audio.fadeOut.mockImplementation(async () => false)

    await setSleepTimer(600_000)
    await jest.advanceTimersByTimeAsync(600_000)

    expect(pause).not.toHaveBeenCalled()
    // State is left for the cancelling call to overwrite
    expect(state.playback.sleepTimer).toEqual(expect.anything())
  })

  it('re-setting reschedules from now', async () => {
    const { state, setSleepTimer, pause } = setup()
    jest.setSystemTime(0)

    await setSleepTimer(600_000)
    await jest.advanceTimersByTimeAsync(400_000)
    await setSleepTimer(600_000)  // reset the clock at t=400s

    expect(state.playback.sleepTimer).toEqual({ endsAt: 1_000_000, duration: 600_000 })

    // Old expiry (t=590s) must not fire
    await jest.advanceTimersByTimeAsync(190_000 + 1_000)
    expect(pause).not.toHaveBeenCalled()

    // New expiry (t=990s) does
    await jest.advanceTimersByTimeAsync(600_000)
    expect(pause).toHaveBeenCalledTimes(1)
  })
})
