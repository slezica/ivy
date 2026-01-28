import { createLoadFile, LoadFileDeps } from '../load_file'
import type { Book } from '../../services'

// Mock generateId to return predictable values
jest.mock('../../utils', () => ({
  generateId: () => 'generated-id-1',
}))


// -- Helpers ------------------------------------------------------------------

function createMockBook(overrides: Partial<Book> = {}): Book {
  return {
    id: 'book-1',
    uri: 'file:///audio/book-1.mp3',
    name: 'Test Book.mp3',
    duration: 60000,
    position: 5000,
    updated_at: 1000,
    title: 'Test Title',
    artist: 'Test Artist',
    artwork: 'data:image/png;base64,abc',
    file_size: 1024,
    fingerprint: new Uint8Array([1, 2, 3]),
    hidden: false,
    ...overrides,
  }
}

function createMockDeps(overrides: Partial<LoadFileDeps> = {}): LoadFileDeps {
  return {
    db: {
      getBookByFingerprint: jest.fn(() => null),
      getBookByUri: jest.fn((uri: string) => {
        // By default, permanent URIs are "found" (simulates successful DB write)
        if (uri.includes('generated-id-1') || uri.includes('archived-1')) {
          return createMockBook({ uri })
        }
        return null
      }),
      upsertBook: jest.fn(() => createMockBook({ id: 'generated-id-1', uri: 'file:///audio/generated-id-1.mp3' })),
      restoreBook: jest.fn(() => createMockBook()),
      touchBook: jest.fn(),
      getBookById: jest.fn(() => createMockBook()),
    } as any,
    files: {
      copyToAppStorage: jest.fn(async () => 'file:///audio/temp-abc.mp3'),
      readFileFingerprint: jest.fn(async () => ({ fileSize: 1024, fingerprint: new Uint8Array([1, 2, 3]) })),
      rename: jest.fn(async (_uri: string, newName: string) => `file:///audio/${newName}.mp3`),
      deleteFile: jest.fn(async () => {}),
    } as any,
    metadata: {
      readMetadata: jest.fn(async () => ({
        title: 'Test Title',
        artist: 'Test Artist',
        artwork: 'data:image/png;base64,abc',
        duration: 60000,
      })),
    } as any,
    syncQueue: {
      queueChange: jest.fn(),
    } as any,
    set: jest.fn(),
    fetchBooks: jest.fn(async () => {}),
    fetchClips: jest.fn(async () => {}),
    ...overrides,
  }
}

const INPUT = { uri: 'content://external/test.mp3', name: 'Test Book.mp3' }


// -- Tests --------------------------------------------------------------------

