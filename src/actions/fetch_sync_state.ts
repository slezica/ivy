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

    const pendingCount = await sync.getPendingCount()
    const failingCount = await sync.getFailingCount()
    set((state) => {
      state.sync.pendingCount = pendingCount
      state.sync.failingCount = failingCount
      state.sync.lastSyncTime = db.getLastSyncTime()
    })
  }
)
