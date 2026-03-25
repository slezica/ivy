import type { AudioPlayerService } from '../services'
import type { Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'
import { SKIP_FORWARD_MS } from './constants'


export interface SkipForwardDeps {
  audio: AudioPlayerService
}

export type SkipForward = Action<[]>

export const createSkipForward: ActionFactory<SkipForwardDeps, SkipForward> = (deps) => (
  async () => {
    const { audio } = deps
    const log = createLogger('SkipForward')

    log(`+${SKIP_FORWARD_MS}ms`)

    await audio.skip(SKIP_FORWARD_MS)
  }
)
