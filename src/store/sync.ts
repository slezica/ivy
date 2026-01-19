/**
 * Sync Slice
 *
 * State and actions for cloud backup synchronization.
 */

import type {
  DatabaseService,
  BackupSyncService,
} from '../services'
import type { SyncSlice, SetState, GetState } from './types'

// =============================================================================
// Types
// =============================================================================

/** Dependencies required by this slice */
export interface SyncSliceDeps {
  db: DatabaseService
  sync: BackupSyncService
}

// =============================================================================
// Slice Creator
// =============================================================================

export function createSyncSlice(deps: SyncSliceDeps) {
  const { db, sync: syncService } = deps

  return (set: SetState, get: GetState): SyncSlice => {
    // -----------------------------------------------------------------
    // Actions
    // -----------------------------------------------------------------

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

    // -----------------------------------------------------------------
    // Return slice
    // -----------------------------------------------------------------

    return {
      // Initial state
      sync: {
        isSyncing: false,
        pendingCount: syncService.getPendingCount(),
        lastSyncTime: db.getLastSyncTime(),
        error: null,
      },

      // Actions
      syncNow,
      autoSync,
      refreshSyncStatus,
    }
  }
}
