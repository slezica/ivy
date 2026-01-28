import type { DatabaseService, BackupSyncService, SyncStatus } from '../services'
import type { SyncSlice, SetState, GetState } from './types'
import { createSyncNow } from '../actions/sync_now'
import { createAutoSync } from '../actions/auto_sync'
import { createRefreshSyncStatus } from '../actions/refresh_sync_status'


export interface SyncSliceDeps {
  db: DatabaseService
  sync: BackupSyncService
}


export function createSyncSlice(deps: SyncSliceDeps) {
  const { db, sync: syncService } = deps

  return (set: SetState, get: GetState): SyncSlice => {
    const syncNow = createSyncNow({ sync: syncService })
    const autoSync = createAutoSync({ sync: syncService, get })
    const refreshSyncStatus = createRefreshSyncStatus({ db, sync: syncService, set })

    syncService.on('status', onSyncStatus)

    return {
      sync: {
        isSyncing: false,
        pendingCount: syncService.getPendingCount(),
        lastSyncTime: db.getLastSyncTime(),
        error: null,
      },

      syncNow,
      autoSync,
      refreshSyncStatus,
    }

    function onSyncStatus(status: SyncStatus) {
      set((state) => {
        state.sync = {
          ...status,
          lastSyncTime: status.isSyncing ? state.sync.lastSyncTime : db.getLastSyncTime(),
        }
      })
    }
  }
}
