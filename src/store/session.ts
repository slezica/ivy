import type { DatabaseService, AudioPlayerService, PlaybackStatus } from '../services'
import type { SessionSlice, SetState, GetState } from './types'
import { MAIN_PLAYER_OWNER_ID, throttle } from '../utils'
import { createFetchSessions } from '../actions/fetch_sessions'
import { createTrackSession } from '../actions/track_session'
import { createFinalizeSession } from '../actions/finalize_session'


export interface SessionSliceDeps {
  db: DatabaseService
  audio: AudioPlayerService
}

export function createSessionSlice(deps: SessionSliceDeps) {
  const { db, audio } = deps

  return (set: SetState, get: GetState): SessionSlice => {
    const fetchSessions = createFetchSessions({ db, set })
    const trackSession = createTrackSession({ db, set, get })
    const finalizeSession = createFinalizeSession({ db, set })

    const throttledTrackSession = throttle((bookId: string) => {
      trackSession(bookId)
    }, 5_000)

    audio.on('status', onPlaybackStatus)

    const initialSessions = db.getAllSessions()

    return {
      sessions: initialSessions,
      currentSessionBookId: null,
      fetchSessions,
      trackSession,
    }

    function onPlaybackStatus(status: PlaybackStatus) {
      const { playback, books, currentSessionBookId } = get()
      if (playback.ownerId !== MAIN_PLAYER_OWNER_ID) return

      const book = playback.uri
        ? Object.values(books).find(b => b.uri === playback.uri)
        : null

      if (status.status === 'playing') {
        if (!book || status.position < 0 || status.duration <= 0) return
        set((state) => { state.currentSessionBookId = book.id })
        throttledTrackSession(book.id)
      } else if (currentSessionBookId) {
        finalizeSession(currentSessionBookId)
        set((state) => { state.currentSessionBookId = null })
      }
    }
  }
}
