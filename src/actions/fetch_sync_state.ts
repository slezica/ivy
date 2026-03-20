import type { DatabaseService, BackupSyncService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'


export interface FetchSyncStateDeps {
  db: DatabaseService
  sync: BackupSyncService
  set: SetState
}

export type FetchSyncState = Action<[]>

export const createFetchSyncState: ActionFactory<FetchSyncStateDeps, FetchSyncState> = (deps) => (
  async () => {
    const { db, sync, set } = deps

    set((state) => {
      state.sync.pendingCount = sync.getPendingCount()
      state.sync.lastSyncTime = db.getLastSyncTime()
    })
  }
)
