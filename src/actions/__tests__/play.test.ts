import { createPlay, PlayDeps } from '../play'
import {
  createMockPlayback, createMockState, createImmerSet, createMockGet,
  createMockAudio,
} from './helpers'


// -- Helpers ------------------------------------------------------------------

function createStatefulDeps(playback?: Parameters<typeof createMockPlayback>[0], overrides?: Partial<PlayDeps>) {
  const state = createMockState({ playback })
  const deps: PlayDeps = {
    audio: createMockAudio(),
    set: createImmerSet(state),
    get: createMockGet(state),
    loadBook: jest.fn(async () => {}),
    ...overrides,
  }
  return { state, deps }
}

const CONTEXT = { fileUri: 'file:///audio/book-1.mp3', position: 5000, ownerId: 'main' }


// -- Tests --------------------------------------------------------------------

describe('createPlay', () => {

  it('calls loadBook with the context', async () => {
    const { deps } = createStatefulDeps()
    const play = createPlay(deps)

    await play(CONTEXT)

    expect(deps.loadBook).toHaveBeenCalledWith(CONTEXT)
  })

  it('sets status to playing and calls audio.play', async () => {
    const { state, deps } = createStatefulDeps()
    const play = createPlay(deps)

    await play(CONTEXT)

    expect(state.playback.status).toBe('playing')
    expect(state.playback.ownerId).toBe('main')
    expect(deps.audio.play).toHaveBeenCalled()
  })

  it('calls audio.play after loadBook', async () => {
    const callOrder: string[] = []
    const { deps } = createStatefulDeps({}, {
      loadBook: jest.fn(async () => { callOrder.push('loadBook') }),
      audio: createMockAudio({ play: jest.fn(async () => { callOrder.push('audio.play') }) }),
    })
    const play = createPlay(deps)

    await play(CONTEXT)

    expect(callOrder).toEqual(['loadBook', 'audio.play'])
  })

  // -- Error handling ---------------------------------------------------------

  describe('error handling', () => {
    it('sets status to paused when a file was loaded', async () => {
      const { state, deps } = createStatefulDeps({ uri: CONTEXT.fileUri }, {
        audio: createMockAudio({ play: jest.fn(async () => { throw new Error('play failed') }) }),
      })
      const play = createPlay(deps)

      await expect(play(CONTEXT)).rejects.toThrow('play failed')

      expect(state.playback.status).toBe('paused')
    })

    it('sets status to idle when no file was loaded', async () => {
      const { state, deps } = createStatefulDeps({ uri: null }, {
        loadBook: jest.fn(async () => { throw new Error('load failed') }),
      })
      const play = createPlay(deps)

      await expect(play(CONTEXT)).rejects.toThrow('load failed')

      expect(state.playback.status).toBe('idle')
    })

    it('re-throws the original error', async () => {
      const { deps } = createStatefulDeps({}, {
        loadBook: jest.fn(async () => { throw new Error('boom') }),
      })
      const play = createPlay(deps)

      await expect(play(CONTEXT)).rejects.toThrow('boom')
    })
  })
})
