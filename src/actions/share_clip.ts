import type { SharingService } from '../services'
import type { GetState, Action, ActionFactory } from '../store/types'


export interface ShareClipDeps {
  sharing: SharingService
  get: GetState
}

export type ShareClip = Action<[string]>

export const createShareClip: ActionFactory<ShareClipDeps, ShareClip> = (deps) => (
  async (clipId) => {
    const { sharing, get } = deps

    const { clips } = get()
    const clip = clips[clipId]

    if (!clip) {
      throw new Error('Clip not found')
    }

    // Share using the clip's existing audio file
    await sharing.shareClipFile(clip.uri, clip.note || clip.file_name)
  }
)
