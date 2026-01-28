import type { DatabaseService, AudioPlayerService, SessionWithBook, PlaybackStatus } from '../services'
import type { SessionSlice, SetState, GetState } from './types'
import { MAIN_PLAYER_OWNER_ID, throttle } from '../utils'

const MIN_SESSION_DURATION_MS = 1000

export interface SessionSliceDeps {
  db: DatabaseService
  audio: AudioPlayerService
}

export function createSessionSlice(deps: SessionSliceDeps) {
  const { db, audio } = deps

  // Track which book has an active session being recorded
  let activeBookId: string | null = null

  return (set: SetState, get: GetState): SessionSlice => {
    const throttledTrackSession = throttle((bookId: string) => {
      trackSession(bookId)
    }, 5_000)

    audio.on('status', onPlaybackStatus)

    // Fetch sessions on initialization
    const initialSessions = db.getAllSessions()

    return {
      sessions: initialSessions,
      fetchSessions,
      trackSession,
    }

    function onPlaybackStatus(status: PlaybackStatus) {
      const { playback, books } = get()
      if (playback.ownerId !== MAIN_PLAYER_OWNER_ID) return

      const book = playback.uri
        ? Object.values(books).find(b => b.uri === playback.uri)
        : null

      if (status.status === 'playing') {
        if (!book || status.position < 0 || status.duration <= 0) return
        activeBookId = book.id
        throttledTrackSession(book.id)
      } else if (activeBookId) {
        // Playback stopped/paused - finalize the session
        finalizeSession(activeBookId)
        activeBookId = null
      }
    }

    function fetchSessions(): void {
      const sessions = db.getAllSessions()
      set({ sessions })
    }

    function finalizeSession(bookId: string): void {
      const now = Date.now()
      const current = db.getCurrentSession(bookId)
      if (!current) return

      const duration = now - current.started_at

      if (duration < MIN_SESSION_DURATION_MS) {
        // Delete zero/short-duration sessions
        db.deleteSession(current.id)
        set((state) => {
          const index = state.sessions.findIndex(s => s.id === current.id)
          if (index !== -1) {
            state.sessions.splice(index, 1)
          }
        })
      } else {
        // Update final ended_at timestamp
        db.updateSessionEndedAt(current.id, now)
        set((state) => {
          const session = state.sessions.find(s => s.id === current.id)
          if (session) {
            session.ended_at = now
          }
        })
      }
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
        if (!book) return

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
