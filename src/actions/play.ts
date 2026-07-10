import type { AudioPlayerService } from '../services'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'
import type { LoadBook } from './load_book'
import { createLogger } from '../utils'

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
    const log = createLogger('Play')

    // Another load is in flight — don't play whatever it ends up loading
    if (get().playback.status === 'loading') return

    log(`Playing at ${context.position}ms (owner: ${context.ownerId})`)

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
