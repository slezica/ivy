import type { AudioPlayerService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'


export interface PauseDeps {
  audio: AudioPlayerService
  set: SetState
}

export type Pause = Action<[]>

export const createPause: ActionFactory<PauseDeps, Pause> = (deps) => (
  async () => {
    const { audio, set } = deps

    set(state => {
      state.playback.status = 'paused'
    })

    try {
      await audio.pause()
    } catch (error) {
      console.error('Error pausing audio:', error)
      throw error
    }
  }
)
