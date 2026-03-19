import type { AudioPlayerService } from '../services'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'
import type { LoadBook } from './load_book'

export type { LoadBookContext as PlayContext } from './load_book'


export interface PlayDeps {
  audio: AudioPlayerService
  set: SetState
  get: GetState
  loadBook: LoadBook
}

export type Play = Action<[import('./load_book').LoadBookContext]>

export const createPlay: ActionFactory<PlayDeps, Play> = (deps) => (
  async (context) => {
    const { audio, set, get, loadBook } = deps

    try {
      await loadBook(context)

      set(state => {
        state.playback.status = 'playing'
        state.playback.ownerId = context.ownerId
      })

      await audio.play()

    } catch (error) {
      set(state => {
        state.playback.status = state.playback.uri ? 'paused' : 'idle'
      })

      throw error
    }
  }
)
