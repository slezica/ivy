import type { TranscriptionQueueService } from '../services'
import type { Action, ActionFactory } from '../store/types'


export interface StartTranscriptionDeps {
  transcription: TranscriptionQueueService
}

export type StartTranscription = Action<[]>

export const createStartTranscription: ActionFactory<StartTranscriptionDeps, StartTranscription> = (deps) => (
  async () => {
    deps.transcription.start()
  }
)
