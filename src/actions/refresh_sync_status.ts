import type { DatabaseService, BackupSyncService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'


export interface RefreshSyncStatusDeps {
  db: DatabaseService
  sync: BackupSyncService
  set: SetState
}

export type RefreshSyncStatus = Action<[]>

export const createRefreshSyncStatus: ActionFactory<RefreshSyncStatusDeps, RefreshSyncStatus> = (deps) => (
  async () => {
    const { db, sync, set } = deps

    set((state) => {
      state.sync.pendingCount = sync.getPendingCount()
      state.sync.lastSyncTime = db.getLastSyncTime()
    })
  }
)
