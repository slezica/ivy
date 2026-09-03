import type { DatabaseService, AudioSlicerService, NetworkService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'
import type { RunMigrations } from './run_migrations'
import type { FetchBooks } from './fetch_books'
import type { FetchClips } from './fetch_clips'
import type { FetchSessions } from './fetch_sessions'
import type { LoadBook } from './load_book'
import type { StartTranscription } from './start_transcription'
import type { SeedDemoData } from './seed_demo_data'
import { MAIN_PLAYER_OWNER_ID } from '../utils'


export interface InitializeApplicationDeps {
  db: DatabaseService
  slicer: AudioSlicerService
  network: NetworkService
  toast: (message: string) => void
  set: SetState
  runMigrations: RunMigrations
  fetchBooks: FetchBooks
  fetchClips: FetchClips
  fetchSessions: FetchSessions
  loadBook: LoadBook
  startTranscription: StartTranscription
  seedDemoData: SeedDemoData
}

export type InitializeApplication = Action<[]>

export const createInitializeApplication: ActionFactory<InitializeApplicationDeps, InitializeApplication> = (deps) => (
  async () => {
    const { db, slicer, network, toast, set, runMigrations, fetchBooks, fetchClips, fetchSessions, loadBook, startTranscription, seedDemoData } = deps

    try {
      // Migrate the database before anything reads or writes it. The store is
      // created with default state, so settings hydrate right after.
      await runMigrations()
      set((state) => {
        state.settings = db.getSettings()
        state.sync.lastSyncTime = db.getLastSyncTime()
      })

      // Begin watching connectivity (feeds the store's network listener)
      network.start()

      // Warm the FFmpeg runtime in the background (unpack + cold-link) so the
      // first clip slice / chapter read isn't slow. Fire-and-forget.
      slicer.warmUp().catch(() => {})

      // Replace all data with the demo fixture when a seed bundle is present
      // (Play Store screenshots — see `bin/ivy.ts prepare --screenshots`)
      await seedDemoData().catch((error) => {
        console.error('[Store] Demo seeding failed:', error)
      })

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
    } catch (error) {
      // Non-fatal: an empty library beats a permanent splash screen — but
      // never silent: the session runs un-hydrated (default settings, no
      // auto-load), and the user must know something went wrong
      console.error('[Store] Initialization failed:', error)
      toast('Ivy startup problem — some data may be unavailable')
    } finally {
      set((state) => { state.initialized = true })
    }
  }
)
