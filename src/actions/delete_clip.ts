import type { DatabaseService, AudioSlicerService, SyncQueueService } from '../services'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'


export interface DeleteClipDeps {
  db: DatabaseService
  slicer: AudioSlicerService
  syncQueue: SyncQueueService
  set: SetState
  get: GetState
}

export type DeleteClip = Action<[string]>

export const createDeleteClip: ActionFactory<DeleteClipDeps, DeleteClip> = (deps) => (
  async (id) => {
    const { db, slicer, syncQueue, set, get } = deps

    const { clips } = get()
    const clip = clips[id]

    // Delete clip audio file
    if (clip?.uri) {
      await slicer.cleanup(clip.uri)
    }

    db.deleteClip(id)

    // Queue for sync (delete operation)
    syncQueue.queueChange('clip', id, 'delete')

    set((state) => {
      delete state.clips[id]
    })
  }
)
