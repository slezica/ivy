import type { BackupSyncService } from '../services'
import type { Action, ActionFactory } from '../store/types'


export interface SyncNowDeps {
  sync: BackupSyncService
}

export type SyncNow = Action<[]>

export const createSyncNow: ActionFactory<SyncNowDeps, SyncNow> = (deps) => (
  async () => {
    deps.sync.syncNow()
  }
)
