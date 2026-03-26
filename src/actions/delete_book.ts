import type { AudioPlayerService, DatabaseService, FileStorageService, SyncQueueService } from '../services'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'


export interface DeleteBookDeps {
  audio: AudioPlayerService
  db: DatabaseService
  files: FileStorageService
  syncQueue: SyncQueueService
  set: SetState
  get: GetState
}

export type DeleteBook = Action<[string]>

export const createDeleteBook: ActionFactory<DeleteBookDeps, DeleteBook> = (deps) => (
  async (bookId) => {
    const { audio, db, files, syncQueue, set, get } = deps
    const log = createLogger('DeleteBook')

    const book = get().books[bookId]
    if (!book) throw new Error('Book not found')

    log(`Deleting "${book.name}"`)

    const previousBook = { ...book }

    // If this book is currently loaded in the player, unload it
    if (book.uri && get().playback.uri === book.uri) {
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
        delete state.books[bookId]
      })

      await db.hideBook(bookId)
      syncQueue.queueChange('book', bookId, 'upsert')

    } catch (error) {
      log('Failed, rolling back:', error)
      set((state) => {
        state.books[bookId] = previousBook
      })
      throw error
    }

    // Delete file (fire and forget, can clean up later if this fails):
    if (previousBook.uri) {
      files.deleteFile(previousBook.uri).catch((error) => {
        log('File cleanup failed (non-critical):', error)
      })
    }
  }
)
