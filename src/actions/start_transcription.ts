import type { TranscriptionQueueService } from '../services'
import { classifyTranscriptionError, transcriptionErrorMessage } from '../services/transcription/errors'
import type { Action, ActionFactory, SetState } from '../store/types'
import { createLogger } from '../utils'


export interface StartTranscriptionDeps {
  transcription: TranscriptionQueueService
  set: SetState
}

export type StartTranscription = Action<[]>

export const createStartTranscription: ActionFactory<StartTranscriptionDeps, StartTranscription> = (deps) => (
  async () => {
    const { transcription, set } = deps
    const log = createLogger('StartTranscription')

    log('Starting')

    set(state => {
      state.transcription.status = 'starting'
      state.transcription.downloadProgress = null
      state.transcription.error = null
      state.transcription.retryAt = null
    })

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
