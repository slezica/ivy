import type { DatabaseService } from '../services'
import type { SessionSlice, SetState, GetState } from './types'


export interface SessionSliceDeps {
  db: DatabaseService
}

export function createSessionSlice(deps: SessionSliceDeps) {
  const { db } = deps

  return (set: SetState, get: GetState): SessionSlice => {
    return {
      trackSession,
    }

    function trackSession(bookId: string): void {
      const now = Date.now()
      const current = db.getCurrentSession(bookId)

      if (current) {
        db.updateSessionEndedAt(current.id, now)
      } else {
        db.createSession(bookId)
      }
    }
  }
}
