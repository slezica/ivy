import type { TranscriptionQueueService } from '../services'
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

    set(state => { state.transcription.status = 'starting' })

    try {
      await transcription.start()
    } catch {
      log('Failed to start')
      set(state => { state.transcription.status = 'error' })
      return
    }

    // Only transition to 'on' if we weren't stopped while starting
    set(state => {
      if (state.transcription.status === 'starting') {
        state.transcription.status = 'on'
      }
    })

    log('Started')
  }
)
