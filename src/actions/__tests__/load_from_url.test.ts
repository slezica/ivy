import { createLoadFromUrl, LoadFromUrlDeps } from '../load_from_url'
import {
  createMockBook, createMockState, createImmerSet, createMockGet,
  createMockDb, createMockFiles, createMockMetadata, createMockChapterReader, createMockSyncQueue, createMockDownloader,
} from './helpers'

// Mock generateId to return predictable values
jest.mock('../../utils', () => ({
  generateId: () => 'generated-id-1',
  createLogger: () => () => {},
}))

// Mock react-native-fs
jest.mock('react-native-fs', () => ({
  CachesDirectoryPath: '/cache',
  mkdir: jest.fn(async () => {}),
  moveFile: jest.fn(async () => {}),
  unlink: jest.fn(async () => {}),
}))

// eslint-disable-next-line import/first
import RNFS from 'react-native-fs'


// -- Helpers ------------------------------------------------------------------

function createMockDeps(overrides: Partial<LoadFromUrlDeps> = {}): LoadFromUrlDeps {
  const state = createMockState()

  return {
    db: createMockDb({
      getBookByUri: jest.fn((uri: string) => {
        if (uri.includes('generated-id-1') || uri.includes('archived-1')) {
          return createMockBook({ uri })
        }
        return null
      }),
      upsertBook: jest.fn(() => createMockBook({ id: 'generated-id-1' })),
    }),
    files: createMockFiles(),
    downloader: createMockDownloader(),
    metadata: createMockMetadata(),
    chapters: createMockChapterReader(),
    syncQueue: createMockSyncQueue(),
    set: createImmerSet(state),
    get: createMockGet(state),
    fetchBooks: jest.fn(async () => {}),
    fetchClips: jest.fn(async () => {}),
    cleanupOrphanedFiles: jest.fn(async () => {}),
    ...overrides,
  }
}

const URL = 'https://example.com/podcast.mp3'


// -- Tests --------------------------------------------------------------------

