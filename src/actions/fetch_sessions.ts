import type { DatabaseService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'


export interface FetchSessionsDeps {
  db: DatabaseService
  set: SetState
}

export type FetchSessions = Action<[]>

export const createFetchSessions: ActionFactory<FetchSessionsDeps, FetchSessions> = (deps) => (
  () => {
    const { db, set } = deps
    const sessions = db.getAllSessions()
    set({ sessions })
  }
)
