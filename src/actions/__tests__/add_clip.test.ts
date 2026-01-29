import { createAddClip, AddClipDeps } from '../add_clip'
import {
  createMockBook, createMockState, createMockGet,
  createMockDb, createMockSyncQueue, createMockSlicer, createMockTranscription,
} from './helpers'

// Stable ID for assertions
jest.mock('../../utils', () => ({
  generateId: () => 'generated-id',
}))


// -- Helpers ------------------------------------------------------------------

function createDeps(overrides: {
  bookId?: string
  bookUri?: string | null
  bookDuration?: number
  db?: any
  slicer?: any
  syncQueue?: any
  transcription?: any
  fetchClips?: jest.Mock
} = {}) {
  const {
    bookId = 'book-1',
    bookUri = 'file:///audio/book-1.mp3',
    bookDuration = 60000,
  } = overrides

  const book = createMockBook({ id: bookId, uri: bookUri, duration: bookDuration })
  const state = createMockState({ books: { [bookId]: book } })

  const deps: AddClipDeps = {
    db: overrides.db ?? createMockDb({
      createClip: jest.fn((_id, _bookId, _uri, _pos, _dur, _note) => ({
        id: 'generated-id',
        bookId: _bookId,
        uri: _uri,
      })),
    }),
    slicer: overrides.slicer ?? createMockSlicer(),
    syncQueue: overrides.syncQueue ?? createMockSyncQueue(),
    transcription: overrides.transcription ?? createMockTranscription(),
    get: createMockGet(state),
    fetchClips: overrides.fetchClips ?? jest.fn(async () => {}),
  }

  return { state, deps }
}


// -- Tests --------------------------------------------------------------------

describe('createAddClip', () => {

  describe('validation', () => {
    it('throws if book does not exist', async () => {
      const state = createMockState({ books: {} })
      const deps: AddClipDeps = {
        db: createMockDb(), slicer: createMockSlicer(),
        syncQueue: createMockSyncQueue(), transcription: createMockTranscription(),
        get: createMockGet(state), fetchClips: jest.fn(),
      }
      const addClip = createAddClip(deps)

      await expect(addClip('nonexistent', 0)).rejects.toThrow('Book not found')
    })

    it('throws if book has been archived (no uri)', async () => {
      const { deps } = createDeps({ bookUri: null })
      const addClip = createAddClip(deps)

      await expect(addClip('book-1', 0)).rejects.toThrow('Book has been archived')
    })
  })

  describe('audio slicing', () => {
    it('slices from the book uri at the given position with default duration', async () => {
      const { deps } = createDeps()
      const addClip = createAddClip(deps)

      await addClip('book-1', 10000)

      expect(deps.slicer.ensureDir).toHaveBeenCalled()
      expect(deps.slicer.slice).toHaveBeenCalledWith({
        sourceUri: 'file:///audio/book-1.mp3',
        startMs: 10000,
        endMs: 30000, // 10000 + 20000 default
        outputPrefix: 'generated-id',
        outputDir: expect.any(String),
      })
    })

    it('caps clip duration to remaining audio length', async () => {
      const { deps } = createDeps({ bookDuration: 15000 })
      const addClip = createAddClip(deps)

      await addClip('book-1', 10000)

      expect(deps.slicer.slice).toHaveBeenCalledWith(
        expect.objectContaining({
          startMs: 10000,
          endMs: 15000, // only 5000ms remaining
        })
      )
    })
  })

  describe('persistence', () => {
    it('creates clip in db with correct args', async () => {
      const slicerUri = 'file:///clips/sliced.mp3'
      const { deps } = createDeps({
        slicer: createMockSlicer({ slice: jest.fn(async () => ({ uri: slicerUri })) }),
      })
      const addClip = createAddClip(deps)

      await addClip('book-1', 10000)

      expect(deps.db.createClip).toHaveBeenCalledWith(
        'generated-id',
        'book-1',
        slicerUri,
        10000,
        20000,
        '' // default empty note
      )
    })

    it('queues clip for sync', async () => {
      const { deps } = createDeps()
      const addClip = createAddClip(deps)

      await addClip('book-1', 5000)

      expect(deps.syncQueue.queueChange).toHaveBeenCalledWith('clip', 'generated-id', 'upsert')
    })
  })

  describe('post-creation', () => {
    it('fetches clips to refresh state', async () => {
      const { deps } = createDeps()
      const addClip = createAddClip(deps)

      await addClip('book-1', 0)

      expect(deps.fetchClips).toHaveBeenCalled()
    })

    it('queues clip for transcription', async () => {
      const { deps } = createDeps()
      const addClip = createAddClip(deps)

      await addClip('book-1', 0)

      expect(deps.transcription.queueClip).toHaveBeenCalledWith('generated-id')
    })
  })

  describe('error handling', () => {
    it('does not create db record if slicer fails', async () => {
      const { deps } = createDeps({
        slicer: createMockSlicer({ slice: jest.fn(async () => { throw new Error('slice failed') }) }),
      })
      const addClip = createAddClip(deps)

      await expect(addClip('book-1', 0)).rejects.toThrow('slice failed')
      expect(deps.db.createClip).not.toHaveBeenCalled()
    })

    it('does not queue sync or transcription if db fails', async () => {
      const { deps } = createDeps({
        db: createMockDb({ createClip: jest.fn(() => { throw new Error('db failed') }) }),
      })
      const addClip = createAddClip(deps)

      await expect(addClip('book-1', 0)).rejects.toThrow('db failed')
      expect(deps.syncQueue.queueChange).not.toHaveBeenCalled()
      expect(deps.transcription.queueClip).not.toHaveBeenCalled()
    })
  })
})
