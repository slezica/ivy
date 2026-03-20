import type { AudioPlayerService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'


export interface FetchPlaybackStateDeps {
  audio: AudioPlayerService
  set: SetState
}

export type FetchPlaybackState = Action<[]>

export const createFetchPlaybackState: ActionFactory<FetchPlaybackStateDeps, FetchPlaybackState> = (deps) => (
  async () => {
    const { audio, set } = deps

    const status = await audio.getStatus()
    if (!status) return

    set(state => {
      if (state.playback.status !== 'loading') {
        state.playback.status = status.status
      }
      state.playback.position = status.position
    })
  }
)
