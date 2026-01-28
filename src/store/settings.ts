import type { DatabaseService, Settings } from '../services'
import type { SettingsSlice, SetState, GetState, Action, ActionFactory } from './types'


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

export interface UpdateSettingsDeps {
  db: DatabaseService
  set: SetState
}

export type UpdateSettings = Action<[Settings]>

const createUpdateSettings: ActionFactory<UpdateSettingsDeps, UpdateSettings> = (deps) => (
  (settings) => {
    const { db, set } = deps

    db.setSettings(settings)
    set({ settings })
  }
)
