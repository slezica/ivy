import type { AudioPlayerService } from '../services'
import type { Action, ActionFactory } from '../store/types'
import { SKIP_FORWARD_MS } from './constants'


export interface SkipForwardDeps {
  audio: AudioPlayerService
}

export type SkipForward = Action<[]>

export const createSkipForward: ActionFactory<SkipForwardDeps, SkipForward> = (deps) => (
  async () => {
    const { audio } = deps

    try {
      await audio.skip(SKIP_FORWARD_MS)
    } catch (error) {
      console.error('Error skipping forward:', error)
      throw error
    }
  }
)
