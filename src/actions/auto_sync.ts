import type { BackupSyncService } from '../services'
import type { GetState, Action, ActionFactory } from '../store/types'


export interface AutoSyncDeps {
  sync: BackupSyncService
  get: GetState
}

export type AutoSync = Action<[]>

export const createAutoSync: ActionFactory<AutoSyncDeps, AutoSync> = (deps) => (
  async () => {
    const { sync, get } = deps

    const { settings } = get()
    if (!settings.sync_enabled) return
    await sync.autoSync()
  }
)
