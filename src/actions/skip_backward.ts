import type { AudioPlayerService } from '../services'
import type { Action, ActionFactory } from '../store/types'
import { SKIP_BACKWARD_MS } from './constants'


export interface SkipBackwardDeps {
  audio: AudioPlayerService
}

export type SkipBackward = Action<[]>

export const createSkipBackward: ActionFactory<SkipBackwardDeps, SkipBackward> = (deps) => (
  async () => {
    const { audio } = deps

    try {
      await audio.skip(-SKIP_BACKWARD_MS)
    } catch (error) {
      console.error('Error skipping backward:', error)
      throw error
    }
  }
)
