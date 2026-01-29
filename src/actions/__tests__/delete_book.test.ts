import { createDeleteBook, DeleteBookDeps } from '../delete_book'
import {
  createMockBook, createMockState, createImmerSet, createMockGet,
  createMockDb, createMockFiles, createMockSyncQueue,
} from './helpers'


// -- Helpers ------------------------------------------------------------------

function createDeps(bookId: string, bookUri: string | null = 'file:///audio/book-1.mp3') {
  const book = createMockBook({ id: bookId, uri: bookUri })
  const state = createMockState({ books: { [bookId]: book } })

  const deps: DeleteBookDeps = {
    db: createMockDb(),
    files: createMockFiles(),
    syncQueue: createMockSyncQueue(),
    set: createImmerSet(state),
    get: createMockGet(state),
  }

  return { state, deps, book }
}


// -- Tests --------------------------------------------------------------------

describe('createDeleteBook', () => {

  describe('happy path', () => {
    it('removes book from state (optimistic update)', async () => {
      const { state, deps } = createDeps('book-1')
      const deleteBook = createDeleteBook(deps)

      await deleteBook('book-1')

      expect(state.books['book-1']).toBeUndefined()
    })

    it('calls db.hideBook', async () => {
      const { deps } = createDeps('book-1')
      const deleteBook = createDeleteBook(deps)

      await deleteBook('book-1')

      expect(deps.db.hideBook).toHaveBeenCalledWith('book-1')
    })

    it('queues sync upsert', async () => {
      const { deps } = createDeps('book-1')
      const deleteBook = createDeleteBook(deps)

      await deleteBook('book-1')

      expect(deps.syncQueue.queueChange).toHaveBeenCalledWith('book', 'book-1', 'upsert')
    })

    it('fire-and-forgets file deletion', async () => {
      const { deps } = createDeps('book-1')
      const deleteBook = createDeleteBook(deps)

      await deleteBook('book-1')

      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/book-1.mp3')
    })

    it('does not attempt file deletion if book had no uri', async () => {
      const { deps } = createDeps('book-1', null)
      const deleteBook = createDeleteBook(deps)

      await deleteBook('book-1')

      expect(deps.files.deleteFile).not.toHaveBeenCalled()
    })
  })

  describe('book not found', () => {
    it('throws if book does not exist in store', async () => {
      const state = createMockState({ books: {} })
      const deps: DeleteBookDeps = {
        db: createMockDb(),
        files: createMockFiles(),
        syncQueue: createMockSyncQueue(),
        set: createImmerSet(state),
        get: createMockGet(state),
      }
      const deleteBook = createDeleteBook(deps)

      await expect(deleteBook('nonexistent')).rejects.toThrow('Book not found')
    })

    it('does not modify state or call db on missing book', async () => {
      const state = createMockState({ books: {} })
      const deps: DeleteBookDeps = {
        db: createMockDb(),
        files: createMockFiles(),
        syncQueue: createMockSyncQueue(),
        set: createImmerSet(state),
        get: createMockGet(state),
      }
      const deleteBook = createDeleteBook(deps)

      await expect(deleteBook('nonexistent')).rejects.toThrow()

      expect(deps.db.hideBook).not.toHaveBeenCalled()
      expect(deps.syncQueue.queueChange).not.toHaveBeenCalled()
    })
  })

  describe('rollback on failure', () => {
    it('restores book in state on db error', async () => {
      const { state, deps, book } = createDeps('book-1')
      deps.db.hideBook = jest.fn(() => { throw new Error('db failed') })
      const deleteBook = createDeleteBook(deps)

      await expect(deleteBook('book-1')).rejects.toThrow('db failed')

      expect(state.books['book-1']).toBeDefined()
      expect(state.books['book-1'].uri).toBe(book.uri)
    })

    it('restores book in state on sync queue error', async () => {
      const { state, deps, book } = createDeps('book-1')
      deps.syncQueue.queueChange = jest.fn(() => { throw new Error('queue failed') })
      const deleteBook = createDeleteBook(deps)

      await expect(deleteBook('book-1')).rejects.toThrow('queue failed')

      expect(state.books['book-1']).toBeDefined()
      expect(state.books['book-1'].id).toBe(book.id)
    })

    it('does not delete file on rollback', async () => {
      const { deps } = createDeps('book-1')
      deps.db.hideBook = jest.fn(() => { throw new Error('db failed') })
      const deleteBook = createDeleteBook(deps)

      await expect(deleteBook('book-1')).rejects.toThrow()

      expect(deps.files.deleteFile).not.toHaveBeenCalled()
    })
  })

  describe('file deletion resilience', () => {
    it('does not throw if file deletion fails', async () => {
      const { deps } = createDeps('book-1')
      deps.files.deleteFile = jest.fn(async () => { throw new Error('delete failed') })
      const deleteBook = createDeleteBook(deps)

      await expect(deleteBook('book-1')).resolves.not.toThrow()
    })

    it('still deletes in db even if file deletion would fail', async () => {
      const { state, deps } = createDeps('book-1')
      deps.files.deleteFile = jest.fn(async () => { throw new Error('delete failed') })
      const deleteBook = createDeleteBook(deps)

      await deleteBook('book-1')

      expect(state.books['book-1']).toBeUndefined()
      expect(deps.db.hideBook).toHaveBeenCalledWith('book-1')
      expect(deps.syncQueue.queueChange).toHaveBeenCalledWith('book', 'book-1', 'upsert')
    })
  })
})
