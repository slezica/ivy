import type { DatabaseService } from '../services'
import type { SettingsSlice, SetState, GetState } from './types'
import { createUpdateSettings } from '../actions/update_settings'


export interface SettingsSliceDeps {
  db: DatabaseService
}

export function createSettingsSlice(deps: SettingsSliceDeps) {
  const { db } = deps

  return (set: SetState, get: GetState): SettingsSlice => {
    return {
      settings: db.getSettings(),
      updateSettings: createUpdateSettings({ db, set }),
    }
  }
}
