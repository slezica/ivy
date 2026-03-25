import type { AudioPlayerService } from '../services'
import type { Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'
import { SKIP_BACKWARD_MS } from './constants'


export interface SkipBackwardDeps {
  audio: AudioPlayerService
}

export type SkipBackward = Action<[]>

export const createSkipBackward: ActionFactory<SkipBackwardDeps, SkipBackward> = (deps) => (
  async () => {
    const { audio } = deps
    const log = createLogger('SkipBackward')

    log(`-${SKIP_BACKWARD_MS}ms`)

    await audio.skip(-SKIP_BACKWARD_MS)
  }
)
