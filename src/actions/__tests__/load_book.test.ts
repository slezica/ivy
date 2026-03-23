import { createLoadBook, LoadBookDeps } from '../load_book'
import {
  createMockBook, createMockPlayback, createMockState, createImmerSet, createMockGet,
  createMockAudio, createMockDb,
} from './helpers'


// -- Helpers ------------------------------------------------------------------

function createStatefulDeps(playback?: Parameters<typeof createMockPlayback>[0], overrides?: Partial<LoadBookDeps>) {
  const state = createMockState({ playback })
  const deps: LoadBookDeps = {
    audio: createMockAudio(),
    db: createMockDb(),
    set: createImmerSet(state),
    get: createMockGet(state),
    ...overrides,
  }
  return { state, deps }
}

const CONTEXT = { fileUri: 'file:///audio/book-1.mp3', position: 5000, ownerId: 'main' }


// -- Tests --------------------------------------------------------------------

describe('createLoadBook', () => {

  // -- New file ---------------------------------------------------------------

  describe('new file', () => {
    it('looks up book record by URI', async () => {
      const { deps } = createStatefulDeps({ uri: null })
      const loadBook = createLoadBook(deps)

      await loadBook(CONTEXT)

      expect(deps.db.getBookByAnyUri).toHaveBeenCalledWith(CONTEXT.fileUri)
    })

    it('throws if no book record found', async () => {
      const { deps } = createStatefulDeps({ uri: null }, {
        db: createMockDb({ getBookByAnyUri: jest.fn(() => null) }),
      })
      const loadBook = createLoadBook(deps)

      await expect(loadBook(CONTEXT)).rejects.toThrow('No book or clip found for')
    })

    it('sets status to loading with ownership before audio.load', async () => {
      const { deps } = createStatefulDeps({ uri: null })
      const loadBook = createLoadBook(deps)

      await loadBook(CONTEXT)

      const firstUpdater = (deps.set as jest.Mock).mock.calls[0][0]
      const draft = createMockState()
      firstUpdater(draft)
      expect(draft.playback.status).toBe('loading')
      expect(draft.playback.ownerId).toBe('main')
    })

    it('clears playback uri before loading to prevent stale position writes', async () => {
      const { state, deps } = createStatefulDeps({
        uri: 'file:///audio/old-book.mp3',
        position: 30000,
        duration: 60000,
        ownerId: 'main',
      })
      const loadBook = createLoadBook(deps)

      await loadBook(CONTEXT)

      // The first set() call (before audio.load) must clear uri
      const firstUpdater = (deps.set as jest.Mock).mock.calls[0][0]
      const draft = createMockState({ playback: { uri: 'file:///audio/old-book.mp3' } })
      firstUpdater(draft)
      expect(draft.playback.uri).toBeNull()
    })

    it('loads audio with book metadata', async () => {
      const book = createMockBook({ title: 'My Book', artist: 'Author', artwork: 'art-data' })
      const { deps } = createStatefulDeps({ uri: null }, {
        db: createMockDb({ getBookByAnyUri: jest.fn(() => book) }),
      })
      const loadBook = createLoadBook(deps)

      await loadBook(CONTEXT)

      expect(deps.audio.load).toHaveBeenCalledWith(CONTEXT.fileUri, {
        title: 'My Book',
        artist: 'Author',
        artwork: 'art-data',
      })
    })

    it('updates playback state with uri, duration, position, and paused status', async () => {
      const { state, deps } = createStatefulDeps({ uri: null }, {
        audio: createMockAudio({ load: jest.fn(async () => 90000) }),
      })
      const loadBook = createLoadBook(deps)

      await loadBook(CONTEXT)

      expect(state.playback.uri).toBe(CONTEXT.fileUri)
      expect(state.playback.duration).toBe(90000)
      expect(state.playback.position).toBe(CONTEXT.position)
      expect(state.playback.status).toBe('paused')
    })

    it('seeks to the requested position', async () => {
      const { deps } = createStatefulDeps({ uri: null })
      const loadBook = createLoadBook(deps)

      await loadBook(CONTEXT)

      expect(deps.audio.seek).toHaveBeenCalledWith(CONTEXT.position)
    })

    it('sets ownerId', async () => {
      const { state, deps } = createStatefulDeps({ uri: null, ownerId: 'old-owner' })
      const loadBook = createLoadBook(deps)

      await loadBook({ ...CONTEXT, ownerId: 'new-owner' })

      expect(state.playback.ownerId).toBe('new-owner')
    })
  })

  // -- Same file, different position ------------------------------------------

  describe('same file, different position', () => {
    it('seeks to new position without reloading', async () => {
      const { deps } = createStatefulDeps({ uri: CONTEXT.fileUri, position: 0, duration: 60000 })
      const loadBook = createLoadBook(deps)

      await loadBook(CONTEXT)

      expect(deps.audio.load).not.toHaveBeenCalled()
      expect(deps.audio.seek).toHaveBeenCalledWith(CONTEXT.position)
    })

    it('updates position and ownerId in state', async () => {
      const { state, deps } = createStatefulDeps({ uri: CONTEXT.fileUri, position: 0, duration: 60000, ownerId: 'old' })
      const loadBook = createLoadBook(deps)

      await loadBook(CONTEXT)

      expect(state.playback.position).toBe(CONTEXT.position)
      expect(state.playback.ownerId).toBe(CONTEXT.ownerId)
    })
  })

  // -- Same file, same position -----------------------------------------------

  describe('same file, same position', () => {
    it('does not seek or load', async () => {
      const { deps } = createStatefulDeps({ uri: CONTEXT.fileUri, position: CONTEXT.position, duration: 60000 })
      const loadBook = createLoadBook(deps)

      await loadBook(CONTEXT)

      expect(deps.audio.load).not.toHaveBeenCalled()
      expect(deps.audio.seek).not.toHaveBeenCalled()
    })

    it('still sets ownerId', async () => {
      const { state, deps } = createStatefulDeps({ uri: CONTEXT.fileUri, position: CONTEXT.position, duration: 60000, ownerId: 'old' })
      const loadBook = createLoadBook(deps)

      await loadBook({ ...CONTEXT, ownerId: 'new-owner' })

      expect(state.playback.ownerId).toBe('new-owner')
    })
  })
})
