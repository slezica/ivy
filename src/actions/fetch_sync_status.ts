import type { DatabaseService, BackupSyncService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'


export interface FetchSyncStatusDeps {
  db: DatabaseService
  sync: BackupSyncService
  set: SetState
}

export type FetchSyncStatus = Action<[]>

export const createFetchSyncStatus: ActionFactory<FetchSyncStatusDeps, FetchSyncStatus> = (deps) => (
  async () => {
    const { db, sync, set } = deps

    set((state) => {
      state.sync.pendingCount = sync.getPendingCount()
      state.sync.lastSyncTime = db.getLastSyncTime()
    })
  }
)