describe('createLoadFromUrl', () => {

  beforeEach(() => {
    jest.clearAllMocks()
  })

  // -- Pipeline ---------------------------------------------------------------

  describe('pipeline', () => {
    it('sets library status to adding, then back to idle', async () => {
      const state = createMockState()
      const deps = createMockDeps({ set: createImmerSet(state), get: createMockGet(state) })
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(state.library.status).toBe('idle')
    })

    it('sets downloader status to downloading, then back to idle', async () => {
      const state = createMockState()
      const deps = createMockDeps({ set: createImmerSet(state), get: createMockGet(state) })
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(state.downloader.status).toBe('idle')
    })

    it('bails if downloader is not idle', async () => {
      const state = createMockState({ downloader: { status: 'downloading' } })
      const deps = createMockDeps({ set: createImmerSet(state), get: createMockGet(state) })
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(deps.downloader.download).not.toHaveBeenCalled()
    })

    it('downloads to temp directory', async () => {
      const deps = createMockDeps()
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(deps.downloader.download).toHaveBeenCalledWith(
        URL,
        '/cache/downloads',
        expect.any(Function),
      )
    })

    it('reads fingerprint from downloaded file', async () => {
      const deps = createMockDeps()
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(deps.files.readFileFingerprint).toHaveBeenCalledWith('file:///cache/downloads/downloaded.mp3')
    })

    it('checks for existing book by fingerprint', async () => {
      const deps = createMockDeps()
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(deps.db.getBookByFingerprint).toHaveBeenCalledWith(1024, new Uint8Array([1, 2, 3]))
    })

    it('refreshes books and clips after completion', async () => {
      const deps = createMockDeps()
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(deps.fetchBooks).toHaveBeenCalled()
      expect(deps.fetchClips).toHaveBeenCalled()
    })
  })

  // -- New book ---------------------------------------------------------------

  describe('new book (no fingerprint match)', () => {
    it('moves downloaded file to app storage', async () => {
      const deps = createMockDeps()
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(RNFS.moveFile).toHaveBeenCalledWith(
        '/cache/downloads/downloaded.mp3',
        expect.stringContaining('generated-id-1'),
      )
    })

    it('reads metadata from the moved file', async () => {
      const deps = createMockDeps()
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(deps.metadata.readMetadata).toHaveBeenCalledWith(
        expect.stringContaining('generated-id-1'),
      )
    })

    it('creates book record with correct fields', async () => {
      const deps = createMockDeps()
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(deps.db.upsertBook).toHaveBeenCalledWith(
        'generated-id-1',
        expect.stringContaining('generated-id-1'),
        'downloaded.mp3',
        60000,
        0,
        'Test Title',
        'Test Artist',
        'data:image/png;base64,abc',
        1024,
        new Uint8Array([1, 2, 3]),
        [],
      )
    })

    it('queues sync upsert for the new book', async () => {
      const deps = createMockDeps()
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(deps.syncQueue.queueChange).toHaveBeenCalledWith('book', 'generated-id-1', 'upsert')
    })
  })

  // -- Archived book restore --------------------------------------------------

  describe('archived book restore (fingerprint match, uri null)', () => {
    function depsWithArchivedBook(bookOverrides: Partial<Parameters<typeof createMockBook>[0]> = {}) {
      const archivedBook = createMockBook({ id: 'archived-1', uri: null, ...bookOverrides })
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

    it('moves file with existing book ID as filename', async () => {
      const deps = depsWithArchivedBook()
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(RNFS.moveFile).toHaveBeenCalledWith(
        '/cache/downloads/downloaded.mp3',
        expect.stringContaining('archived-1'),
      )
    })

    it('restores the book with correct fields', async () => {
      const deps = depsWithArchivedBook()
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(deps.db.restoreBook).toHaveBeenCalledWith(
        'archived-1',
        expect.stringContaining('archived-1'),
        'downloaded.mp3',
        60000,
        'Test Title',
        'Test Artist',
        'data:image/png;base64,abc',
        1024,
        new Uint8Array([1, 2, 3]),
        [],
      )
    })

    it('preserves existing metadata over ID3 tags on restore', async () => {
      const deps = depsWithArchivedBook({
        title: 'User-Edited Title',
        artist: 'User-Edited Artist',
        artwork: 'data:image/png;base64,user-edited',
      })
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(deps.db.restoreBook).toHaveBeenCalledWith(
        'archived-1',
        expect.stringContaining('archived-1'),
        'downloaded.mp3',
        60000,
        'User-Edited Title',
        'User-Edited Artist',
        'data:image/png;base64,user-edited',
        1024,
        new Uint8Array([1, 2, 3]),
        [],
      )
    })

    it('queues sync upsert for the restored book', async () => {
      const deps = depsWithArchivedBook()
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(deps.syncQueue.queueChange).toHaveBeenCalledWith('book', 'archived-1', 'upsert')
    })

    it('does not create a new book or touch existing', async () => {
      const deps = depsWithArchivedBook()
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(deps.db.upsertBook).not.toHaveBeenCalled()
      expect(deps.db.touchBook).not.toHaveBeenCalled()
    })
  })

  // -- Active duplicate -------------------------------------------------------

  describe('active duplicate (fingerprint match, uri set)', () => {
    function depsWithActiveBook() {
      const activeBook = createMockBook({ id: 'active-1', uri: 'file:///audio/active-1.mp3' })
      return createMockDeps({
        db: createMockDb({
          getBookByFingerprint: jest.fn(() => activeBook),
        }),
      })
    }

    it('cleans up downloaded file', async () => {
      const deps = depsWithActiveBook()
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(RNFS.unlink).toHaveBeenCalledWith('/cache/downloads/downloaded.mp3')
    })

    it('does not move file to app storage', async () => {
      const deps = depsWithActiveBook()
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(RNFS.moveFile).not.toHaveBeenCalled()
    })

    it('touches the existing book to update timestamp', async () => {
      const deps = depsWithActiveBook()
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(deps.db.touchBook).toHaveBeenCalledWith('active-1')
    })

    it('queues sync upsert for the existing book', async () => {
      const deps = depsWithActiveBook()
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(deps.syncQueue.queueChange).toHaveBeenCalledWith('book', 'active-1', 'upsert')
    })

    it('sets library status to duplicate', async () => {
      const state = createMockState()
      const deps = depsWithActiveBook()
      deps.set = createImmerSet(state)
      deps.get = createMockGet(state)
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(state.library.status).toBe('duplicate')
    })

    it('does not restore or create', async () => {
      const deps = depsWithActiveBook()
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(deps.db.restoreBook).not.toHaveBeenCalled()
      expect(deps.db.upsertBook).not.toHaveBeenCalled()
    })
  })

  // -- Error handling ---------------------------------------------------------

  describe('error handling', () => {
    it('sets library status to error on failure', async () => {
      const state = createMockState()
      const deps = createMockDeps({
        downloader: createMockDownloader({
          download: jest.fn(async () => { throw new Error('download failed') }),
        }),
        set: createImmerSet(state),
        get: createMockGet(state),
      })
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(state.library.status).toBe('error')
    })

    it('resets downloader status to idle on failure', async () => {
      const state = createMockState()
      const deps = createMockDeps({
        downloader: createMockDownloader({
          download: jest.fn(async () => { throw new Error('download failed') }),
        }),
        set: createImmerSet(state),
        get: createMockGet(state),
      })
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(state.downloader.status).toBe('idle')
    })

    it('does not throw — error is surfaced in UI', async () => {
      const deps = createMockDeps({
        metadata: createMockMetadata({
          readMetadata: jest.fn(async () => { throw new Error('metadata failed') }),
        }),
      })
      const loadFromUrl = createLoadFromUrl(deps)

      await expect(loadFromUrl(URL)).resolves.toBeUndefined()
    })

    it('does not queue sync on failure', async () => {
      const deps = createMockDeps({
        downloader: createMockDownloader({
          download: jest.fn(async () => { throw new Error('fail') }),
        }),
      })
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(deps.syncQueue.queueChange).not.toHaveBeenCalled()
    })
  })

  // -- Cancellation -----------------------------------------------------------

  describe('cancellation', () => {
    function createCancellationError() {
      const error = new Error('Operation cancelled')
      ;(error as any).code = 'CANCELLED'
      return error
    }

    it('resolves silently on cancellation', async () => {
      const deps = createMockDeps({
        downloader: createMockDownloader({
          download: jest.fn(async () => { throw createCancellationError() }),
        }),
      })
      const loadFromUrl = createLoadFromUrl(deps)

      await expect(loadFromUrl(URL)).resolves.toBeUndefined()
    })

    it('does not set error status on cancellation', async () => {
      const state = createMockState()
      const deps = createMockDeps({
        downloader: createMockDownloader({
          download: jest.fn(async () => { throw createCancellationError() }),
        }),
        set: createImmerSet(state),
        get: createMockGet(state),
      })
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(state.library.status).not.toBe('error')
    })
  })

  // -- File cleanup -----------------------------------------------------------

  describe('file cleanup', () => {
    it('cleans up downloaded file when download fails', async () => {
      // Download succeeds but fingerprint read fails — downloadedPath should be cleaned
      const deps = createMockDeps({
        files: createMockFiles({
          readFileFingerprint: jest.fn(async () => { throw new Error('read failed') }),
        }),
      })
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(RNFS.unlink).toHaveBeenCalledWith('/cache/downloads/downloaded.mp3')
    })

    it('no file cleanup when download itself fails', async () => {
      const deps = createMockDeps({
        downloader: createMockDownloader({
          download: jest.fn(async () => { throw new Error('network error') }),
        }),
      })
      const loadFromUrl = createLoadFromUrl(deps)

      await loadFromUrl(URL)

      expect(RNFS.unlink).not.toHaveBeenCalled()
    })
  })
})
