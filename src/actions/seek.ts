import type { AudioPlayerService } from '../services'
import type { SetState, GetState, PlaybackContext, Action, ActionFactory } from '../store/types'


export interface SeekDeps {
  audio: AudioPlayerService
  set: SetState
  get: GetState
}

export type Seek = Action<[PlaybackContext]>

export const createSeek: ActionFactory<SeekDeps, Seek> = (deps) => (
  async (context) => {
    const { audio, set, get } = deps
    const { playback } = get()

    // Only seek if the requested file is currently loaded
    if (playback.uri !== context.fileUri) {
      console.log('Seek ignored: file not loaded', context.fileUri)
      return
    }

    set(state => {
      state.playback.position = context.position
    })

    try {
      await audio.seek(context.position)
    } catch (error) {
      console.error('Error seeking:', error)
      throw error
    }
  }
)
