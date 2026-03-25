import type { DatabaseService, SessionWithBook } from '../services'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'


export interface TrackSessionDeps {
  db: DatabaseService
  set: SetState
  get: GetState
}

export type TrackSession = Action<[string]>

export const createTrackSession: ActionFactory<TrackSessionDeps, TrackSession> = (deps) => (
  async (bookId) => {
    const { db, set, get } = deps
    const log = createLogger('TrackSession')

    const now = Date.now()
    const current = db.getCurrentSession(bookId)

    if (current) {
      db.updateSessionEndedAt(current.id, now)
      set((state) => {
        const session = state.sessions[current.id]
        if (session) {
          session.ended_at = now
        }
      })
    } else {
      const book = get().books[bookId]
      if (!book) return

      log(`New session for "${book.name}"`)

      const session = db.createSession(bookId)

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
