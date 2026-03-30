import type { DatabaseService } from '../services'
import type { SyncQueueService } from '../services/backup/queue'
import type { SetState, Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'
import { MIN_SESSION_DURATION_MS } from './constants'


export interface FinalizeSessionDeps {
  db: DatabaseService
  syncQueue: SyncQueueService
  set: SetState
}

export type FinalizeSession = Action<[string]>

export const createFinalizeSession: ActionFactory<FinalizeSessionDeps, FinalizeSession> = (deps) => (
  async (bookId) => {
    const { db, syncQueue, set } = deps
    const log = createLogger('FinalizeSession')

    const now = Date.now()
    const current = await db.getCurrentSession(bookId)
    if (!current) return

    const duration = now - current.started_at

    if (duration < MIN_SESSION_DURATION_MS) {
      log(`Discarding short session (${duration}ms)`)
      await db.deleteSession(current.id)
      syncQueue.queueChange('session', current.id, 'delete')
      set((state) => {
        delete state.sessions[current.id]
      })
    } else {
      // Update final ended_at timestamp
      db.updateSessionEndedAt(current.id, now)
      syncQueue.queueChange('session', current.id, 'upsert')
      set((state) => {
        const session = state.sessions[current.id]
        if (session) {
          session.ended_at = now
          session.updated_at = now
        }
      })
    }
  }
)
