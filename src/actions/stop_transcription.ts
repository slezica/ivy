import type { TranscriptionQueueService } from '../services'
import type { SetState, Action, ActionFactory } from '../store/types'


export interface StopTranscriptionDeps {
  transcription: TranscriptionQueueService
  set: SetState
}

export type StopTranscription = Action<[]>

export const createStopTranscription: ActionFactory<StopTranscriptionDeps, StopTranscription> = (deps) => (
  async () => {
    const { transcription, set } = deps

    transcription.stop()
    set(state => {
      state.transcription.pending = {}
    })
  }
)
