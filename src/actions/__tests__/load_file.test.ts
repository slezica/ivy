import { createLoadFile, LoadFileDeps } from '../load_file'
import {
  createMockBook, createMockState, createImmerSet, createMockGet,
  createMockDb, createMockFiles, createMockMetadata, createMockSyncQueue, createMockCopier,
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
        if (uri.includes('generated-id-1') || uri.includes('archived-1')) {
          return createMockBook({ uri })
        }
        return null
      }),
      upsertBook: jest.fn(() => createMockBook({ id: 'generated-id-1', uri: 'file:///audio/generated-id-1.mp3' })),
    }),
    files: createMockFiles(),
    copier: createMockCopier(),
    metadata: createMockMetadata(),
    syncQueue: createMockSyncQueue(),
    set: createImmerSet(state),
    get: createMockGet(state),
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
      const deps = createMockDeps({ set: createImmerSet(state), get: createMockGet(state) })
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(state.library.status).toBe('idle')
    })

    it('begins copy from the source URI', async () => {
      const deps = createMockDeps()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.copier.beginCopy).toHaveBeenCalledWith('op-1', INPUT.uri)
    })

    it('checks for existing book by fingerprint from beginCopy', async () => {
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
    it('commits copy with book ID as filename', async () => {
      const deps = createMockDeps()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.copier.commitCopy).toHaveBeenCalledWith(
        'op-1',
        expect.stringContaining('generated-id-1'),
        expect.any(Function),
      )
    })

    it('reads metadata from the copied file', async () => {
      const deps = createMockDeps()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.metadata.readMetadata).toHaveBeenCalledWith(
        expect.stringContaining('generated-id-1'),
      )
    })

    it('creates book record with correct fields', async () => {
      const deps = createMockDeps()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.db.upsertBook).toHaveBeenCalledWith(
        'generated-id-1',
        expect.stringContaining('generated-id-1'),
        'Test Book.mp3',
        60000,
        0,
        'Test Title',
        'Test Artist',
        'data:image/png;base64,abc',
        1024,
        new Uint8Array([1, 2, 3]),
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

    it('commits copy with existing book ID as filename', async () => {
      const deps = depsWithArchivedBook()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.copier.commitCopy).toHaveBeenCalledWith(
        'op-1',
        expect.stringContaining('archived-1'),
        expect.any(Function),
      )
    })

    it('restores the book with new metadata', async () => {
      const deps = depsWithArchivedBook()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.db.restoreBook).toHaveBeenCalledWith(
        'archived-1',
        expect.stringContaining('archived-1'),
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

    it('cancels the copy without writing a file', async () => {
      const deps = depsWithActiveBook()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.copier.cancelCopy).toHaveBeenCalledWith('op-1')
      expect(deps.copier.commitCopy).not.toHaveBeenCalled()
    })

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

    it('does not restore or create', async () => {
      const deps = depsWithActiveBook()
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.db.restoreBook).not.toHaveBeenCalled()
      expect(deps.db.upsertBook).not.toHaveBeenCalled()
    })
  })

  // -- Error handling ---------------------------------------------------------

  describe('error handling', () => {
    it('sets library status to error on failure', async () => {
      const state = createMockState()
      const deps = createMockDeps({
        copier: createMockCopier({
          beginCopy: jest.fn(async () => { throw new Error('open failed') }),
        }),
        set: createImmerSet(state),
        get: createMockGet(state),
      })
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(state.library.status).toBe('error')
    })

    it('does not throw — error is surfaced in UI', async () => {
      const deps = createMockDeps({
        metadata: createMockMetadata({
          readMetadata: jest.fn(async () => { throw new Error('metadata failed') }),
        }),
      })
      const loadFile = createLoadFile(deps)

      await expect(loadFile(INPUT)).resolves.toBeUndefined()
    })

    it('does not refresh books or clips on failure', async () => {
      const deps = createMockDeps({
        copier: createMockCopier({
          beginCopy: jest.fn(async () => { throw new Error('fail') }),
        }),
      })
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.fetchBooks).not.toHaveBeenCalled()
      expect(deps.fetchClips).not.toHaveBeenCalled()
    })

    it('does not queue sync on failure', async () => {
      const deps = createMockDeps({
        copier: createMockCopier({
          beginCopy: jest.fn(async () => { throw new Error('fail') }),
        }),
      })
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.syncQueue.queueChange).not.toHaveBeenCalled()
    })
  })

  // -- File cleanup -----------------------------------------------------------

  describe('file cleanup', () => {
    it('cleans up destination file when DB write fails (Case C)', async () => {
      const deps = createMockDeps({
        db: createMockDb({
          upsertBook: jest.fn(() => { throw new Error('db failed') }),
        }),
      })
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.files.deleteFile).toHaveBeenCalledWith(
        expect.stringContaining('generated-id-1'),
      )
    })

    it('cleans up destination file when DB restore fails (Case A)', async () => {
      const archivedBook = createMockBook({ id: 'archived-1', uri: null })
      const deps = createMockDeps({
        db: createMockDb({
          getBookByFingerprint: jest.fn(() => archivedBook),
          restoreBook: jest.fn(() => { throw new Error('restore failed') }),
        }),
      })
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.files.deleteFile).toHaveBeenCalledWith(
        expect.stringContaining('archived-1'),
      )
    })

    it('no file cleanup needed when beginCopy fails', async () => {
      const deps = createMockDeps({
        copier: createMockCopier({
          beginCopy: jest.fn(async () => { throw new Error('open failed') }),
        }),
      })
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.files.deleteFile).not.toHaveBeenCalled()
    })

    it('no file cleanup needed for active duplicates (Case B)', async () => {
      const activeBook = createMockBook({ id: 'active-1', uri: 'file:///audio/active-1.mp3' })
      const deps = createMockDeps({
        db: createMockDb({
          getBookByFingerprint: jest.fn(() => activeBook),
          getBookById: jest.fn(() => activeBook),
        }),
      })
      const loadFile = createLoadFile(deps)

      await loadFile(INPUT)

      expect(deps.files.deleteFile).not.toHaveBeenCalled()
    })
  })
})
