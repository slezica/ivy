import type { TranscriptionQueueService } from '../services'
import type { Action, ActionFactory, SetState } from '../store/types'


export interface StartTranscriptionDeps {
  transcription: TranscriptionQueueService
  set: SetState
}

export type StartTranscription = Action<[]>

export const createStartTranscription: ActionFactory<StartTranscriptionDeps, StartTranscription> = (deps) => (
  async () => {
    deps.set(state => { state.transcription.status = 'starting' })

    try {
      await deps.transcription.start()
    } catch {
      deps.set(state => { state.transcription.status = 'error' })
      return
    }

    // Only transition to 'on' if we weren't stopped while starting
    deps.set(state => {
      if (state.transcription.status === 'starting') {
        state.transcription.status = 'on'
      }
    })
  }
)
