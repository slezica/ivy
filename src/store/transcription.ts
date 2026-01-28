import type { TranscriptionQueueService } from '../services'
import type { TranscriptionQueueEvents } from '../services/transcription/queue'
import type { TranscriptionSlice, SetState, GetState } from './types'


export interface TranscriptionSliceDeps {
  transcription: TranscriptionQueueService
}


export function createTranscriptionSlice(deps: TranscriptionSliceDeps) {
  const { transcription } = deps

  return (set: SetState, _get: GetState): TranscriptionSlice => {
    transcription.on('queued', onTranscriptionQueued)
    transcription.on('finish', onTranscriptionFinished)

    return {
      transcribing: {},
    }

    function onTranscriptionQueued({ clipId }: TranscriptionQueueEvents['queued']) {
      set(state => {
        state.transcribing[clipId] = true
      })
    }

    function onTranscriptionFinished({ clipId, error }: TranscriptionQueueEvents['finish']) {
      if (error) {
        console.error(error)
      }

      set(state => {
        delete state.transcribing[clipId]
      })
    }
  }
}
