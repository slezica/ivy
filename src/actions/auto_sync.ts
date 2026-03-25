import type { BackupSyncService } from '../services'
import type { GetState, Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'


export interface AutoSyncDeps {
  sync: BackupSyncService
  get: GetState
}

export type AutoSync = Action<[]>

export const createAutoSync: ActionFactory<AutoSyncDeps, AutoSync> = (deps) => (
  async () => {
    const { sync, get } = deps
    const log = createLogger('AutoSync')

    const { settings } = get()
    if (!settings.sync_enabled) return

    log('Triggering auto-sync')
    await sync.autoSync()
  }
)
