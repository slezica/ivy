import type { DatabaseService, SessionWithBook } from '../services'
import type { SyncQueueService } from '../services/backup/queue'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'


export interface TrackSessionDeps {
  db: DatabaseService
  syncQueue: SyncQueueService
  set: SetState
  get: GetState
}

export type TrackSession = Action<[string]>

export const createTrackSession: ActionFactory<TrackSessionDeps, TrackSession> = (deps) => (
  async (bookId) => {
    const { db, syncQueue, set, get } = deps
    const log = createLogger('TrackSession')

    const now = Date.now()
    const current = await db.getCurrentSession(bookId)

    if (current) {
      db.updateSessionEndedAt(current.id, now)
      syncQueue.queueChange('session', current.id, 'upsert')
      set((state) => {
        const session = state.sessions[current.id]
        if (session) {
          session.ended_at = now
          session.updated_at = now
        }
      })
    } else {
      const book = get().books[bookId]
      if (!book) return

      log(`New session for "${book.name}"`)

      const session = await db.createSession(bookId)

      const sessionWithBook: SessionWithBook = {
        ...session,
        book_name: book.name,
        book_title: book.title,
        book_artist: book.artist,
        book_artwork: book.artwork,
      }

      set((state) => {
        state.sessions[session.id] = sessionWithBook
      })
    }
  }
)
