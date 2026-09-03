import { createStartTranscription } from '../start_transcription'
import { ModelDownloadError, ModelInitError } from '../../services/transcription/errors'
import { createMockState, createImmerSet } from './helpers'


function createDeps(
  startImpl: () => Promise<void>,
  stateOverrides: Parameters<typeof createMockState>[0] = {},
  opts: { modelDownloaded?: boolean; metered?: boolean } = {},
) {
  const state = createMockState(stateOverrides)
  const set = createImmerSet(state)
  const transcription = { start: jest.fn(startImpl) } as any
  const whisper = { isModelDownloaded: jest.fn(async () => opts.modelDownloaded ?? true) } as any
  const network = { fetch: jest.fn(async () => ({ connected: true, metered: opts.metered ?? false })) } as any

  return { state, set, transcription, whisper, network }
}

describe('startTranscription', () => {
  it('transitions to on when the service starts', async () => {
    const { state, set, transcription, whisper, network } = createDeps(async () => {})

    await createStartTranscription({ transcription, whisper, network, set })()

    expect(state.transcription.status).toBe('on')
    expect(state.transcription.error).toBeNull()
  })

  it('classifies a download failure', async () => {
    const { state, set, transcription, whisper, network } = createDeps(async () => {
      throw new ModelDownloadError(new Error('network down'))
    })

    await createStartTranscription({ transcription, whisper, network, set })()

    expect(state.transcription.status).toBe('error')
    expect(state.transcription.error).toEqual({ cause: 'download-failed', message: 'network down' })
  })

  it('classifies a model init failure', async () => {
    const { state, set, transcription, whisper, network } = createDeps(async () => {
      throw new ModelInitError(new Error('failed to load model'))
    })

    await createStartTranscription({ transcription, whisper, network, set })()

    expect(state.transcription.status).toBe('error')
    expect(state.transcription.error).toEqual({ cause: 'init-failed', message: 'failed to load model' })
  })

  it('classifies anything else as unknown', async () => {
    const { state, set, transcription, whisper, network } = createDeps(async () => {
      throw new Error('what even')
    })

    await createStartTranscription({ transcription, whisper, network, set })()

    expect(state.transcription.error).toEqual({ cause: 'unknown', message: 'what even' })
  })

  it('clears the previous error when starting again', async () => {
    const { state, set, transcription, whisper, network } = createDeps(async () => {
      // Retry in flight: previous error must already be cleared
      expect(state.transcription.error).toBeNull()
      expect(state.transcription.status).toBe('starting')
    }, {
      transcription: { status: 'error', error: { cause: 'download-failed', message: 'network down' } },
    })

    await createStartTranscription({ transcription, whisper, network, set })()

    expect(state.transcription.status).toBe('on')
  })

  it('finishes from downloading status (whisper listener moved it)', async () => {
    const { state, set, transcription, whisper, network } = createDeps(async () => {
      // Simulate the store's whisper 'status' listener firing mid-start
      state.transcription.status = 'downloading'
      state.transcription.downloadProgress = 40
    })

    await createStartTranscription({ transcription, whisper, network, set })()

    expect(state.transcription.status).toBe('on')
    expect(state.transcription.downloadProgress).toBeNull()
  })

  it('waits for wifi when the model is missing and the connection is metered', async () => {
    const { state, set, transcription, whisper, network } = createDeps(
      async () => {}, {}, { modelDownloaded: false, metered: true },
    )

    await createStartTranscription({ transcription, whisper, network, set })()

    expect(state.transcription.status).toBe('waiting-wifi')
    expect(transcription.start).not.toHaveBeenCalled()
  })

  it('downloads on a metered connection when ignoreMetered is passed', async () => {
    const { state, set, transcription, whisper, network } = createDeps(
      async () => {}, {}, { modelDownloaded: false, metered: true },
    )

    await createStartTranscription({ transcription, whisper, network, set })({ ignoreMetered: true })

    expect(state.transcription.status).toBe('on')
    expect(transcription.start).toHaveBeenCalled()
    expect(network.fetch).not.toHaveBeenCalled()
  })

  it('starts on a metered connection when the model is already downloaded', async () => {
    const { state, set, transcription, whisper, network } = createDeps(
      async () => {}, {}, { modelDownloaded: true, metered: true },
    )

    await createStartTranscription({ transcription, whisper, network, set })()

    expect(state.transcription.status).toBe('on')
    expect(transcription.start).toHaveBeenCalled()
  })

  it('lands on error when the model-presence check itself fails', async () => {
    // The metered-gate awaits run outside the try/catch: a rejection here
    // leaves status stuck at 'starting' forever (no banner, no retry path)
    // and the rejection escapes to callers that don't catch (onNetworkChange).
    const { state, set, transcription, whisper, network } = createDeps(
      async () => {}, {}, { modelDownloaded: false },
    )
    whisper.isModelDownloaded = jest.fn(async () => { throw new Error('fs unavailable') })

    await expect(
      createStartTranscription({ transcription, whisper, network, set })()
    ).resolves.toBeUndefined()

    expect(state.transcription.status).toBe('error')
  })

  it('lands on error when the network check itself fails', async () => {
    const { state, set, transcription, whisper, network } = createDeps(
      async () => {}, {}, { modelDownloaded: false },
    )
    network.fetch = jest.fn(async () => { throw new Error('netinfo unavailable') })

    await expect(
      createStartTranscription({ transcription, whisper, network, set })()
    ).resolves.toBeUndefined()

    expect(state.transcription.status).toBe('error')
  })

  it('a manual download-now start ends on despite a concurrent metered check', async () => {
    // Race from the wild: waiting-wifi → Wi-Fi appears (auto-start fires) →
    // user taps "Download now" → Wi-Fi drops before the auto call's network
    // check resolves. The auto call re-enters waiting-wifi while the manual
    // download is running; when the manual start completes, the state must
    // land on 'on' — not stay 'waiting-wifi' through a 465MB download.
    let releaseStart!: () => void
    const startPromise = new Promise<void>(resolve => { releaseStart = resolve })
    const { state, set, transcription, whisper, network } = createDeps(
      () => startPromise, {}, { modelDownloaded: false, metered: true },
    )
    const action = createStartTranscription({ transcription, whisper, network, set })

    const manual = action({ ignoreMetered: true })  // skips the gate, start() in flight
    await action()                                  // auto-start hits the metered gate

    releaseStart()
    await manual

    expect(state.transcription.status).toBe('on')
  })

  it('does not override a stop that happened while starting', async () => {
    const { state, set, transcription, whisper, network } = createDeps(async () => {
      state.transcription.status = 'off'
      throw new ModelDownloadError(new Error('network down'))
    })

    await createStartTranscription({ transcription, whisper, network, set })()

    expect(state.transcription.status).toBe('off')
    expect(state.transcription.error).toBeNull()
  })
})
