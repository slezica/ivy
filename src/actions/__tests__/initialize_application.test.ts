import { createInitializeApplication, InitializeApplicationDeps } from '../initialize_application'
import { createMockState, createImmerSet, createMockDb } from './helpers'


// -- Helpers ------------------------------------------------------------------

function createDeps(overrides: Partial<InitializeApplicationDeps> = {}) {
  const state = createMockState() as any

  const deps: InitializeApplicationDeps = {
    db: createMockDb({
      getLastPlayedBook: jest.fn(() => null),
      getSettings: jest.fn(() => ({ sync_enabled: false, transcription_enabled: false })),
    }),
    slicer: { warmUp: jest.fn(async () => {}) } as any,
    set: createImmerSet(state),
    fetchBooks: jest.fn(async () => {}),
    fetchClips: jest.fn(async () => {}),
    fetchSessions: jest.fn(async () => {}),
    loadBook: jest.fn(async () => {}),
    startTranscription: jest.fn(async () => {}),
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
})
