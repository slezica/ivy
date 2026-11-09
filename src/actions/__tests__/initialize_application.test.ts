import { createInitializeApplication, InitializeApplicationDeps } from '../initialize_application'
import { createMockState, createImmerSet, createMockDb, createMockArtworkStore } from './helpers'


// -- Helpers ------------------------------------------------------------------

function createDeps(overrides: Partial<InitializeApplicationDeps> = {}) {
  const state = createMockState() as any

  const deps: InitializeApplicationDeps = {
    db: createMockDb({
      getLastPlayedBook: jest.fn(() => null),
      getSettings: jest.fn(() => ({ sync_enabled: false, transcription_enabled: false })),
      getArtworkFiles: jest.fn(async () => []),
    }),
    artworkStore: createMockArtworkStore(),
    slicer: { warmUp: jest.fn(async () => {}) } as any,
    network: { start: jest.fn() } as any,
    toast: jest.fn(),
    set: createImmerSet(state),
    runMigrations: jest.fn(async () => {}),
    fetchBooks: jest.fn(async () => {}),
    fetchClips: jest.fn(async () => {}),
    fetchSessions: jest.fn(async () => {}),
    loadBook: jest.fn(async () => {}),
    startTranscription: jest.fn(async () => {}),
    seedDemoData: jest.fn(async () => false),
    ...overrides,
  }

  return { state, deps }
}


// -- Tests --------------------------------------------------------------------

