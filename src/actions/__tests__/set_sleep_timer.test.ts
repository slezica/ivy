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

  // Audio mock where the fade stays pending until completed or cancelled by
  // resetVolume — mirrors the real fadeOut/resetVolume contract, so mid-fade
  // transitions can be exercised
  function setupWithLinkedFade() {
    const base = setup()
    let pendingFade: ((completed: boolean) => void) | null = null

    base.audio.fadeOut.mockImplementation(
      () => new Promise<boolean>(resolve => { pendingFade = resolve })
    )
    base.audio.resetVolume.mockImplementation(async () => {
      pendingFade?.(false)
      pendingFade = null
    })
    const completeFade = () => {
      pendingFade?.(true)
      pendingFade = null
    }

    return { ...base, completeFade }
  }

  it('turning off mid-fade cancels the fade without pausing', async () => {
    const { state, setSleepTimer, audio, pause } = setupWithLinkedFade()

    await setSleepTimer(5_000, 2_000)
    await jest.advanceTimersByTimeAsync(3_000)  // fade running
    expect(audio.fadeOut).toHaveBeenCalledWith(2_000)

    await setSleepTimer(null)  // resetVolume cancels the pending fade
    await jest.advanceTimersByTimeAsync(10_000)

    expect(pause).not.toHaveBeenCalled()
    expect(state.playback.sleepTimer).toBeNull()
  })

  it('re-arming mid-fade cancels the fade and starts a fresh cycle', async () => {
    const { state, setSleepTimer, pause, completeFade } = setupWithLinkedFade()
    jest.setSystemTime(0)

    await setSleepTimer(5_000, 2_000)
    await jest.advanceTimersByTimeAsync(3_000)  // t=3s: fade running

    await setSleepTimer(5_000, 2_000)  // re-arm: endsAt now t=8s
    expect(pause).not.toHaveBeenCalled()  // old fade cancelled, no pause
    expect(state.playback.sleepTimer).toEqual({ endsAt: 8_000, duration: 5_000 })

    await jest.advanceTimersByTimeAsync(3_000)  // t=6s: new fade starts
    completeFade()
    await jest.advanceTimersByTimeAsync(0)

    expect(pause).toHaveBeenCalledTimes(1)
    expect(state.playback.sleepTimer).toBeNull()
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
