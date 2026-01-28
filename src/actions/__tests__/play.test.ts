import { createPlay, PlayDeps } from '../play'
import type { Book } from '../../services'
import type { AppState } from '../../store/types'


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

function createPlaybackState(overrides: Partial<AppState['playback']> = {}): AppState['playback'] {
  return {
    status: 'idle',
    position: 0,
    uri: null,
    duration: 0,
    ownerId: null,
    ...overrides,
  }
}

function createMockDeps(playback?: Partial<AppState['playback']>, overrides?: Partial<PlayDeps>): PlayDeps {
  const state = { playback: createPlaybackState(playback) }

  return {
    audio: {
      play: jest.fn(async () => {}),
      load: jest.fn(async () => 60000),
      seek: jest.fn(async () => {}),
    } as any,
    db: {
      getBookByAnyUri: jest.fn(() => createMockBook()),
    } as any,
    set: jest.fn((updater: any) => {
      if (typeof updater === 'function') updater(state)
    }),
    get: jest.fn(() => state) as any,
    ...overrides,
  }
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
        db: { getBookByAnyUri: jest.fn(() => null) } as any,
      })
      const play = createPlay(deps)

      await expect(play(CONTEXT)).rejects.toThrow('No book or clip found for')
    })

    it('sets status to loading with ownership before audio.load', async () => {
      const playback = createPlaybackState({ uri: null })
      const deps = createMockDeps(undefined, {
        set: jest.fn((updater: any) => {
          if (typeof updater === 'function') updater({ playback })
        }),
        get: jest.fn(() => ({ playback })) as any,
      })
      const play = createPlay(deps)

      await play(CONTEXT)

      // First set call should be loading + ownership
      const firstUpdater = (deps.set as jest.Mock).mock.calls[0][0]
      const draft = { playback: createPlaybackState() }
      firstUpdater(draft)
      expect(draft.playback.status).toBe('loading')
      expect(draft.playback.ownerId).toBe('main')
    })

    it('loads audio with book metadata', async () => {
      const book = createMockBook({ title: 'My Book', artist: 'Author', artwork: 'art-data' })
      const deps = createMockDeps({ uri: null }, {
        db: { getBookByAnyUri: jest.fn(() => book) } as any,
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
      const playback = createPlaybackState({ uri: null })
      const deps = createMockDeps(undefined, {
        audio: {
          play: jest.fn(async () => {}),
          load: jest.fn(async () => 90000),
          seek: jest.fn(async () => {}),
        } as any,
        set: jest.fn((updater: any) => {
          if (typeof updater === 'function') updater({ playback })
        }),
        get: jest.fn(() => ({ playback })) as any,
      })
      const play = createPlay(deps)

      await play(CONTEXT)

      // After load, playback state should reflect the new file
      expect(playback.uri).toBe(CONTEXT.fileUri)
      expect(playback.duration).toBe(90000)
      expect(playback.position).toBe(CONTEXT.position)
    })

    it('seeks to the requested position', async () => {
      const deps = createMockDeps({ uri: null })
      const play = createPlay(deps)

      await play(CONTEXT)

      expect(deps.audio.seek).toHaveBeenCalledWith(CONTEXT.position)
    })

    it('sets status to playing and calls audio.play', async () => {
      const playback = createPlaybackState({ uri: null })
      const deps = createMockDeps(undefined, {
        set: jest.fn((updater: any) => {
          if (typeof updater === 'function') updater({ playback })
        }),
        get: jest.fn(() => ({ playback })) as any,
      })
      const play = createPlay(deps)

      await play(CONTEXT)

      expect(playback.status).toBe('playing')
      expect(playback.ownerId).toBe('main')
      expect(deps.audio.play).toHaveBeenCalled()
    })
  })

  // -- Same file, different position ----------------------------------------

  describe('same file, different position', () => {
    it('seeks to new position without reloading', async () => {
      const deps = createMockDeps({
        uri: CONTEXT.fileUri,
        position: 0,
        duration: 60000,
      })
      const play = createPlay(deps)

      await play(CONTEXT)

      expect(deps.audio.load).not.toHaveBeenCalled()
      expect(deps.audio.seek).toHaveBeenCalledWith(CONTEXT.position)
    })

    it('updates position in state', async () => {
      const playback = createPlaybackState({
        uri: CONTEXT.fileUri,
        position: 0,
        duration: 60000,
      })
      const deps = createMockDeps(undefined, {
        set: jest.fn((updater: any) => {
          if (typeof updater === 'function') updater({ playback })
        }),
        get: jest.fn(() => ({ playback })) as any,
      })
      const play = createPlay(deps)

      await play(CONTEXT)

      expect(playback.position).toBe(CONTEXT.position)
    })

    it('does not look up book record', async () => {
      const deps = createMockDeps({
        uri: CONTEXT.fileUri,
        position: 0,
      })
      const play = createPlay(deps)

      await play(CONTEXT)

      expect(deps.db.getBookByAnyUri).not.toHaveBeenCalled()
    })
  })

  // -- Same file, same position ---------------------------------------------

  describe('same file, same position', () => {
    it('does not seek or load', async () => {
      const deps = createMockDeps({
        uri: CONTEXT.fileUri,
        position: CONTEXT.position,
        duration: 60000,
      })
      const play = createPlay(deps)

      await play(CONTEXT)

      expect(deps.audio.load).not.toHaveBeenCalled()
      expect(deps.audio.seek).not.toHaveBeenCalled()
    })

    it('still sets playing and calls audio.play', async () => {
      const playback = createPlaybackState({
        uri: CONTEXT.fileUri,
        position: CONTEXT.position,
        duration: 60000,
      })
      const deps = createMockDeps(undefined, {
        set: jest.fn((updater: any) => {
          if (typeof updater === 'function') updater({ playback })
        }),
        get: jest.fn(() => ({ playback })) as any,
      })
      const play = createPlay(deps)

      await play(CONTEXT)

      expect(playback.status).toBe('playing')
      expect(deps.audio.play).toHaveBeenCalled()
    })
  })

  // -- Ownership ------------------------------------------------------------

  describe('ownership', () => {
    it('sets ownerId on load (new file)', async () => {
      const playback = createPlaybackState({ uri: null, ownerId: 'old-owner' })
      const deps = createMockDeps(undefined, {
        set: jest.fn((updater: any) => {
          if (typeof updater === 'function') updater({ playback })
        }),
        get: jest.fn(() => ({ playback })) as any,
      })
      const play = createPlay(deps)

      await play({ ...CONTEXT, ownerId: 'new-owner' })

      expect(playback.ownerId).toBe('new-owner')
    })

    it('sets ownerId on play (same file)', async () => {
      const playback = createPlaybackState({
        uri: CONTEXT.fileUri,
        position: CONTEXT.position,
        ownerId: 'old-owner',
      })
      const deps = createMockDeps(undefined, {
        set: jest.fn((updater: any) => {
          if (typeof updater === 'function') updater({ playback })
        }),
        get: jest.fn(() => ({ playback })) as any,
      })
      const play = createPlay(deps)

      await play({ ...CONTEXT, ownerId: 'new-owner' })

      expect(playback.ownerId).toBe('new-owner')
    })
  })

  // -- Error handling -------------------------------------------------------

  describe('error handling', () => {
    it('sets status to paused when a file was loaded', async () => {
      const playback = createPlaybackState({
        uri: CONTEXT.fileUri,
        position: CONTEXT.position,
      })
      const deps = createMockDeps(undefined, {
        audio: {
          play: jest.fn(async () => { throw new Error('play failed') }),
          load: jest.fn(async () => 60000),
          seek: jest.fn(async () => {}),
        } as any,
        set: jest.fn((updater: any) => {
          if (typeof updater === 'function') updater({ playback })
        }),
        get: jest.fn(() => ({ playback })) as any,
      })
      const play = createPlay(deps)

      await expect(play(CONTEXT)).rejects.toThrow('play failed')

      expect(playback.status).toBe('paused')
    })

    it('sets status to idle when no file was loaded', async () => {
      const playback = createPlaybackState({ uri: null })
      const deps = createMockDeps(undefined, {
        audio: {
          play: jest.fn(async () => {}),
          load: jest.fn(async () => { throw new Error('load failed') }),
          seek: jest.fn(async () => {}),
        } as any,
        set: jest.fn((updater: any) => {
          if (typeof updater === 'function') updater({ playback })
        }),
        get: jest.fn(() => ({ playback })) as any,
      })
      const play = createPlay(deps)

      await expect(play(CONTEXT)).rejects.toThrow('load failed')

      expect(playback.status).toBe('idle')
    })

    it('re-throws the original error', async () => {
      const deps = createMockDeps({ uri: null }, {
        db: { getBookByAnyUri: jest.fn(() => null) } as any,
      })
      const play = createPlay(deps)

      await expect(play(CONTEXT)).rejects.toThrow('No book or clip found for')
    })

    it('sets status to paused on resume failure when file was loaded', async () => {
      const playback = createPlaybackState({
        status: 'paused',
        uri: 'file:///audio/book-1.mp3',
      })
      const deps = createMockDeps(undefined, {
        audio: {
          play: jest.fn(async () => { throw new Error('resume failed') }),
          load: jest.fn(async () => 60000),
          seek: jest.fn(async () => {}),
        } as any,
        set: jest.fn((updater: any) => {
          if (typeof updater === 'function') updater({ playback })
        }),
        get: jest.fn(() => ({ playback })) as any,
      })
      const play = createPlay(deps)

      await expect(play()).rejects.toThrow('resume failed')

      expect(playback.status).toBe('paused')
    })
  })
})
