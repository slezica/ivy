import type { TranscriptionQueueService, WhisperService, NetworkService } from '../services'
import { classifyTranscriptionError, transcriptionErrorMessage } from '../services/transcription/errors'
import type { Action, ActionFactory, SetState } from '../store/types'
import { createLogger } from '../utils'


export interface StartTranscriptionDeps {
  transcription: TranscriptionQueueService
  whisper: WhisperService
  network: NetworkService
  set: SetState
}

export interface StartTranscriptionOptions {
  ignoreMetered?: boolean  // Download the model even on a metered connection
}

export type StartTranscription = Action<[options?: StartTranscriptionOptions]>

export const createStartTranscription: ActionFactory<StartTranscriptionDeps, StartTranscription> = (deps) => (
  async (options) => {
    const { transcription, whisper, network, set } = deps
    const log = createLogger('StartTranscription')

    log('Starting')

    set(state => {
      state.transcription.status = 'starting'
      state.transcription.downloadProgress = null
      state.transcription.error = null
      state.transcription.retryAt = null
    })

    // Metered gate: never auto-download the 465MB model on a metered
    // connection — wait for Wi-Fi (a network 'change' listener re-runs this
    // action when an unmetered connection appears). A model already on disk
    // starts regardless of network.
    if (!options?.ignoreMetered && !(await whisper.isModelDownloaded())) {
      const net = await network.fetch()

      if (net.metered) {
        log('Model missing and connection is metered — waiting for Wi-Fi')

        set(state => {
          if (state.transcription.status === 'starting') {
            state.transcription.status = 'waiting-wifi'
          }
        })

        return
      }
    }

    // The whisper 'status' listener may move status to 'downloading' while
    // start() is in flight — both count as "still starting" below
    const starting = (status: string) => status === 'starting' || status === 'downloading'

    try {
      await transcription.start()
    } catch (error) {
      log('Failed to start:', error)

      // Only transition to 'error' if we weren't stopped while starting
      set(state => {
        if (starting(state.transcription.status)) {
          state.transcription.status = 'error'
          state.transcription.downloadProgress = null
          state.transcription.retryAt = null
          state.transcription.error = {
            cause: classifyTranscriptionError(error),
            message: transcriptionErrorMessage(error),
          }
        }
      })

      return
    }

    // Only transition to 'on' if we weren't stopped while starting
    set(state => {
      if (starting(state.transcription.status)) {
        state.transcription.status = 'on'
        state.transcription.downloadProgress = null
        state.transcription.error = null
        state.transcription.retryAt = null
      }
    })

    log('Started')
  }
)
