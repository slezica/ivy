import type {
  DatabaseService,
  AudioSlicerService,
  SyncQueueService,
  TranscriptionQueueService,
  SharingService,
  BackupSyncService,
  SyncNotification,
} from '../services'
import type { ClipSlice, SetState, GetState } from './types'
import { TranscriptionQueueEvents } from '../services/transcription/queue'
import { createFetchClips } from '../actions/fetch_clips'
import { createAddClip } from '../actions/add_clip'
import { createUpdateClip } from '../actions/update_clip'
import { createDeleteClip } from '../actions/delete_clip'
import { createShareClip } from '../actions/share_clip'


export interface ClipSliceDeps {
  db: DatabaseService
  slicer: AudioSlicerService
  syncQueue: SyncQueueService
  transcription: TranscriptionQueueService
  sharing: SharingService
  sync: BackupSyncService
}


export function createClipSlice(deps: ClipSliceDeps) {
  const { db, slicer, syncQueue, transcription, sharing, sync } = deps

  return (set: SetState, get: GetState): ClipSlice => {
    const fetchClips = createFetchClips({ db, set })
    const updateClip = createUpdateClip({ db, slicer, syncQueue, transcription, set, get })
    const deleteClip = createDeleteClip({ db, slicer, syncQueue, set, get })
    const shareClip = createShareClip({ sharing, get })
    const addClip = createAddClip({ db, slicer, syncQueue, transcription, get, fetchClips })

    transcription.on('finish', onTranscriptionFinished)
    sync.on('data', onSyncData)

    return {
      clips: {},

      fetchClips,
      addClip,
      updateClip,
      deleteClip,
      shareClip,
    }

    function onTranscriptionFinished({ clipId, transcription }: TranscriptionQueueEvents['finish']) {
      if (transcription) {
        updateClip(clipId, { transcription })
      }
    }

    function onSyncData(notification: SyncNotification) {
      if (notification.clipsChanged.length > 0) {
        fetchClips()
      }
    }
  }
}
