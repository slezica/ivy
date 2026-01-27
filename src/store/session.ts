import type { DatabaseService, AudioPlayerService, SessionWithBook, PlaybackStatus } from '../services'
import type { SessionSlice, SetState, GetState } from './types'
import { MAIN_PLAYER_OWNER_ID, throttle } from '../utils'


export interface SessionSliceDeps {
  db: DatabaseService
  audio: AudioPlayerService
}

export function createSessionSlice(deps: SessionSliceDeps) {
  const { db, audio } = deps

  return (set: SetState, get: GetState): SessionSlice => {
    const throttledTrackSession = throttle((bookId: string) => {
      trackSession(bookId)
    }, 5_000)

    audio.on('status', onPlaybackStatus)

    return {
      sessions: [],
      fetchSessions,
      trackSession,
    }

    function onPlaybackStatus(status: PlaybackStatus) {
      if (status.status !== 'playing') return

      const { playback, books } = get()
      if (!playback.uri || status.position < 0 || status.duration <= 0) return
      if (playback.ownerId !== MAIN_PLAYER_OWNER_ID) return

      const book = Object.values(books).find(b => b.uri === playback.uri)
      if (!book) return

      throttledTrackSession(book.id)
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
