import { createStartTranscription } from '../start_transcription'
import { ModelDownloadError, ModelInitError } from '../../services/transcription/errors'
import { createMockState, createImmerSet } from './helpers'


function createDeps(startImpl: () => Promise<void>, stateOverrides: Parameters<typeof createMockState>[0] = {}) {
  const state = createMockState(stateOverrides)
  const set = createImmerSet(state)
  const transcription = { start: jest.fn(startImpl) } as any

  return { state, set, transcription }
}

describe('startTranscription', () => {
  it('transitions to on when the service starts', async () => {
    const { state, set, transcription } = createDeps(async () => {})

    await createStartTranscription({ transcription, set })()

    expect(state.transcription.status).toBe('on')
    expect(state.transcription.error).toBeNull()
  })

  it('classifies a download failure', async () => {
    const { state, set, transcription } = createDeps(async () => {
      throw new ModelDownloadError(new Error('network down'))
    })

    await createStartTranscription({ transcription, set })()

    expect(state.transcription.status).toBe('error')
    expect(state.transcription.error).toEqual({ cause: 'download-failed', message: 'network down' })
  })

  it('classifies a model init failure', async () => {
    const { state, set, transcription } = createDeps(async () => {
      throw new ModelInitError(new Error('failed to load model'))
    })

    await createStartTranscription({ transcription, set })()

    expect(state.transcription.status).toBe('error')
    expect(state.transcription.error).toEqual({ cause: 'init-failed', message: 'failed to load model' })
  })

  it('classifies anything else as unknown', async () => {
    const { state, set, transcription } = createDeps(async () => {
      throw new Error('what even')
    })

    await createStartTranscription({ transcription, set })()

    expect(state.transcription.error).toEqual({ cause: 'unknown', message: 'what even' })
  })

  it('clears the previous error when starting again', async () => {
    const { state, set, transcription } = createDeps(async () => {
      // Retry in flight: previous error must already be cleared
      expect(state.transcription.error).toBeNull()
      expect(state.transcription.status).toBe('starting')
    }, {
      transcription: { status: 'error', error: { cause: 'download-failed', message: 'network down' } },
    })

    await createStartTranscription({ transcription, set })()

    expect(state.transcription.status).toBe('on')
  })

  it('finishes from downloading status (whisper listener moved it)', async () => {
    const { state, set, transcription } = createDeps(async () => {
      // Simulate the store's whisper 'status' listener firing mid-start
      state.transcription.status = 'downloading'
      state.transcription.downloadProgress = 40
    })

    await createStartTranscription({ transcription, set })()

    expect(state.transcription.status).toBe('on')
    expect(state.transcription.downloadProgress).toBeNull()
  })

  it('does not override a stop that happened while starting', async () => {
    const { state, set, transcription } = createDeps(async () => {
      state.transcription.status = 'off'
      throw new ModelDownloadError(new Error('network down'))
    })

    await createStartTranscription({ transcription, set })()

    expect(state.transcription.status).toBe('off')
    expect(state.transcription.error).toBeNull()
  })
})
