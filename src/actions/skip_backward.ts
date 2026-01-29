import type { AudioPlayerService } from '../services'
import type { Action, ActionFactory } from '../store/types'
import { SKIP_BACKWARD_MS } from './constants'


export interface SkipBackwardDeps {
  audio: AudioPlayerService
}

export type SkipBackward = Action<[]>

export const createSkipBackward: ActionFactory<SkipBackwardDeps, SkipBackward> = (deps) => (
  async () => {
    await deps.audio.skip(-SKIP_BACKWARD_MS)
  }
)
