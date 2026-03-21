import type { TranscriptionQueueService } from '../services'
import type { Action, ActionFactory } from '../store/types'


export interface StartTranscriptionDeps {
  transcription: TranscriptionQueueService
}

export type StartTranscription = Action<[]>

const MAX_ATTEMPTS = 3
const RETRY_DELAYS = [5_000, 15_000, 30_000]

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const createStartTranscription: ActionFactory<StartTranscriptionDeps, StartTranscription> = (deps) => (
  async () => {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      try {
        await deps.transcription.start()
        return
      } catch (error) {
        if (attempt < MAX_ATTEMPTS - 1) {
          await sleep(RETRY_DELAYS[attempt])
        }
      }
    }
  }
)
