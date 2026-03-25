import type { TranscriptionQueueService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'
import { createLogger } from '../utils'


export interface StopTranscriptionDeps {
  transcription: TranscriptionQueueService
  set: SetState
}

export type StopTranscription = Action<[]>

export const createStopTranscription: ActionFactory<StopTranscriptionDeps, StopTranscription> = (deps) => (
  async () => {
    const { transcription, set } = deps
    const log = createLogger('StopTranscription')

    log('Stopping')

    transcription.stop()
    set(state => {
      state.transcription.status = 'off'
      state.transcription.pending = {}
    })
  }
)
