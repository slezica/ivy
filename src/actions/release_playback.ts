import type { GetState, Action, ActionFactory } from '../store/types'
import { createLogger, MAIN_PLAYER_OWNER_ID } from '../utils'
import type { Pause } from './pause'
import type { LoadBook } from './load_book'


export interface ReleasePlaybackDeps {
  get: GetState
  pause: Pause
  loadBook: LoadBook
}

export type ReleasePlayback = Action<[string]>

/**
 * Release playback held by a dismissed component: pause, then hand ownership
 * back to the main player with whatever it had loaded (playback.mainContext).
 * No-op unless the caller still owns playback.
 */
export const createReleasePlayback: ActionFactory<ReleasePlaybackDeps, ReleasePlayback> = (deps) => (
  async (ownerId) => {
    const { get, pause, loadBook } = deps
    const log = createLogger('ReleasePlayback')

    const { playback } = get()
    if (playback.ownerId !== ownerId) return

    log(`Releasing playback from ${ownerId}`)
    await pause()

    const context = playback.mainContext
    if (!context) return

    // Re-check after the await — a new owner may have claimed meanwhile
    if (get().playback.ownerId !== ownerId) return

    try {
      await loadBook({ fileUri: context.uri, position: context.position, ownerId: MAIN_PLAYER_OWNER_ID })
    } catch (error) {
      // Non-critical: the snapshotted book may be gone (archived/deleted)
      console.error('Failed to return playback to main player:', error)
    }
  }
)
