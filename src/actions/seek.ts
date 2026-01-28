import type { AudioPlayerService } from '../services'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'


export interface SeekContext {
  fileUri: string
  position: number
}

export interface SeekDeps {
  audio: AudioPlayerService
  set: SetState
  get: GetState
}

export type Seek = Action<[SeekContext]>

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
