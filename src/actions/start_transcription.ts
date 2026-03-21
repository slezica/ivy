import type { TranscriptionQueueService } from '../services'
import type { Action, ActionFactory, SetState, GetState } from '../store/types'


export interface StartTranscriptionDeps {
  transcription: TranscriptionQueueService
  set: SetState
  get: GetState
}

export type StartTranscription = Action<[]>

const MAX_ATTEMPTS = 3
const RETRY_DELAYS = [5_000, 15_000, 30_000]

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export const createStartTranscription: ActionFactory<StartTranscriptionDeps, StartTranscription> = (deps) => (
  async () => {
    deps.set(state => { state.transcription.status = 'idle' })

    let lastError: unknown

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (deps.get().transcription.status === 'disabled') return

      try {
        await deps.transcription.start()
        return
      } catch (error) {
        lastError = error
        console.error(`[Transcription] Attempt ${attempt + 1}/${MAX_ATTEMPTS} failed:`, error)

        if (attempt < MAX_ATTEMPTS - 1) {
          await sleep(RETRY_DELAYS[attempt])
        }
      }
    }

    deps.set(state => { state.transcription.status = 'error' })
    throw lastError
  }
)
