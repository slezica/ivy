import type { TranscriptionQueueService } from '../services'
import type { TranscriptionQueueEvents } from '../services/transcription/queue'
import type { TranscriptionSlice, SetState, GetState } from './types'
import { createStartTranscription } from '../actions/start_transcription'
import { createStopTranscription } from '../actions/stop_transcription'


export interface TranscriptionSliceDeps {
  transcription: TranscriptionQueueService
}


export function createTranscriptionSlice(deps: TranscriptionSliceDeps) {
  const { transcription } = deps

  return (set: SetState, _get: GetState): TranscriptionSlice => {
    const startTranscription = createStartTranscription({ transcription })
    const stopTranscription = createStopTranscription({ transcription, set })

    transcription.on('queued', onTranscriptionQueued)
    transcription.on('finish', onTranscriptionFinished)
    transcription.on('status', onStatusChange)

    return {
      transcription: {
        status: 'idle',
        pending: {},
      },

      startTranscription,
      stopTranscription,
    }

    function onTranscriptionQueued({ clipId }: TranscriptionQueueEvents['queued']) {
      set(state => {
        state.transcription.pending[clipId] = true
      })
    }

    function onTranscriptionFinished({ clipId, error }: TranscriptionQueueEvents['finish']) {
      if (error) {
        console.error(error)
      }

      set(state => {
        delete state.transcription.pending[clipId]
      })
    }

    function onStatusChange({ status }: TranscriptionQueueEvents['status']) {
      set(state => {
        state.transcription.status = status
      })
    }
  }
}
