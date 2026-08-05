import { createReleasePlayback, ReleasePlaybackDeps } from '../release_playback'
import { createMockPlayback, createMockState, createMockGet } from './helpers'


// -- Helpers ------------------------------------------------------------------

const SNAPSHOT = { uri: 'file:///audio/book-a.mp3', position: 12345 }

function createStatefulDeps(playback?: Parameters<typeof createMockPlayback>[0], overrides?: Partial<ReleasePlaybackDeps>) {
  const state = createMockState({ playback })
  const deps: ReleasePlaybackDeps = {
    get: createMockGet(state),
    pause: jest.fn(async () => {}),
    loadBook: jest.fn(async () => {}),
    ...overrides,
  }
  return { state, deps }
}


// -- Tests --------------------------------------------------------------------

describe('createReleasePlayback', () => {
  it('does nothing when the caller does not own playback', async () => {
    const { deps } = createStatefulDeps({ ownerId: 'main', mainContext: SNAPSHOT })
    const releasePlayback = createReleasePlayback(deps)

    await releasePlayback('clip-viewer-1')

    expect(deps.pause).not.toHaveBeenCalled()
    expect(deps.loadBook).not.toHaveBeenCalled()
  })

  it('pauses and returns the main context to the main player', async () => {
    const { deps } = createStatefulDeps({ ownerId: 'clip-viewer-1', mainContext: SNAPSHOT })
    const releasePlayback = createReleasePlayback(deps)

    await releasePlayback('clip-viewer-1')

    expect(deps.pause).toHaveBeenCalled()
    expect(deps.loadBook).toHaveBeenCalledWith({
      fileUri: SNAPSHOT.uri,
      position: SNAPSHOT.position,
      ownerId: 'main',
    })
  })

  it('only pauses when there is no main context to restore', async () => {
    const { deps } = createStatefulDeps({ ownerId: 'clip-viewer-1', mainContext: null })
    const releasePlayback = createReleasePlayback(deps)

    await releasePlayback('clip-viewer-1')

    expect(deps.pause).toHaveBeenCalled()
    expect(deps.loadBook).not.toHaveBeenCalled()
  })

  it('aborts the restore when a new owner claims playback during the pause', async () => {
    const { state, deps } = createStatefulDeps({ ownerId: 'clip-viewer-1', mainContext: SNAPSHOT }, {
      pause: jest.fn(async () => { state.playback.ownerId = 'clip-editor-1' }),
    })
    const releasePlayback = createReleasePlayback(deps)

    await releasePlayback('clip-viewer-1')

    expect(deps.loadBook).not.toHaveBeenCalled()
  })

  it('swallows restore errors (snapshotted book may be gone)', async () => {
    const { deps } = createStatefulDeps({ ownerId: 'clip-viewer-1', mainContext: SNAPSHOT }, {
      loadBook: jest.fn(async () => { throw new Error('No book or clip found') }),
    })
    const releasePlayback = createReleasePlayback(deps)

    await expect(releasePlayback('clip-viewer-1')).resolves.toBeUndefined()
  })
})
