import { createPlay, PlayDeps } from '../play'
import {
  createMockBook, createMockPlayback, createMockState, createImmerSet, createMockGet,
  createMockAudio, createMockDb,
} from './helpers'


// -- Helpers ------------------------------------------------------------------

function createMockDeps(playback?: Parameters<typeof createMockPlayback>[0], overrides?: Partial<PlayDeps>): PlayDeps {
  const state = createMockState({ playback })

  return {
    audio: createMockAudio(),
    db: createMockDb(),
    set: createImmerSet(state),
    get: createMockGet(state),
    ...overrides,
  }
}

/** Create deps with an accessible state object for assertions on mutations. */
function createStatefulDeps(playback?: Parameters<typeof createMockPlayback>[0], overrides?: Partial<PlayDeps>) {
  const state = createMockState({ playback })
  const deps: PlayDeps = {
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

describe('createPlay', () => {

  // -- Resume (no context) --------------------------------------------------

  describe('resume (no context)', () => {
    it('sets status to playing and calls audio.play', async () => {
      const deps = createMockDeps({ status: 'paused', uri: 'file:///audio/book-1.mp3' })
      const play = createPlay(deps)

      await play()

      expect(deps.set).toHaveBeenCalledTimes(1)
      expect(deps.audio.play).toHaveBeenCalled()
    })

    it('does not load, seek, or look up book', async () => {
      const deps = createMockDeps({ status: 'paused', uri: 'file:///audio/book-1.mp3' })
      const play = createPlay(deps)

      await play()

      expect(deps.audio.load).not.toHaveBeenCalled()
      expect(deps.audio.seek).not.toHaveBeenCalled()
      expect(deps.db.getBookByAnyUri).not.toHaveBeenCalled()
    })

    it('does not read current state', async () => {
      const deps = createMockDeps()
      const play = createPlay(deps)

      await play()

      expect(deps.get).not.toHaveBeenCalled()
    })
  })

  // -- New file (different from currently loaded) ---------------------------

  describe('new file', () => {
    it('looks up book record by URI', async () => {
      const deps = createMockDeps({ uri: null })
      const play = createPlay(deps)

      await play(CONTEXT)

      expect(deps.db.getBookByAnyUri).toHaveBeenCalledWith(CONTEXT.fileUri)
    })

    it('throws if no book record found', async () => {
      const deps = createMockDeps({ uri: null }, {
        db: createMockDb({ getBookByAnyUri: jest.fn(() => null) }),
      })
      const play = createPlay(deps)

      await expect(play(CONTEXT)).rejects.toThrow('No book or clip found for')
    })

    it('sets status to loading with ownership before audio.load', async () => {
      const { state, deps } = createStatefulDeps({ uri: null })
      const play = createPlay(deps)

      await play(CONTEXT)

      // Verify loading was set (final state is 'playing', but loading happened during)
      const firstUpdater = (deps.set as jest.Mock).mock.calls[0][0]
      const draft = createMockState()
      firstUpdater(draft)
      expect(draft.playback.status).toBe('loading')
      expect(draft.playback.ownerId).toBe('main')
    })

    it('loads audio with book metadata', async () => {
      const book = createMockBook({ title: 'My Book', artist: 'Author', artwork: 'art-data' })
      const deps = createMockDeps({ uri: null }, {
        db: createMockDb({ getBookByAnyUri: jest.fn(() => book) }),
      })
      const play = createPlay(deps)

      await play(CONTEXT)

      expect(deps.audio.load).toHaveBeenCalledWith(CONTEXT.fileUri, {
        title: 'My Book',
        artist: 'Author',
        artwork: 'art-data',
      })
    })

    it('updates playback state with uri, duration, and position after load', async () => {
      const { state, deps } = createStatefulDeps({ uri: null }, {
        audio: createMockAudio({ load: jest.fn(async () => 90000) }),
      })
      const play = createPlay(deps)

      await play(CONTEXT)

      expect(state.playback.uri).toBe(CONTEXT.fileUri)
      expect(state.playback.duration).toBe(90000)
      expect(state.playback.position).toBe(CONTEXT.position)
    })

    it('seeks to the requested position', async () => {
      const deps = createMockDeps({ uri: null })
      const play = createPlay(deps)

      await play(CONTEXT)

      expect(deps.audio.seek).toHaveBeenCalledWith(CONTEXT.position)
    })

    it('sets status to playing and calls audio.play', async () => {
      const { state, deps } = createStatefulDeps({ uri: null })
      const play = createPlay(deps)

      await play(CONTEXT)

      expect(state.playback.status).toBe('playing')
      expect(state.playback.ownerId).toBe('main')
      expect(deps.audio.play).toHaveBeenCalled()
    })
  })

  // -- Same file, different position ----------------------------------------

  describe('same file, different position', () => {
    it('seeks to new position without reloading', async () => {
      const deps = createMockDeps({ uri: CONTEXT.fileUri, position: 0, duration: 60000 })
      const play = createPlay(deps)

      await play(CONTEXT)

      expect(deps.audio.load).not.toHaveBeenCalled()
      expect(deps.audio.seek).toHaveBeenCalledWith(CONTEXT.position)
    })

    it('updates position in state', async () => {
      const { state, deps } = createStatefulDeps({ uri: CONTEXT.fileUri, position: 0, duration: 60000 })
      const play = createPlay(deps)

      await play(CONTEXT)

      expect(state.playback.position).toBe(CONTEXT.position)
    })

    it('does not look up book record', async () => {
      const deps = createMockDeps({ uri: CONTEXT.fileUri, position: 0 })
      const play = createPlay(deps)

      await play(CONTEXT)

      expect(deps.db.getBookByAnyUri).not.toHaveBeenCalled()
    })
  })

  // -- Same file, same position ---------------------------------------------

  describe('same file, same position', () => {
    it('does not seek or load', async () => {
      const deps = createMockDeps({ uri: CONTEXT.fileUri, position: CONTEXT.position, duration: 60000 })
      const play = createPlay(deps)

      await play(CONTEXT)

      expect(deps.audio.load).not.toHaveBeenCalled()
      expect(deps.audio.seek).not.toHaveBeenCalled()
    })

    it('still sets playing and calls audio.play', async () => {
      const { state, deps } = createStatefulDeps({ uri: CONTEXT.fileUri, position: CONTEXT.position, duration: 60000 })
      const play = createPlay(deps)

      await play(CONTEXT)

      expect(state.playback.status).toBe('playing')
      expect(deps.audio.play).toHaveBeenCalled()
    })
  })

  // -- Ownership ------------------------------------------------------------

  describe('ownership', () => {
    it('sets ownerId on load (new file)', async () => {
      const { state, deps } = createStatefulDeps({ uri: null, ownerId: 'old-owner' })
      const play = createPlay(deps)

      await play({ ...CONTEXT, ownerId: 'new-owner' })

      expect(state.playback.ownerId).toBe('new-owner')
    })

    it('sets ownerId on play (same file)', async () => {
      const { state, deps } = createStatefulDeps({ uri: CONTEXT.fileUri, position: CONTEXT.position, ownerId: 'old-owner' })
      const play = createPlay(deps)

      await play({ ...CONTEXT, ownerId: 'new-owner' })

      expect(state.playback.ownerId).toBe('new-owner')
    })
  })

  // -- Error handling -------------------------------------------------------

  describe('error handling', () => {
    it('sets status to paused when a file was loaded', async () => {
      const { state, deps } = createStatefulDeps({ uri: CONTEXT.fileUri, position: CONTEXT.position }, {
        audio: createMockAudio({ play: jest.fn(async () => { throw new Error('play failed') }) }),
      })
      const play = createPlay(deps)

      await expect(play(CONTEXT)).rejects.toThrow('play failed')

      expect(state.playback.status).toBe('paused')
    })

    it('sets status to idle when no file was loaded', async () => {
      const { state, deps } = createStatefulDeps({ uri: null }, {
        audio: createMockAudio({ load: jest.fn(async () => { throw new Error('load failed') }) }),
      })
      const play = createPlay(deps)

      await expect(play(CONTEXT)).rejects.toThrow('load failed')

      expect(state.playback.status).toBe('idle')
    })

    it('re-throws the original error', async () => {
      const deps = createMockDeps({ uri: null }, {
        db: createMockDb({ getBookByAnyUri: jest.fn(() => null) }),
      })
      const play = createPlay(deps)

      await expect(play(CONTEXT)).rejects.toThrow('No book or clip found for')
    })

    it('sets status to paused on resume failure when file was loaded', async () => {
      const { state, deps } = createStatefulDeps({ status: 'paused', uri: 'file:///audio/book-1.mp3' }, {
        audio: createMockAudio({ play: jest.fn(async () => { throw new Error('resume failed') }) }),
      })
      const play = createPlay(deps)

      await expect(play()).rejects.toThrow('resume failed')

      expect(state.playback.status).toBe('paused')
    })
  })
})
