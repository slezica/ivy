import type { AudioPlayerService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'
import type { Pause } from './pause'
import { SLEEP_TIMER_FADE_MS } from './constants'
import { createLogger } from '../utils'


export interface SetSleepTimerDeps {
  audio: AudioPlayerService
  pause: Pause
  set: SetState
}

// Duration in milliseconds, or null to turn the timer off. fadeMs overrides
// the fade length (dev/testing presets shorter than the standard fade).
export type SetSleepTimer = Action<[number | null, number?]>

export const createSetSleepTimer: ActionFactory<SetSleepTimerDeps, SetSleepTimer> = (deps) => {
  const { audio, pause, set } = deps
  const log = createLogger('SleepTimer')

  let expiry: ReturnType<typeof setTimeout> | null = null

  return async (durationMs, fadeMs = SLEEP_TIMER_FADE_MS) => {
    // Cancel any scheduled expiry and any fade already in progress
    if (expiry) {
      clearTimeout(expiry)
      expiry = null
    }
    await audio.resetVolume()

    if (durationMs === null) {
      log('Timer off')
      set(state => { state.playback.sleepTimer = null })
      return
    }

    log(`Timer set: ${durationMs}ms`)
    set(state => {
      state.playback.sleepTimer = { endsAt: Date.now() + durationMs, duration: durationMs }
    })

    // Wall-clock: the fade occupies the last fadeMs of the interval
    expiry = setTimeout(async () => {
      expiry = null
      const completed = await audio.fadeOut(fadeMs)
      if (!completed) return  // cancelled by a newer set/off

      log('Timer expired, pausing')
      await pause()
      await audio.resetVolume()
      set(state => { state.playback.sleepTimer = null })
    }, Math.max(0, durationMs - fadeMs))
  }
}
