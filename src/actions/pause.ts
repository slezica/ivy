import type { AudioPlayerService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'


export interface PauseDeps {
  audio: AudioPlayerService
  set: SetState
}

export type Pause = Action<[]>

export const createPause: ActionFactory<PauseDeps, Pause> = (deps) => (
  async () => {
    const { audio, set } = deps
    const log = createLogger('Pause')

    log('Pausing')

    set(state => {
      state.playback.status = 'paused'
    })

    await audio.pause()
  }
)
