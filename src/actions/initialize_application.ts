import type { DatabaseService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'
import type { FetchBooks } from './fetch_books'
import type { FetchClips } from './fetch_clips'
import type { FetchSessions } from './fetch_sessions'
import type { LoadBook } from './load_book'
import type { StartTranscription } from './start_transcription'
import { MAIN_PLAYER_OWNER_ID } from '../utils'


export interface InitializeApplicationDeps {
  db: DatabaseService
  set: SetState
  fetchBooks: FetchBooks
  fetchClips: FetchClips
  fetchSessions: FetchSessions
  loadBook: LoadBook
  startTranscription: StartTranscription
}

export type InitializeApplication = Action<[]>

export const createInitializeApplication: ActionFactory<InitializeApplicationDeps, InitializeApplication> = (deps) => (
  async () => {
    const { db, set, fetchBooks, fetchClips, fetchSessions, loadBook, startTranscription } = deps

    // Hydrate store with data
    await Promise.all([fetchBooks(), fetchClips(), fetchSessions()])

    // Auto-load last played book
    const lastPlayed = db.getLastPlayedBook()
    if (lastPlayed?.uri) {
      await loadBook({
        fileUri: lastPlayed.uri,
        position: lastPlayed.position,
        ownerId: MAIN_PLAYER_OWNER_ID,
      }).catch(() => {}) // non-critical
    }

    // Auto-start transcription if enabled
    const settings = db.getSettings()
    if (settings.transcription_enabled) {
      startTranscription().catch((error) => {
        console.error('[Store] Transcription failed to start after retries:', error)
      })
    }

    set((state) => { state.initialized = true })
  }
)
