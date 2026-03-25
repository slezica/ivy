import type { AudioPlayerService } from '../services'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'


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
      createLogger('Seek')('Ignored: file not loaded', context.fileUri)
      return
    }

    set(state => {
      state.playback.position = context.position
    })

    await audio.seek(context.position)
  }
)
