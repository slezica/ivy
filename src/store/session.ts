import type { DatabaseService, SessionWithBook } from '../services'
import type { SessionSlice, SetState, GetState } from './types'


export interface SessionSliceDeps {
  db: DatabaseService
}

export function createSessionSlice(deps: SessionSliceDeps) {
  const { db } = deps

  return (set: SetState, get: GetState): SessionSlice => {
    return {
      sessions: [],
      fetchSessions,
      trackSession,
    }

    function fetchSessions(): void {
      const sessions = db.getAllSessions()
      set({ sessions })
    }

    function trackSession(bookId: string): void {
      const now = Date.now()
      const current = db.getCurrentSession(bookId)

      if (current) {
        db.updateSessionEndedAt(current.id, now)
        set((state) => {
          const session = state.sessions.find(s => s.id === current.id)
          if (session) {
            session.ended_at = now
          }
        })
      } else {
        const book = get().books[bookId]
        if (!book) { return }

        const session = db.createSession(bookId)

        const sessionWithBook: SessionWithBook = {
          ...session,
          book_name: book.name,
          book_title: book.title,
          book_artist: book.artist,
          book_artwork: book.artwork,
        }

        set((state) => {
          state.sessions.unshift(sessionWithBook)
        })
      }
    }
  }
}
