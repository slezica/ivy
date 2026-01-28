import type { DatabaseService, FileStorageService, SyncQueueService } from '../services'
import type { SetState, GetState, Action, ActionFactory } from '../store/types'


export interface ArchiveBookDeps {
  db: DatabaseService
  files: FileStorageService
  syncQueue: SyncQueueService
  set: SetState
  get: GetState
}

export type ArchiveBook = Action<[string]>

export const createArchiveBook: ActionFactory<ArchiveBookDeps, ArchiveBook> = (deps) => (
  async (bookId) => {
    const { db, files, syncQueue, set, get } = deps

    const book = get().books[bookId]
    if (!book) throw new Error('Book not found')

    const previousUri = book.uri

    try {
      set(state => {
        state.books[bookId].uri = null
      })

      db.archiveBook(bookId)
      syncQueue.queueChange('book', bookId, 'upsert')

    } catch (error) {
      set(state => {
        state.books[bookId].uri = previousUri
      })
      throw error
    }

    // Delete file (fire and forget, can clean up later if this fails):
    if (previousUri) {
      files.deleteFile(previousUri).catch((error) => {
        console.error('Failed to delete archived book file (non-critical):', error)
      })
    }
  }
)