describe('createInitializeApplication', () => {

  it('hydrates the store and sets initialized', async () => {
    const { state, deps } = createDeps()
    const initializeApplication = createInitializeApplication(deps)

    await initializeApplication()

    expect(deps.fetchBooks).toHaveBeenCalled()
    expect(deps.fetchClips).toHaveBeenCalled()
    expect(deps.fetchSessions).toHaveBeenCalled()
    expect(deps.slicer.warmUp).toHaveBeenCalled()  // FFmpeg warmed in background
    expect(state.initialized).toBe(true)
  })

  it('sets initialized even when hydration fails', async () => {
    const { state, deps } = createDeps({
      fetchBooks: jest.fn(async () => { throw new Error('db exploded') }),
    })
    const initializeApplication = createInitializeApplication(deps)

    await expect(initializeApplication()).resolves.toBeUndefined()
    expect(state.initialized).toBe(true)
  })

  it('surfaces a migration failure to the user', async () => {
    // A swallowed migration failure must not be silent: the session runs
    // un-hydrated (default settings — a Settings toggle would clobber the
    // stored values) and the user sees no sign anything is wrong. The splash
    // must still dismiss, but the failure needs a user-visible signal.
    const { state, deps } = createDeps({
      runMigrations: jest.fn(async () => { throw new Error('migration 13 failed') }),
    })
    const initializeApplication = createInitializeApplication(deps)

    await initializeApplication()

    expect(state.initialized).toBe(true)   // never a permanent splash
    expect(deps.toast).toHaveBeenCalled()  // but never silent either
  })

  it('auto-loads the last played book when available', async () => {
    const { deps } = createDeps({
      db: createMockDb({
        getLastPlayedBook: jest.fn(() => ({ uri: 'file:///audio/book-1.mp3', position: 5000 })),
        getSettings: jest.fn(() => ({ sync_enabled: false, transcription_enabled: false })),
      }),
    })
    const initializeApplication = createInitializeApplication(deps)

    await initializeApplication()

    expect(deps.loadBook).toHaveBeenCalledWith(
      expect.objectContaining({ fileUri: 'file:///audio/book-1.mp3', position: 5000 })
    )
  })

  it('sets initialized even when auto-load fails', async () => {
    const { state, deps } = createDeps({
      db: createMockDb({
        getLastPlayedBook: jest.fn(() => ({ uri: 'file:///audio/book-1.mp3', position: 5000 })),
        getSettings: jest.fn(() => ({ sync_enabled: false, transcription_enabled: false })),
      }),
      loadBook: jest.fn(async () => { throw new Error('load failed') }),
    })
    const initializeApplication = createInitializeApplication(deps)

    await initializeApplication()

    expect(state.initialized).toBe(true)
  })

  it('starts transcription when enabled', async () => {
    const { deps } = createDeps({
      db: createMockDb({
        getLastPlayedBook: jest.fn(() => null),
        getSettings: jest.fn(() => ({ sync_enabled: false, transcription_enabled: true })),
      }),
    })
    const initializeApplication = createInitializeApplication(deps)

    await initializeApplication()

    expect(deps.startTranscription).toHaveBeenCalled()
  })

  it('does not start transcription when disabled', async () => {
    const { deps } = createDeps()
    const initializeApplication = createInitializeApplication(deps)

    await initializeApplication()

    expect(deps.startTranscription).not.toHaveBeenCalled()
  })

  it('seeds demo data before hydrating', async () => {
    const calls: string[] = []
    const { deps } = createDeps({
      seedDemoData: jest.fn(async () => { calls.push('seed'); return true }),
      fetchBooks: jest.fn(async () => { calls.push('fetchBooks') }),
    })
    const initializeApplication = createInitializeApplication(deps)

    await initializeApplication()

    expect(calls[0]).toBe('seed')
    expect(calls).toContain('fetchBooks')
  })

  it('initializes normally when seeding fails', async () => {
    const { state, deps } = createDeps({
      seedDemoData: jest.fn(async () => { throw new Error('bad seed') }),
    })
    const initializeApplication = createInitializeApplication(deps)

    await initializeApplication()

    expect(deps.fetchBooks).toHaveBeenCalled()
    expect(state.initialized).toBe(true)
  })

  it('repairs then sweeps covers after all startup writers, before hydrating', async () => {
    const calls: string[] = []
    const referenced = ['book-1.abcd.jpg', 'hidden-book.ef01.png', 'gone.0123.jpg']
    const { deps } = createDeps({
      db: createMockDb({
        getLastPlayedBook: jest.fn(() => ({ uri: 'file:///audio/book-1.mp3', position: 0 })),
        getSettings: jest.fn(() => ({ sync_enabled: false, transcription_enabled: false })),
        getArtworkFiles: jest.fn(async () => referenced),
        clearArtworkFiles: jest.fn(async () => { calls.push('repair') }),
      }),
      artworkStore: createMockArtworkStore({
        missing: jest.fn(async () => ['gone.0123.jpg']),
        sweep: jest.fn(async () => { calls.push('sweep'); return 2 }),
      }),
      runMigrations: jest.fn(async () => { calls.push('migrate') }),
      seedDemoData: jest.fn(async () => { calls.push('seed'); return false }),
      fetchBooks: jest.fn(async () => { calls.push('fetchBooks') }),
      loadBook: jest.fn(async () => { calls.push('loadBook') }),
    })
    const initializeApplication = createInitializeApplication(deps)

    await initializeApplication()

    expect(deps.artworkStore.missing).toHaveBeenCalledWith(referenced)
    expect(deps.db.clearArtworkFiles).toHaveBeenCalledWith(['gone.0123.jpg'])
    expect(deps.artworkStore.sweep).toHaveBeenCalledWith(referenced) // every row counts, hidden included
    expect(calls).toEqual(['migrate', 'seed', 'repair', 'sweep', 'fetchBooks', 'loadBook'])
  })

  it('leaves rows alone when every referenced cover is on disk', async () => {
    const { deps } = createDeps({
      db: createMockDb({
        getLastPlayedBook: jest.fn(() => null),
        getSettings: jest.fn(() => ({ sync_enabled: false, transcription_enabled: false })),
        getArtworkFiles: jest.fn(async () => ['book-1.abcd.jpg']),
        clearArtworkFiles: jest.fn(async () => {}),
      }),
    })
    const initializeApplication = createInitializeApplication(deps)

    await initializeApplication()

    expect(deps.db.clearArtworkFiles).not.toHaveBeenCalled()
    expect(deps.artworkStore.sweep).toHaveBeenCalledWith(['book-1.abcd.jpg'])
  })

  it('still sweeps when the repair fails', async () => {
    const { state, deps } = createDeps({
      artworkStore: createMockArtworkStore({ missing: jest.fn(async () => { throw new Error('EIO') }) }),
    })
    const initializeApplication = createInitializeApplication(deps)

    await initializeApplication()

    expect(deps.artworkStore.sweep).toHaveBeenCalled()
    expect(state.initialized).toBe(true)
  })

  it('initializes normally when the sweep fails', async () => {
    const { state, deps } = createDeps({
      artworkStore: createMockArtworkStore({ sweep: jest.fn(async () => { throw new Error('EIO') }) }),
    })
    const initializeApplication = createInitializeApplication(deps)

    await initializeApplication()

    expect(deps.toast).not.toHaveBeenCalled()
    expect(state.initialized).toBe(true)
  })
})
