import type { DatabaseService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'
import { MIN_SESSION_DURATION_MS } from './constants'


export interface FinalizeSessionDeps {
  db: DatabaseService
  set: SetState
}

export type FinalizeSession = Action<[string]>

export const createFinalizeSession: ActionFactory<FinalizeSessionDeps, FinalizeSession> = (deps) => (
  async (bookId) => {
    const { db, set } = deps
    const log = createLogger('FinalizeSession')

    const now = Date.now()
    const current = db.getCurrentSession(bookId)
    if (!current) return

    const duration = now - current.started_at

    if (duration < MIN_SESSION_DURATION_MS) {
      log(`Discarding short session (${duration}ms)`)
      db.deleteSession(current.id)
      set((state) => {
        delete state.sessions[current.id]
      })
    } else {
      // Update final ended_at timestamp
      db.updateSessionEndedAt(current.id, now)
      set((state) => {
        const session = state.sessions[current.id]
        if (session) {
          session.ended_at = now
        }
      })
    }
  }
)
