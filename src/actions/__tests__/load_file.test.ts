import { createLoadFile, LoadFileDeps } from '../load_file'
import {
  createMockBook, createMockState, createImmerSet,
  createMockDb, createMockFiles, createMockMetadata, createMockSyncQueue,
} from './helpers'

// Mock generateId to return predictable values
jest.mock('../../utils', () => ({
  generateId: () => 'generated-id-1',
}))


// -- Helpers ------------------------------------------------------------------

function createMockDeps(overrides: Partial<LoadFileDeps> = {}): LoadFileDeps {
  const state = createMockState()

  return {
    db: createMockDb({
      getBookByUri: jest.fn((uri: string) => {
        // By default, permanent URIs are "found" (simulates successful DB write)
        if (uri.includes('generated-id-1') || uri.includes('archived-1')) {
          return createMockBook({ uri })
        }
        return null
      }),
      upsertBook: jest.fn(() => createMockBook({ id: 'generated-id-1', uri: 'file:///audio/generated-id-1.mp3' })),
    }),
    files: createMockFiles(),
    metadata: createMockMetadata(),
    syncQueue: createMockSyncQueue(),
    set: createImmerSet(state),
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
      const state = createMockState()
      const deps = createMockDeps({ set: createImmerSet(state) })
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(state.library.status).toBe('idle')
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
        db: createMockDb({
          getBookByFingerprint: jest.fn(() => archivedBook),
          getBookByUri: jest.fn((uri: string) => {
            if (uri.includes('archived-1')) return createMockBook({ id: 'archived-1', uri })
            return null
          }),
          restoreBook: jest.fn(() => createMockBook({ id: 'archived-1' })),
        }),
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
        db: createMockDb({
          getBookByFingerprint: jest.fn(() => activeBook),
          getBookById: jest.fn(() => activeBook),
        }),
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
      const state = createMockState()
      const deps = createMockDeps({
        files: createMockFiles({
          copyToAppStorage: jest.fn(async () => { throw new Error('copy failed') }),
        }),
        set: createImmerSet(state),
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).rejects.toThrow('copy failed')

      expect(state.library.status).toBe('idle')
    })

    it('re-throws the original error', async () => {
      const deps = createMockDeps({
        metadata: createMockMetadata({
          readMetadata: jest.fn(async () => { throw new Error('metadata failed') }),
        }),
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).rejects.toThrow('metadata failed')
    })

    it('does not refresh books or clips on failure', async () => {
      const deps = createMockDeps({
        files: createMockFiles({
          copyToAppStorage: jest.fn(async () => { throw new Error('fail') }),
        }),
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).rejects.toThrow()

      expect(deps.fetchBooks).not.toHaveBeenCalled()
      expect(deps.fetchClips).not.toHaveBeenCalled()
    })

    it('does not queue sync on failure', async () => {
      const deps = createMockDeps({
        files: createMockFiles({
          copyToAppStorage: jest.fn(async () => { throw new Error('fail') }),
        }),
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
        db: createMockDb({
          getBookByFingerprint: jest.fn(() => activeBook),
          getBookById: jest.fn(() => activeBook),
        }),
      })
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/temp-abc.mp3')
    })

    it('cleans up temp file when metadata read fails', async () => {
      const deps = createMockDeps({
        metadata: createMockMetadata({
          readMetadata: jest.fn(async () => { throw new Error('metadata failed') }),
        }),
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).rejects.toThrow('metadata failed')

      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/temp-abc.mp3')
    })

    it('cleans up temp file when fingerprint read fails', async () => {
      const deps = createMockDeps({
        files: createMockFiles({
          readFileFingerprint: jest.fn(async () => { throw new Error('fingerprint failed') }),
        }),
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).rejects.toThrow('fingerprint failed')

      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/temp-abc.mp3')
    })

    it('cleans up renamed file when DB write fails (Case C)', async () => {
      const deps = createMockDeps({
        db: createMockDb({
          upsertBook: jest.fn(() => { throw new Error('db failed') }),
        }),
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).rejects.toThrow('db failed')

      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/temp-abc.mp3')
      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/generated-id-1.mp3')
    })

    it('cleans up renamed file when DB restore fails (Case A)', async () => {
      const archivedBook = createMockBook({ id: 'archived-1', uri: null })
      const deps = createMockDeps({
        db: createMockDb({
          getBookByFingerprint: jest.fn(() => archivedBook),
          restoreBook: jest.fn(() => { throw new Error('restore failed') }),
        }),
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).rejects.toThrow('restore failed')

      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/temp-abc.mp3')
      expect(deps.files.deleteFile).toHaveBeenCalledWith('file:///audio/archived-1.mp3')
    })

    it('does not throw if cleanup itself fails', async () => {
      const deps = createMockDeps({
        metadata: createMockMetadata({
          readMetadata: jest.fn(async () => { throw new Error('metadata failed') }),
        }),
        files: createMockFiles({
          deleteFile: jest.fn(async () => { throw new Error('delete also failed') }),
        }),
      })
      const loadFile = createLoadFile(deps)

      // Should throw the original error, not the cleanup error
      await expect(loadFile(INPUT)).rejects.toThrow('metadata failed')
    })

    it('does not attempt cleanup when copy itself fails', async () => {
      const deps = createMockDeps({
        files: createMockFiles({
          copyToAppStorage: jest.fn(async () => { throw new Error('copy failed') }),
        }),
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).rejects.toThrow('copy failed')

      // tempUri is null, so no cleanup attempted
      expect(deps.files.deleteFile).not.toHaveBeenCalled()
    })
  })
})
