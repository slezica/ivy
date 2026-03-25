import type { BackupSyncService } from '../services'
import type { Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'


export interface SyncNowDeps {
  sync: BackupSyncService
}

export type SyncNow = Action<[]>

export const createSyncNow: ActionFactory<SyncNowDeps, SyncNow> = (deps) => (
  async () => {
    const { sync } = deps
    const log = createLogger('SyncNow')

    log('Triggering manual sync')
    sync.syncNow()
  }
)
