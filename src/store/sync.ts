import type {
  DatabaseService,
  BackupSyncService,
  SyncStatus,
} from '../services'
import type { SyncSlice, SetState, GetState } from './types'


export interface SyncSliceDeps {
  db: DatabaseService
  sync: BackupSyncService
}


export function createSyncSlice(deps: SyncSliceDeps) {
  const { db, sync: syncService } = deps

  return (set: SetState, get: GetState): SyncSlice => {
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

    function syncNow(): void {
      syncService.syncNow()
    }

    async function autoSync(): Promise<void> {
      const { settings } = get()
      if (!settings.sync_enabled) return
      await syncService.autoSync()
    }

    function refreshSyncStatus(): void {
      set((state) => {
        state.sync.pendingCount = syncService.getPendingCount()
        state.sync.lastSyncTime = db.getLastSyncTime()
      })
    }
  }
}
