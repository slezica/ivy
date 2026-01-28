import type { AudioPlayerService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'


export interface SyncPlaybackStateDeps {
  audio: AudioPlayerService
  set: SetState
}

export type SyncPlaybackState = Action<[]>

export const createSyncPlaybackState: ActionFactory<SyncPlaybackStateDeps, SyncPlaybackState> = (deps) => (
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
