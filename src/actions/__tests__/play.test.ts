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

  describe('at the end of the track', () => {
    // loadBook is mocked: it would normally have written position/duration
    const atEnd = (position: number, duration = 30_000) =>
      createStatefulDeps({ uri: CONTEXT.fileUri, position, duration })

    it('restarts from the top when the playhead is parked at the end', async () => {
      const { state, deps } = atEnd(29_999)
      const play = createPlay(deps)

      await play({ ...CONTEXT, position: 29_999 })

      expect(deps.audio.seek).toHaveBeenCalledWith(0)
      expect(state.playback.position).toBe(0)
      expect(state.playback.status).toBe('playing')
    })

    it('leaves a playhead short of the end alone', async () => {
      const { state, deps } = atEnd(29_000)
      const play = createPlay(deps)

      await play({ ...CONTEXT, position: 29_000 })

      expect(deps.audio.seek).not.toHaveBeenCalled()
      expect(state.playback.position).toBe(29_000)
    })

    it('ignores an unknown duration', async () => {
      const { deps } = atEnd(0, 0)
      const play = createPlay(deps)

      await play({ ...CONTEXT, position: 0 })

      expect(deps.audio.seek).not.toHaveBeenCalled()
    })
  })

  it('no-ops while another load is in flight', async () => {
    const { state, deps } = createStatefulDeps({ status: 'loading' })
    const play = createPlay(deps)

    await play(CONTEXT)

    expect(deps.loadBook).not.toHaveBeenCalled()
    expect(deps.audio.play).not.toHaveBeenCalled()
    expect(state.playback.status).toBe('loading')
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
