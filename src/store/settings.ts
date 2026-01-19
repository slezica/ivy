import type { DatabaseService, Settings } from '../services'
import type { SettingsSlice, SetState, GetState } from './types'


export interface SettingsSliceDeps {
  db: DatabaseService
}

export function createSettingsSlice(deps: SettingsSliceDeps) {
  const { db } = deps

  return (set: SetState, get: GetState): SettingsSlice => {
    return {
      settings: db.getSettings(),
      updateSettings,
    }

    function updateSettings(settings: Settings): void {
      db.setSettings(settings)
      set({ settings })
    }
  }
}
