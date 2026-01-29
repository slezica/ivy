import { createArchiveBook, ArchiveBookDeps } from '../archive_book'
import {
  createMockBook, createMockState, createImmerSet, createMockGet,
  createMockDb, createMockFiles, createMockSyncQueue,
} from './helpers'


// -- Helpers ------------------------------------------------------------------

function createDeps(bookId: string, bookUri: string | null = 'file:///audio/book-1.mp3') {
  const book = createMockBook({ id: bookId, uri: bookUri })
  const state = createMockState({ books: { [bookId]: book } })

  const deps: ArchiveBookDeps = {
    db: createMockDb(),
    files: createMockFiles(),
    syncQueue: createMockSyncQueue(),
    set: createImmerSet(state),
    get: createMockGet(state),
  }

  return { state, deps }
}


// -- Tests --------------------------------------------------------------------

describe('createArchiveBook', () => {

  describe('happy path', () => {
    it('sets book uri to null (optimistic update)', async () => {
      const { state, deps } = createDeps('book-1')
      const archiveBook = createArchiveBook(deps)

      await archiveBook('book-1')

      expect(state.books['book-1'].uri).toBeNull()
    })

    it('calls db.archiveBook', async () => {
      const { deps } = createDeps('book-1')
      const archiveBook = createArchiveBook(deps)

      await archiveBook('book-1')

      expect(deps.db.archiveBook).toHaveBeenCalledWith('book-1')
    })

    it('queues sync upsert', async () => {
      const { deps } = createDeps('book-1')
      const archiveBook = createArchiveBook(deps)

      await archiveBook('book-1')

      expect(deps.syncQueue.queueChange).toHaveBeenCalledWith('book', 'book-1', 'upsert')
    })

    it('fire-and-forgets file deletion', async () => {
      const { deps } = createDeps('book-1')
      const archiveBook = createArchiveBook(deps)

      await archiveBook('book-1')

      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/book-1.mp3')
    })

    it('does not attempt file deletion if book had no uri', async () => {
      const { deps } = createDeps('book-1', null)
      const archiveBook = createArchiveBook(deps)

      await archiveBook('book-1')

      expect(deps.files.deleteFile).not.toHaveBeenCalled()
    })
  })

  describe('book not found', () => {
    it('throws if book does not exist in store', async () => {
      const state = createMockState({ books: {} })
      const deps: ArchiveBookDeps = {
        db: createMockDb(),
        files: createMockFiles(),
        syncQueue: createMockSyncQueue(),
        set: createImmerSet(state),
        get: createMockGet(state),
      }
      const archiveBook = createArchiveBook(deps)

      await expect(archiveBook('nonexistent')).rejects.toThrow('Book not found')
    })

    it('does not modify state or call db on missing book', async () => {
      const state = createMockState({ books: {} })
      const deps: ArchiveBookDeps = {
        db: createMockDb(),
        files: createMockFiles(),
        syncQueue: createMockSyncQueue(),
        set: createImmerSet(state),
        get: createMockGet(state),
      }
      const archiveBook = createArchiveBook(deps)

      await expect(archiveBook('nonexistent')).rejects.toThrow()

      expect(deps.db.archiveBook).not.toHaveBeenCalled()
      expect(deps.syncQueue.queueChange).not.toHaveBeenCalled()
    })
  })

  describe('rollback on db failure', () => {
    it('restores book uri on db error', async () => {
      const { state, deps } = createDeps('book-1', 'file:///audio/book-1.mp3')
      deps.db.archiveBook = jest.fn(() => { throw new Error('db failed') })
      const archiveBook = createArchiveBook(deps)

      await expect(archiveBook('book-1')).rejects.toThrow('db failed')

      expect(state.books['book-1'].uri).toBe('file:///audio/book-1.mp3')
    })

    it('restores book uri on sync queue error', async () => {
      const { state, deps } = createDeps('book-1', 'file:///audio/book-1.mp3')
      deps.syncQueue.queueChange = jest.fn(() => { throw new Error('queue failed') })
      const archiveBook = createArchiveBook(deps)

      await expect(archiveBook('book-1')).rejects.toThrow('queue failed')

      expect(state.books['book-1'].uri).toBe('file:///audio/book-1.mp3')
    })

    it('does not delete file on rollback', async () => {
      const { deps } = createDeps('book-1')
      deps.db.archiveBook = jest.fn(() => { throw new Error('db failed') })
      const archiveBook = createArchiveBook(deps)

      await expect(archiveBook('book-1')).rejects.toThrow()

      expect(deps.files.deleteFile).not.toHaveBeenCalled()
    })
  })

  describe('file deletion resilience', () => {
    it('does not throw if file deletion fails', async () => {
      const { deps } = createDeps('book-1')
      deps.files.deleteFile = jest.fn(async () => { throw new Error('delete failed') })
      const archiveBook = createArchiveBook(deps)

      // Should not throw — file deletion is fire-and-forget
      await expect(archiveBook('book-1')).resolves.not.toThrow()
    })

    it('still archives in db even if file deletion would fail', async () => {
      const { state, deps } = createDeps('book-1')
      deps.files.deleteFile = jest.fn(async () => { throw new Error('delete failed') })
      const archiveBook = createArchiveBook(deps)

      await archiveBook('book-1')

      expect(state.books['book-1'].uri).toBeNull()
      expect(deps.db.archiveBook).toHaveBeenCalledWith('book-1')
      expect(deps.syncQueue.queueChange).toHaveBeenCalledWith('book', 'book-1', 'upsert')
    })
  })
})
