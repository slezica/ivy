import type { AudioPlayerService, DatabaseService, FileStorageService } from '../services'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'


export interface ArchiveBookDeps {
  audio: AudioPlayerService
  db: DatabaseService
  files: FileStorageService
  set: SetState
  get: GetState
}

export type ArchiveBook = Action<[string]>

export const createArchiveBook: ActionFactory<ArchiveBookDeps, ArchiveBook> = (deps) => (
  async (bookId) => {
    const { audio, db, files, set, get } = deps
    const log = createLogger('ArchiveBook')

    const book = get().books[bookId]
    if (!book) throw new Error('Book not found')

    log(`Archiving "${book.name}"`)

    const previousUri = book.uri

    // If this book is currently loaded in the player, unload it
    if (previousUri && get().playback.uri === previousUri) {
      log('Unloading from player')
      set(state => {
        state.playback.status = 'idle'
        state.playback.uri = null
        state.playback.ownerId = null
      })
      audio.unload().catch(() => {})
    }

    try {
      set(state => {
        state.books[bookId].uri = null
      })

      // Archiving is per-device — no sync queueing (see docs/SYNC.md)
      await db.archiveBook(bookId)

    } catch (error) {
      log('Failed, rolling back:', error)
      set(state => {
        state.books[bookId].uri = previousUri
      })
      throw error
    }

    // Delete file (fire and forget, can clean up later if this fails):
    if (previousUri) {
      files.deleteFile(previousUri).catch((error) => {
        log('File cleanup failed (non-critical):', error)
      })
    }
  }
)
