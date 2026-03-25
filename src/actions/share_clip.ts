import type { SharingService } from '../services'
import type { GetState, Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'


export interface ShareClipDeps {
  sharing: SharingService
  get: GetState
}

export type ShareClip = Action<[string]>

export const createShareClip: ActionFactory<ShareClipDeps, ShareClip> = (deps) => (
  async (clipId) => {
    const { sharing, get } = deps
    const log = createLogger('ShareClip')

    const { clips } = get()
    const clip = clips[clipId]

    if (!clip) {
      throw new Error('Clip not found')
    }

    log(`Sharing clip "${clip.note || clip.file_name}"`)

    // Share using the clip's existing audio file
    await sharing.shareClipFile(clip.uri, clip.note || clip.file_name)
  }
)
