import type { DatabaseService, Settings } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'


export interface UpdateSettingsDeps {
  db: DatabaseService
  set: SetState
}

export type UpdateSettings = Action<[Settings]>

export const createUpdateSettings: ActionFactory<UpdateSettingsDeps, UpdateSettings> = (deps) => (
  async (settings) => {
    const { db, set } = deps

    db.setSettings(settings)
    set({ settings })
  }
)