describe('createLoadFile', () => {

  // -- Common pipeline steps ------------------------------------------------

  describe('pipeline', () => {
    it('sets library status to adding, then back to idle', async () => {
      const deps = createMockDeps()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      // First call: adding
      expect(deps.set).toHaveBeenCalledWith({ library: { status: 'adding' } })

      // Last call: idle (via immer-style updater)
      const lastCall = (deps.set as jest.Mock).mock.calls.at(-1)![0]
      expect(typeof lastCall).toBe('function')

      const draft = { library: { status: 'adding' as string } }
      lastCall(draft)
      expect(draft.library.status).toBe('idle')
    })

    it('copies file to app storage from external URI', async () => {
      const deps = createMockDeps()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.files.copyToAppStorage).toHaveBeenCalledWith(INPUT.uri, INPUT.name)
    })

    it('reads metadata from the local copy', async () => {
      const deps = createMockDeps()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.metadata.readMetadata).toHaveBeenCalledWith('file:///audio/temp-abc.mp3')
    })

    it('reads fingerprint from the local copy', async () => {
      const deps = createMockDeps()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.files.readFileFingerprint).toHaveBeenCalledWith('file:///audio/temp-abc.mp3')
    })

    it('checks for existing book by fingerprint', async () => {
      const deps = createMockDeps()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.db.getBookByFingerprint).toHaveBeenCalledWith(1024, new Uint8Array([1, 2, 3]))
    })

    it('refreshes books and clips after completion', async () => {
      const deps = createMockDeps()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.fetchBooks).toHaveBeenCalled()
      expect(deps.fetchClips).toHaveBeenCalled()
    })
  })

  // -- Case C: New book (no fingerprint match) --------------------------------

  describe('new book (no fingerprint match)', () => {
    it('renames temp file using generated ID', async () => {
      const deps = createMockDeps()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.files.rename).toHaveBeenCalledWith('file:///audio/temp-abc.mp3', 'generated-id-1')
    })

    it('creates book record with correct fields', async () => {
      const deps = createMockDeps()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.db.upsertBook).toHaveBeenCalledWith(
        'generated-id-1',                    // id
        'file:///audio/generated-id-1.mp3',   // uri (from rename)
        'Test Book.mp3',                      // name
        60000,                                // duration
        0,                                    // position (new book starts at 0)
        'Test Title',                         // title
        'Test Artist',                        // artist
        'data:image/png;base64,abc',          // artwork
        1024,                                 // fileSize
        new Uint8Array([1, 2, 3]),            // fingerprint
      )
    })

    it('queues sync upsert for the new book', async () => {
      const deps = createMockDeps()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.syncQueue.queueChange).toHaveBeenCalledWith('book', 'generated-id-1', 'upsert')
    })
  })

  // -- Case A: Archived book (fingerprint match, uri is null) -----------------

  describe('archived book restore (fingerprint match, uri null)', () => {
    function depsWithArchivedBook() {
      const archivedBook = createMockBook({ id: 'archived-1', uri: null })
      return createMockDeps({
        db: {
          getBookByFingerprint: jest.fn(() => archivedBook),
          getBookByUri: jest.fn((uri: string) => {
            if (uri.includes('archived-1')) return createMockBook({ id: 'archived-1', uri })
            return null
          }),
          restoreBook: jest.fn(() => createMockBook({ id: 'archived-1' })),
          touchBook: jest.fn(),
          getBookById: jest.fn(),
          upsertBook: jest.fn(),
        } as any,
      })
    }

    it('renames temp file using existing book ID', async () => {
      const deps = depsWithArchivedBook()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.files.rename).toHaveBeenCalledWith('file:///audio/temp-abc.mp3', 'archived-1')
    })

    it('restores the book with new metadata', async () => {
      const deps = depsWithArchivedBook()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.db.restoreBook).toHaveBeenCalledWith(
        'archived-1',
        'file:///audio/archived-1.mp3',
        'Test Book.mp3',
        60000,
        'Test Title',
        'Test Artist',
        'data:image/png;base64,abc',
      )
    })

    it('queues sync upsert for the restored book', async () => {
      const deps = depsWithArchivedBook()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.syncQueue.queueChange).toHaveBeenCalledWith('book', 'archived-1', 'upsert')
    })

    it('does not create a new book or touch existing', async () => {
      const deps = depsWithArchivedBook()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.db.upsertBook).not.toHaveBeenCalled()
      expect(deps.db.touchBook).not.toHaveBeenCalled()
    })
  })

  // -- Case B: Active duplicate (fingerprint match, uri is set) ---------------

  describe('active duplicate (fingerprint match, uri set)', () => {
    function depsWithActiveBook() {
      const activeBook = createMockBook({ id: 'active-1', uri: 'file:///audio/active-1.mp3' })
      return createMockDeps({
        db: {
          getBookByFingerprint: jest.fn(() => activeBook),
          getBookByUri: jest.fn(() => null), // no permanent URI in this case
          restoreBook: jest.fn(),
          touchBook: jest.fn(),
          getBookById: jest.fn(() => activeBook),
          upsertBook: jest.fn(),
        } as any,
      })
    }

    it('touches the existing book to update timestamp', async () => {
      const deps = depsWithActiveBook()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.db.touchBook).toHaveBeenCalledWith('active-1')
    })

    it('queues sync upsert for the existing book', async () => {
      const deps = depsWithActiveBook()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.syncQueue.queueChange).toHaveBeenCalledWith('book', 'active-1', 'upsert')
    })

    it('does not rename, restore, or create', async () => {
      const deps = depsWithActiveBook()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.files.rename).not.toHaveBeenCalled()
      expect(deps.db.restoreBook).not.toHaveBeenCalled()
      expect(deps.db.upsertBook).not.toHaveBeenCalled()
    })
  })

  // -- Error handling ---------------------------------------------------------

  describe('error handling', () => {
    it('resets library status to idle on failure', async () => {
      const deps = createMockDeps({
        files: {
          copyToAppStorage: jest.fn(async () => { throw new Error('copy failed') }),
          readFileFingerprint: jest.fn(),
          rename: jest.fn(),
          deleteFile: jest.fn(),
        } as any,
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).rejects.toThrow('copy failed')

      // Should still reset status via updater
      const setMock = deps.set as jest.Mock
      const lastCall = setMock.mock.calls.at(-1)![0]
      const draft = { library: { status: 'adding' as string } }
      lastCall(draft)
      expect(draft.library.status).toBe('idle')
    })

    it('re-throws the original error', async () => {
      const deps = createMockDeps({
        metadata: {
          readMetadata: jest.fn(async () => { throw new Error('metadata failed') }),
        } as any,
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).rejects.toThrow('metadata failed')
    })

    it('does not refresh books or clips on failure', async () => {
      const deps = createMockDeps({
        files: {
          copyToAppStorage: jest.fn(async () => { throw new Error('fail') }),
          readFileFingerprint: jest.fn(),
          rename: jest.fn(),
          deleteFile: jest.fn(),
        } as any,
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).rejects.toThrow()

      expect(deps.fetchBooks).not.toHaveBeenCalled()
      expect(deps.fetchClips).not.toHaveBeenCalled()
    })

    it('does not queue sync on failure', async () => {
      const deps = createMockDeps({
        files: {
          copyToAppStorage: jest.fn(async () => { throw new Error('fail') }),
          readFileFingerprint: jest.fn(),
          rename: jest.fn(),
          deleteFile: jest.fn(),
        } as any,
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).rejects.toThrow()

      expect(deps.syncQueue.queueChange).not.toHaveBeenCalled()
    })
  })

  // -- File cleanup (finally block) -------------------------------------------

  describe('file cleanup', () => {
    it('attempts to delete temp file on success (no-op after rename)', async () => {
      const deps = createMockDeps()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/temp-abc.mp3')
    })

    it('does not delete permanent file when DB record exists', async () => {
      const deps = createMockDeps()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      // Should only be called once (for temp), not for permanent
      expect(deps.files.deleteFile).toHaveBeenCalledTimes(1)
      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/temp-abc.mp3')
    })

    it('deletes temp file when duplicate is detected (Case B)', async () => {
      const activeBook = createMockBook({ id: 'active-1', uri: 'file:///audio/active-1.mp3' })
      const deps = createMockDeps({
        db: {
          getBookByFingerprint: jest.fn(() => activeBook),
          getBookByUri: jest.fn(() => null),
          restoreBook: jest.fn(),
          touchBook: jest.fn(),
          getBookById: jest.fn(() => activeBook),
          upsertBook: jest.fn(),
        } as any,
      })
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      // Only temp file deleted (no permanent URI in Case B)
      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/temp-abc.mp3')
    })

    it('cleans up temp file when metadata read fails', async () => {
      const deps = createMockDeps({
        metadata: {
          readMetadata: jest.fn(async () => { throw new Error('metadata failed') }),
        } as any,
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).rejects.toThrow('metadata failed')

      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/temp-abc.mp3')
    })

    it('cleans up temp file when fingerprint read fails', async () => {
      const deps = createMockDeps({
        files: {
          copyToAppStorage: jest.fn(async () => 'file:///audio/temp-abc.mp3'),
          readFileFingerprint: jest.fn(async () => { throw new Error('fingerprint failed') }),
          rename: jest.fn(async () => ''),
          deleteFile: jest.fn(async () => {}),
        } as any,
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).rejects.toThrow('fingerprint failed')

      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/temp-abc.mp3')
    })

    it('cleans up renamed file when DB write fails (Case C)', async () => {
      const deps = createMockDeps({
        db: {
          getBookByFingerprint: jest.fn(() => null),
          getBookByUri: jest.fn(() => null), // DB write failed, no record
          upsertBook: jest.fn(() => { throw new Error('db failed') }),
          restoreBook: jest.fn(),
          touchBook: jest.fn(),
          getBookById: jest.fn(),
        } as any,
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).rejects.toThrow('db failed')

      // Both temp and permanent should be cleaned up
      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/temp-abc.mp3')
      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/generated-id-1.mp3')
    })

    it('cleans up renamed file when DB restore fails (Case A)', async () => {
      const archivedBook = createMockBook({ id: 'archived-1', uri: null })
      const deps = createMockDeps({
        db: {
          getBookByFingerprint: jest.fn(() => archivedBook),
          getBookByUri: jest.fn(() => null), // restore failed, no record with this URI
          restoreBook: jest.fn(() => { throw new Error('restore failed') }),
          touchBook: jest.fn(),
          getBookById: jest.fn(),
          upsertBook: jest.fn(),
        } as any,
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).rejects.toThrow('restore failed')

      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/temp-abc.mp3')
      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/archived-1.mp3')
    })

    it('does not throw if cleanup itself fails', async () => {
      const deps = createMockDeps({
        metadata: {
          readMetadata: jest.fn(async () => { throw new Error('metadata failed') }),
        } as any,
        files: {
          copyToAppStorage: jest.fn(async () => 'file:///audio/temp-abc.mp3'),
          readFileFingerprint: jest.fn(),
          rename: jest.fn(),
          deleteFile: jest.fn(async () => { throw new Error('delete also failed') }),
        } as any,
      })
      const loadFile = createLoadFile(deps)

      // Should throw the original error, not the cleanup error
      await expect(loadFile(INPUT)).rejects.toThrow('metadata failed')
    })

    it('does not attempt cleanup when copy itself fails', async () => {
      const deps = createMockDeps({
        files: {
          copyToAppStorage: jest.fn(async () => { throw new Error('copy failed') }),
          readFileFingerprint: jest.fn(),
          rename: jest.fn(),
          deleteFile: jest.fn(),
        } as any,
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).rejects.toThrow('copy failed')

      // tempUri is null, so no cleanup attempted
      expect(deps.files.deleteFile).not.toHaveBeenCalled()
    })
  })
})
