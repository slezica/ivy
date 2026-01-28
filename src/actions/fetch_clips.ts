import type { DatabaseService, ClipWithFile } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'


export interface FetchClipsDeps {
  db: DatabaseService
  set: SetState
}

export type FetchClips = Action<[]>

export const createFetchClips: ActionFactory<FetchClipsDeps, FetchClips> = (deps) => (
  async () => {
    const { db, set } = deps

    const clips: Record<string, ClipWithFile> = {}
    for (const clip of db.getAllClips()) {
      clips[clip.id] = clip
    }

    set({ clips })
  }
)
