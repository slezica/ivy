import type { DatabaseService, SessionWithBook } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'


export interface FetchSessionsDeps {
  db: DatabaseService
  set: SetState
}

export type FetchSessions = Action<[]>

export const createFetchSessions: ActionFactory<FetchSessionsDeps, FetchSessions> = (deps) => (
  async () => {
    const { db, set } = deps

    const sessions: Record<string, SessionWithBook> = {}
    for (const session of db.getAllSessions()) {
      sessions[session.id] = session
    }

    set({ sessions })
  }
)
