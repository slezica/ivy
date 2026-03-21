import type { TranscriptionQueueService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'


export interface StopTranscriptionDeps {
  transcription: TranscriptionQueueService
  set: SetState
}

export type StopTranscription = Action<[]>

export const createStopTranscription: ActionFactory<StopTranscriptionDeps, StopTranscription> = (deps) => (
  async () => {
    deps.transcription.stop()
    deps.set(state => {
      state.transcription.status = 'off'
      state.transcription.pending = {}
    })
  }
)
